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

const MEETINGS = {
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
    res.end(JSON.stringify({ segments: [] }));
    return;
  }

  if (url.pathname.match(/^\/api\/meetings\/[^/]+\/coaching\/latest$/)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ coaching: null }));
    return;
  }

  res.writeHead(404);
  res.end('{}');
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    // no-op socket: never sends anything unless told to; MeetingPage's
    // sync_snapshot handling only fires on an actual message.
    ws.on('message', () => {});
  });
});

server.listen(PORT, () => {
  console.log(`mock ARIA backend listening on ${PORT}`);
});
