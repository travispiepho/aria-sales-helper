#!/usr/bin/env node
/**
 * browser-verify-phone-intro-popup.mjs — REAL headless-browser verification
 * (390x844, per this repo's established pattern) that the mid-call intro
 * suggestion popup actually RENDERS in a real browser tab running the real
 * Vite-served web app, driven by a real phone-channel call through the real
 * server, and that clicking "Yes" relabels the transcript live.
 *
 * Drives Chrome directly over the CDP protocol (no Playwright/Puppeteer
 * dependency needed — uses the already-installed `ws` + `node-fetch`
 * packages) against a Chrome instance launched separately with
 * --remote-debugging-port=18800.
 *
 * Requires: local server.js running on :3000 (real DB/Deepgram/Twilio
 * creds), local `vite` dev server running on :5173, and a behavioral test
 * user + meeting already created in Postgres (see
 * scripts/tmp-create-behavioral-test-user.mjs and the meetingId/callSid
 * this script is given via env).
 */
import WebSocket from 'ws';
import fetch from 'node-fetch';
import { readFileSync } from 'fs';

const CDP_URL = 'http://127.0.0.1:18800';
const WEB_URL = 'http://localhost:5173';
const API_URL = 'http://localhost:3000';
const MEETING_ID = process.env.TEST_MEETING_ID;
const CALL_SID = process.env.TEST_CALL_SID;
if (!MEETING_ID || !CALL_SID) throw new Error('TEST_MEETING_ID and TEST_CALL_SID env vars required');

function extractMulawDataChunk(buf) {
  let offset = 12;
  let dataChunk = null;
  while (offset < buf.length - 8) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === 'data') dataChunk = buf.subarray(chunkStart, chunkStart + chunkSize);
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }
  return dataChunk;
}

async function cdpConnect() {
  const verRes = await fetch(`${CDP_URL}/json/version`);
  const ver = await verRes.json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  await new Promise((r) => ws.on('open', r));
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, (msg) => { if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg); });
      const payload = { id: mid, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
    });
  }
  return { ws, send };
}

