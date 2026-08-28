const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_REFERER = 'https://aria.certaprograndhaven.com';
const OPENROUTER_TITLE = 'ARIA Sales Helper';

export class AiGenerationError extends Error {
  constructor(message, { attempts = [], cause } = {}) {
    super(message, { cause });
    this.name = 'AiGenerationError';
    this.code = 'AI_GENERATION_FAILED';
    this.attempts = attempts;
  }
}

function safeAttempt(provider, error) {
  const status = Number(error?.status || error?.statusCode);
  return {
    provider,
    ...(Number.isInteger(status) ? { status } : {}),
  };
}

function extractAnthropicText(response) {
  return response?.content?.find((part) => part?.type === 'text')?.text || null;
}

function extractOpenRouterText(response) {
  return response?.choices?.[0]?.message?.content || null;
}

/**
 * Central text-generation router for routes that intentionally prefer the
 * direct Anthropic API. A configured Anthropic key selects the first attempt,
 * not the only provider: any runtime failure or unusable response gets one
 * OpenRouter attempt when that provider is configured.
 *
 * Error metadata is deliberately limited to provider names and HTTP statuses;
 * prompts, transcripts, response bodies, and credentials never enter errors.
 */
export function createAnthropicPrimaryTextGenerator({
  anthropicApiKey,
  openRouterApiKey,
  anthropicClient,
  fetchImpl = globalThis.fetch,
} = {}) {
  const availability = Object.freeze({
    anthropic: anthropicApiKey ? 'configured' : 'missing',
    openrouter: openRouterApiKey ? 'configured' : 'missing',
    textGeneration: anthropicApiKey || openRouterApiKey ? 'configured' : 'missing',
  });

  async function callOpenRouter({ model, maxTokens, system, messages }) {
    let response;
    try {
      response = await fetchImpl(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openRouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': OPENROUTER_REFERER,
          'X-Title': OPENROUTER_TITLE,
        },
        body: JSON.stringify({
          model: model.startsWith('anthropic/') ? model : `anthropic/${model}`,
          max_tokens: maxTokens,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            ...messages,
          ],
        }),
      });
    } catch (cause) {
      const error = new Error('OpenRouter request failed');
      error.cause = cause;
      throw error;
    }

    if (!response.ok) {
      const error = new Error(`OpenRouter request failed with HTTP ${response.status}`);
      error.status = response.status;
      // Drain the response without retaining or surfacing provider content.
      try { await response.text(); } catch {}
      throw error;
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('OpenRouter returned an invalid response');
    }
    const text = extractOpenRouterText(data);
    if (!text) throw new Error('OpenRouter returned no text');
    return text;
  }

  return {
    availability,

    async generate({ model, openRouterModel, maxTokens, system, messages }) {
      const attempts = [];

      if (anthropicApiKey && anthropicClient) {
        try {
          const response = await anthropicClient.messages.create({
            model,
            max_tokens: maxTokens,
            ...(system ? { system } : {}),
            messages,
          });
          const text = extractAnthropicText(response);
          if (!text) throw new Error('Anthropic returned no text');
          return { text, provider: 'anthropic' };
        } catch (error) {
          attempts.push(safeAttempt('anthropic', error));
          if (!openRouterApiKey) {
            throw new AiGenerationError('AI generation failed via Anthropic', { attempts, cause: error });
          }
        }
      }

      if (openRouterApiKey) {
        try {
          const text = await callOpenRouter({
            model: openRouterModel || model,
            maxTokens,
            system,
            messages,
          });
          return { text, provider: 'openrouter' };
        } catch (error) {
          attempts.push(safeAttempt('openrouter', error));
          const providers = attempts.map((attempt) => attempt.provider).join(' and ');
          throw new AiGenerationError(`AI generation failed via ${providers}`, { attempts, cause: error });
        }
      }

      throw new AiGenerationError('AI generation is not configured', { attempts });
    },
  };
}
