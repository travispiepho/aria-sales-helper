import assert from 'node:assert/strict';
import test from 'node:test';
import { AiGenerationError, createAnthropicPrimaryTextGenerator } from '../aiProvider.js';

const request = {
  model: 'claude-haiku-4-5',
  maxTokens: 1500,
  system: 'non-sensitive system prompt',
  messages: [{ role: 'user', content: 'non-sensitive user prompt' }],
};

function openRouterResponse(text = 'OpenRouter summary') {
  return {
    ok: true,
    status: 200,
    async json() { return { choices: [{ message: { content: text } }] }; },
  };
}

test('Anthropic success remains primary and does not call OpenRouter', async () => {
  let openRouterCalls = 0;
  const generator = createAnthropicPrimaryTextGenerator({
    anthropicApiKey: 'anthropic-key',
    openRouterApiKey: 'openrouter-key',
    anthropicClient: { messages: { create: async () => ({ content: [{ type: 'text', text: 'Anthropic summary' }] }) } },
    fetchImpl: async () => { openRouterCalls += 1; return openRouterResponse(); },
  });

  assert.deepEqual(await generator.generate(request), { text: 'Anthropic summary', provider: 'anthropic' });
  assert.equal(openRouterCalls, 0);
});

test('configured Anthropic insufficient-funds failure falls back once to OpenRouter', async () => {
  let openRouterCalls = 0;
  const insufficientFunds = Object.assign(new Error('credit balance is too low'), { status: 400 });
  const generator = createAnthropicPrimaryTextGenerator({
    anthropicApiKey: 'anthropic-key',
    openRouterApiKey: 'openrouter-key',
    anthropicClient: { messages: { create: async () => { throw insufficientFunds; } } },
    fetchImpl: async (_url, options) => {
      openRouterCalls += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'anthropic/claude-haiku-4-5');
      assert.deepEqual(body.messages, [
        { role: 'system', content: request.system },
        ...request.messages,
      ]);
      return openRouterResponse();
    },
  });

  assert.deepEqual(await generator.generate(request), { text: 'OpenRouter summary', provider: 'openrouter' });
  assert.equal(openRouterCalls, 1);
});

test('missing Anthropic uses OpenRouter', async () => {
  let openRouterCalls = 0;
  const generator = createAnthropicPrimaryTextGenerator({
    anthropicApiKey: null,
    openRouterApiKey: 'openrouter-key',
    fetchImpl: async () => { openRouterCalls += 1; return openRouterResponse('Fallback-only summary'); },
  });

  assert.deepEqual(await generator.generate(request), { text: 'Fallback-only summary', provider: 'openrouter' });
  assert.equal(openRouterCalls, 1);
  assert.deepEqual(generator.availability, {
    anthropic: 'missing', openrouter: 'configured', textGeneration: 'configured',
  });
});

test('both providers failing returns truthful sanitized failure metadata', async () => {
  const secretPrompt = 'customer transcript that must not leak';
  const anthropicError = Object.assign(new Error(`declined while handling ${secretPrompt}`), { status: 429 });
  const generator = createAnthropicPrimaryTextGenerator({
    anthropicApiKey: 'anthropic-secret',
    openRouterApiKey: 'openrouter-secret',
    anthropicClient: { messages: { create: async () => { throw anthropicError; } } },
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      async text() { return `provider body containing ${secretPrompt}`; },
    }),
  });

  await assert.rejects(
    generator.generate({ ...request, messages: [{ role: 'user', content: secretPrompt }] }),
    (error) => {
      assert.ok(error instanceof AiGenerationError);
      assert.equal(error.message, 'AI generation failed via anthropic and openrouter');
      assert.deepEqual(error.attempts, [
        { provider: 'anthropic', status: 429 },
        { provider: 'openrouter', status: 503 },
      ]);
      assert.doesNotMatch(JSON.stringify({ message: error.message, attempts: error.attempts }), /transcript|secret/i);
      return true;
    },
  );
});