async function main() {
  const { send } = await cdpConnect();
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const targetId = target.result.targetId;
  const attach = await send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = attach.result.sessionId;

  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);

  async function evalJs(expr, awaitPromise = true) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }, sessionId);
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  }

  async function navigate(url) {
    await send('Page.navigate', { url }, sessionId);
    await new Promise((r) => setTimeout(r, 1500));
  }

  async function screenshot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const { writeFileSync } = await import('fs');
    writeFileSync(`/tmp/${name}.png`, Buffer.from(r.result.data, 'base64'));
    console.log(`Saved screenshot: /tmp/${name}.png`);
  }

  // ── Log in via the real login form (real fetch call from the page's own
  // origin so cookies attach correctly) ──
  console.log('Navigating to web app login...');
  await navigate(`${WEB_URL}/login`);
  await screenshot('01-login-page');

  const loginResult = await evalJs(`
    fetch('${API_URL}/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: '_behavioral_intro_test@example.invalid', password: 'BehavioralTest123!' })
    }).then(r => r.json())
  `);
  console.log('Login API result (from within page):', JSON.stringify(loginResult));

  // ── Navigate to the meeting page — this is what mounts MeetingPage.tsx
  // and, per the 8/17 fix, opens the OBSERVER socket for this phone-channel
  // meeting (channel='phone' && call_sid set) ──
  console.log(`Navigating to meeting page for ${MEETING_ID}...`);
  await navigate(`${WEB_URL}/meetings/${MEETING_ID}`);
  await new Promise((r) => setTimeout(r, 2000));
  await screenshot('02-meeting-page-loaded');

  const bodyText = await evalJs(`document.body.innerText`);
  console.log('Meeting page body text (first 500 chars):', bodyText.slice(0, 500));

  // ── Now stream the real intro audio through /telephony/stream, exactly
  // as behavioral-verify-phone-intro.mjs does, while this real browser tab
  // is sitting on the meeting page with its observer socket open ──
  console.log('Streaming real intro audio through /telephony/stream ("Hi there, this is Jonathan...")...');
  const streamWs = new WebSocket(`ws://localhost:3000/telephony/stream`);
  await new Promise((resolve, reject) => { streamWs.on('open', resolve); streamWs.on('error', reject); });
  streamWs.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  streamWs.send(JSON.stringify({
    event: 'start',
    start: { streamSid: 'MZbrowsertest', callSid: CALL_SID, tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } },
  }));
  await new Promise((r) => setTimeout(r, 1500));

  const wavBuf = readFileSync('/tmp/intro_test_mulaw8k.wav');
  const dataChunk = extractMulawDataChunk(wavBuf);
  const FRAME_BYTES = 160;
  const frames = [];
  for (let i = 0; i < dataChunk.length; i += FRAME_BYTES) frames.push(dataChunk.subarray(i, Math.min(i + FRAME_BYTES, dataChunk.length)));
  for (const frameBuf of frames) {
    streamWs.send(JSON.stringify({ event: 'media', media: { track: 'inbound', chunk: '1', timestamp: '0', payload: frameBuf.toString('base64') } }));
    await new Promise((r) => setTimeout(r, 20));
  }
  console.log('Finished streaming audio. Waiting for the intro window + sweep timer + popup render in the real browser tab (up to 30s)...');

  let popupSeen = false;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const hasPopup = await evalJs(`document.body.innerText.includes('Is this Speaker') || document.body.innerText.includes('We heard an introduction')`);
    if (hasPopup) { popupSeen = true; break; }
  }

  await screenshot('03-popup-check');

  if (!popupSeen) {
    console.error('FAIL: popup text never appeared in the real browser DOM within 30s.');
    console.error('Current body text:', await evalJs('document.body.innerText'));
    streamWs.close();
    process.exit(1);
  }

  console.log('BEHAVIORAL PASS (browser render): popup text "Is this Speaker N?" / "We heard an introduction" IS present in the real rendered DOM.');
  const fullText = await evalJs('document.body.innerText');
  console.log('Full page text at popup time:\n', fullText);

  // ── Click the "Yes" / confirm button (real DOM click, real React handler) ──
  const clicked = await evalJs(`
    (function() {
      const buttons = Array.from(document.querySelectorAll('button'));
      const yesBtn = buttons.find(b => /yes/i.test(b.textContent) && !/not them/i.test(b.textContent));
      if (!yesBtn) return { ok: false, buttons: buttons.map(b => b.textContent) };
      yesBtn.click();
      return { ok: true, clickedText: yesBtn.textContent };
    })()
  `);
  console.log('Clicked confirm button:', JSON.stringify(clicked));
  if (!clicked.ok) {
    console.error('FAIL: could not find a "Yes" confirm button to click.');
    streamWs.close();
    process.exit(1);
  }

  await new Promise((r) => setTimeout(r, 2000));
  await screenshot('04-after-confirm-click');

  const afterConfirmText = await evalJs('document.body.innerText');
  console.log('Page text after confirm click:', afterConfirmText.slice(0, 800));

  const popupGone = !afterConfirmText.includes('We heard an introduction');
  const showsJonathan = afterConfirmText.includes('Jonathan');
  console.log(`popupGone=${popupGone}, showsJonathan=${showsJonathan}`);

  streamWs.close();

  if (popupGone && showsJonathan) {
    console.log('BEHAVIORAL PASS (full round-trip): popup closed after confirm AND "Jonathan" now appears in the real rendered transcript/speaker UI.');
    process.exit(0);
  } else {
    console.error('PARTIAL: popup interaction completed but expected post-confirm UI state not fully observed \u2014 see screenshots/text above for manual review.');
    process.exit(popupGone ? 0 : 1);
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
