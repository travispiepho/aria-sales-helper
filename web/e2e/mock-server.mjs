// Minimal mocked ARIA backend for MeetingPage UI regression tests
// (2026-08-17 outbound-call diagnosis task). Serves just enough of
// GET /api/meetings/:id, GET /api/meetings/:id/segments,
// GET /api/meetings/:id/coaching/latest, and upgrades
// GET /meetings/:id/observe + /meetings/:id/audio to a no-op WebSocket
// (never sends anything unless the test script pokes it) so MeetingPage
// can render fully offline, three ways:
//   - phone-recording:    channel=phone, call_sid set, recording_status='in-progress'
//   - phone-not-recording:channel=phone, call_sid set, recording_status=null
//   - in-person:          channel=in_person, call_sid=null
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = process.env.MOCK_PORT || 4100;

const now = new Date();
const startedAt = now.toISOString();

const checklist = Array.from({ length: 11 }, (_, index) => ({
  id: `item-${index + 1}`,
  label: `Checklist item ${index + 1} has readable guidance`,
  done: index < 3,
}));
const coaching = {
  disc: { detected: 'D', confidence: 'high', emoji: '🎯', label: 'Direct', tip: 'Keep it concise.' },
  stage: { current: 'first_go_around', label: 'First Go Around' },
  checklist,
  nudges: ['Ask the next question.'],
  urgent: null,
};

const MEETINGS = {
  'browser-live': {
    id: 'browser-live',
    channel: 'phone',
    call_sid: 'CAbrowserlive',
    status: 'active',
    started_at: startedAt,
    ended_at: null,
    recording_status: 'in-progress',
    customer_name: 'Browser Call Customer',
    is_owner_session: true,
    title: 'Browser Call Customer',
  },
  'phone-recording': {
    id: 'phone-recording',
    channel: 'phone',
    call_sid: 'CAtest111',
    status: 'active',
    started_at: startedAt,
    ended_at: null,
    recording_status: 'in-progress',
    customer_name: 'Test Customer',
    is_owner_session: true,
    title: 'Test Customer',
  },
  'phone-not-recording': {
    id: 'phone-not-recording',
    channel: 'phone',
    call_sid: 'CAtest222',
    status: 'active',
    started_at: startedAt,
    ended_at: null,
    recording_status: null,
    customer_name: 'Test Customer 2',
    is_owner_session: true,
    title: 'Test Customer 2',
  },
  'in-person': {
    id: 'in-person',
    channel: 'in_person',
    call_sid: null,
    status: 'active',
    started_at: startedAt,
    ended_at: null,
    recording_status: null,
    customer_name: 'In Person Customer',
    is_owner_session: true,
    title: 'In Person Customer',
  },
  'mobile-sync': {
    id: 'mobile-sync',
    channel: 'in_person',
    call_sid: null,
    status: 'active',
    started_at: startedAt,
    ended_at: null,
    recording_status: null,
    customer_name: 'Mobile Sync Customer',
    origin_client: 'mobile',
    is_owner_session: false,
    title: 'Mobile Sync Customer',
  },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // credentials:'include' fetches (the real api.ts client) cannot use a
  // wildcard Access-Control-Allow-Origin — the browser silently fails the
  // request (blocked by CORS) if the response doesn't echo back the exact
  // requesting origin AND set Allow-Credentials:true. Echo the request's
  // own Origin header (this mock is test-only, never exposed).
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ user: { id: 'rep-test', name: 'Test Rep', role: 'rep' } }));
    return;
  }

  const meetingMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)$/);
  if (meetingMatch && req.method === 'GET') {
    const m = MEETINGS[meetingMatch[1]];
    if (!m) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(m));
    return;
  }

  if (url.pathname.match(/^\/api\/meetings\/[^/]+\/segments$/)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ segments: url.pathname.includes('browser-live') ? [
      { id: 'segment-browser-1', speaker: 'Customer', text: 'I can see the live transcript.', ts: startedAt },
    ] : [] }));
    return;
  }

  if (url.pathname.match(/^\/api\/meetings\/[^/]+\/coaching\/latest$/)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ coaching }));
    return;
  }

  const pushMatch = url.pathname.match(/^\/test\/push\/([^/]+)$/);
  if (pushMatch && req.method === 'POST') {
    handleTestPush(req, res, pushMatch[1]);
    return;
  }

  res.writeHead(404);
  res.end('{}');
});

const wss = new WebSocketServer({ noServer: true });

// 2026-08-18 (Deepgram reconnect hardening) — registry of live sockets per
// meeting id so a test script can POST /test/push/:meetingId to inject a
// server-pushed message (e.g. transcription_lapse) into an already-open
// /meetings/:id/observe or /meetings/:id/audio connection, exactly like the
// real broadcastToMeeting() the production server uses. This lets the
// Playwright test behaviorally verify the transcript UI renders a real
// pushed WS message, not just a code-path trace.
const socketsByMeeting = new Map();

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const match = url.pathname.match(/^\/meetings\/([^/]+)\/(observe|audio)$/);
    const meetingId = match ? match[1] : null;
    if (meetingId) {
      if (!socketsByMeeting.has(meetingId)) socketsByMeeting.set(meetingId, new Set());
      socketsByMeeting.get(meetingId).add(ws);
      ws.on('close', () => socketsByMeeting.get(meetingId)?.delete(ws));
    }
    // no-op socket otherwise: never sends anything unless told to via
    // /test/push; MeetingPage's sync_snapshot handling only fires on an
    // actual message.
    ws.on('message', () => {});
  });
});

// Re-wrap the http server's request handler so /test/push/:meetingId is
// available without restructuring the createServer() call above (Node's
// http server only supports one 'request' listener via createServer's
// callback param, so this hooks the SAME handler by intercepting before it
// runs — see the requestListener reassignment at the bottom of this file).
function handleTestPush(req, res, meetingId) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
    const sockets = socketsByMeeting.get(meetingId);
    let sent = 0;
    if (sockets) {
      for (const ws of sockets) {
        if (ws.readyState === ws.OPEN) { ws.send(JSON.stringify(msg)); sent += 1; }
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sent }));
  });
}

server.listen(PORT, () => {
  console.log(`mock ARIA backend listening on ${PORT}`);
});
