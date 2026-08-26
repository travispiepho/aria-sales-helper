import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import twilio from 'twilio';
import { createRequire } from 'node:module';

const ORIGINAL_ENV = { ...process.env };
Object.assign(process.env, {
  ENABLE_BROWSER_CALLING: 'true',
  TWILIO_ACCOUNT_SID: 'AC11111111111111111111111111111111',
  TWILIO_API_KEY_SID: 'SK22222222222222222222222222222222',
  TWILIO_API_KEY_SECRET: 'test_secret',
  TWILIO_AUTH_TOKEN: 'test_auth_token',
  TWILIO_PHONE_NUMBER: '+16165550100',
  TWILIO_TWIML_APP_SID: 'AP33333333333333333333333333333333',
  TWILIO_BROWSER_TWIML_APP_SID: 'AP44444444444444444444444444444444',
});

const telephony = await import(`../telephony.js?browser-test=${Date.now()}`);
const require = createRequire(import.meta.url);

function makePool() {
  const meetings = [];
  return {
    meetings,
    async query(sql, params = []) {
      if (sql.includes('FROM customers WHERE phone')) return { rows: [{ id: 'customer-1', phone: '6165550123' }] };
      if (sql.includes('SELECT * FROM meetings WHERE call_sid')) return { rows: meetings.filter((m) => m.call_sid === params[0]) };
      if (sql.includes('INSERT INTO meetings')) {
        const row = { id: `meeting-${meetings.length + 1}`, customer_id: params[0], rep_id: params[1], channel: 'phone', call_sid: params[2], status: 'active' };
        meetings.push(row);
        return { rows: [row] };
      }
      if (sql.includes('UPDATE meetings SET status')) return { rows: [] };
      throw new Error(`Unhandled SQL: ${sql}`);
    },
  };
}

async function buildApp({ authenticated = true } = {}) {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null);
  const pool = makePool();
  await telephony.registerTelephonyRoutes(app, { pool });
  // Matches server.js registration order and proves the session hook applies.
  app.addHook('preHandler', async (request) => {
    if (authenticated) request.user = { id: 'rep-user@example.com', name: 'Rep' };
  });
  await app.ready();
  return { app, pool };
}

function signedHeaders(url, params) {
  return {
    host: new URL(url).host,
    'x-forwarded-proto': 'https',
    'content-type': 'application/x-www-form-urlencoded',
    'x-twilio-signature': twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN, url, params),
  };
}

function form(params) { return new URLSearchParams(params).toString(); }

