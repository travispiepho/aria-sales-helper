import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

process.env.ENABLE_BROWSER_CALLING = 'false';
const { registerTelephonyRoutes } = await import(`../telephony.js?disabled-test=${Date.now()}`);

async function app() {
  const fastify = Fastify({ logger: false });
  fastify.decorateRequest('user', null);
  await registerTelephonyRoutes(fastify, { pool: { query: async () => ({ rows: [] }) } });
  fastify.addHook('preHandler', async (request) => { request.user = { id: 'rep-1' }; });
  await fastify.ready();
  return fastify;
}

test('disabled feature safely rejects token and Twilio routes', async () => {
  const fastify = await app();
  const token = await fastify.inject({ method: 'POST', url: '/telephony/browser-token', payload: { customerPhone: '6165550123' } });
  assert.equal(token.statusCode, 503);
  assert.equal(token.json().browserCalling, false);
  const twiml = await fastify.inject({ method: 'POST', url: '/telephony/browser-outgoing', payload: {} });
  assert.equal(twiml.statusCode, 503);
  await fastify.close();
});