async function setupBrowserCall(app) {
  const res = await app.inject({ method: 'POST', url: '/telephony/browser-token', payload: { customerPhone: '(616) 555-0123' } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

test('token endpoint requires authenticated rep', async () => {
  const { app } = await buildApp({ authenticated: false });
  const res = await app.inject({ method: 'POST', url: '/telephony/browser-token', payload: { customerPhone: '6165550123' } });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('global auth hook populates request.user before telephony route handler', async () => {
  const { app } = await buildApp({ authenticated: true });
  const res = await app.inject({ method: 'POST', url: '/telephony/browser-token', payload: { customerPhone: '6165550123' } });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test('identity is stable, sanitized, server-derived; grant is outgoing-only and short-lived', async () => {
  const { app } = await buildApp();
  const first = await setupBrowserCall(app);
  const second = await setupBrowserCall(app);
  const decode = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  const a = decode(first.token);
  const b = decode(second.token);
  assert.match(a.grants.identity, /^[A-Za-z0-9_]{1,121}$/);
  assert.equal(a.grants.identity, b.grants.identity);
  assert.equal(a.grants.voice.outgoing.application_sid, process.env.TWILIO_BROWSER_TWIML_APP_SID);
  assert.equal(a.grants.voice.incoming, undefined);
  assert.ok(a.exp - a.iat <= 300);
  assert.deepEqual(Object.keys(first).sort(), ['browserCalling', 'expiresIn', 'pendingCallId', 'token'].sort());
  await app.close();
});

test('Twilio Voice SDK package supports AccessToken/VoiceGrant API used by route', () => {
  const pkg = require('../node_modules/twilio/package.json');
  assert.match(pkg.version, /^6\./);
  const AccessToken = twilio.jwt.AccessToken;
  assert.equal(typeof AccessToken, 'function');
  assert.equal(typeof AccessToken.VoiceGrant, 'function');
});

test('token endpoint rejects invalid customer numbers', async () => {
  const { app } = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/telephony/browser-token', payload: { customerPhone: 'not-a-number' } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('browser TwiML rejects missing/bad signature', async () => {
  const { app } = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/telephony/browser-outgoing', payload: form({ CallSid: 'CA1' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('signed browser TwiML links meeting and preserves consent, dual recording and both-track stream', async () => {
  const { app, pool } = await buildApp();
  const setup = await setupBrowserCall(app);
  const identity = JSON.parse(Buffer.from(setup.token.split('.')[1], 'base64url').toString()).grants.identity;
  const params = { CallSid: 'CA55555555555555555555555555555555', From: `client:${identity}`, pendingCallId: setup.pendingCallId };
  const url = 'https://aria.example.test/telephony/browser-outgoing';
  const res = await app.inject({ method: 'POST', url: '/telephony/browser-outgoing', payload: form(params), headers: signedHeaders(url, params) });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.body, /<Stream[^>]+track="both_tracks"/);
  assert.match(res.body, /record="record-from-answer-dual"/);
  assert.match(res.body, /<Number url="https:\/\/aria\.example\.test\/telephony\/consent-whisper"/);
  assert.match(res.body, />\+16165550123<\/Number>/);
  assert.ok(res.body.indexOf('<Stream') < res.body.indexOf('<Dial'));
  assert.equal(pool.meetings[0].rep_id, 'rep-user@example.com');
  assert.equal(pool.meetings[0].customer_id, 'customer-1');
  assert.equal(pool.meetings[0].call_sid, params.CallSid);

  const status = await app.inject({ method: 'GET', url: `/telephony/browser-call/${setup.pendingCallId}` });
  assert.equal(status.statusCode, 200, status.body);
  assert.deepEqual(status.json(), { meetingId: 'meeting-1', error: null });

  // Single-use pending record prevents a retry from creating another dial.
  const retryUrl = 'https://aria.example.test/telephony/browser-outgoing';
  const retry = await app.inject({ method: 'POST', url: '/telephony/browser-outgoing', payload: form(params), headers: signedHeaders(retryUrl, params) });
  assert.equal(retry.statusCode, 400);
  assert.equal(pool.meetings.length, 1);
  await app.close();
});

test('meeting-ID rendezvous is authenticated and bound to the rep that created the pending call', async () => {
  const { app } = await buildApp();
  const setup = await setupBrowserCall(app);
  const missing = await app.inject({ method: 'GET', url: '/telephony/browser-call/not-real' });
  assert.equal(missing.statusCode, 404);
  await app.close();

  const { app: anonymous } = await buildApp({ authenticated: false });
  const denied = await anonymous.inject({ method: 'GET', url: `/telephony/browser-call/${setup.pendingCallId}` });
  assert.equal(denied.statusCode, 401);
  await anonymous.close();
});

test('signed request cannot swap token identity', async () => {
  const { app } = await buildApp();
  const setup = await setupBrowserCall(app);
  const params = { CallSid: 'CA66666666666666666666666666666666', From: 'client:another_rep', pendingCallId: setup.pendingCallId };
  const url = 'https://aria.example.test/telephony/browser-outgoing';
  const res = await app.inject({ method: 'POST', url: '/telephony/browser-outgoing', payload: form(params), headers: signedHeaders(url, params) });
  assert.equal(res.statusCode, 403);
  await app.close();
});

process.on('exit', () => { process.env = ORIGINAL_ENV; });
