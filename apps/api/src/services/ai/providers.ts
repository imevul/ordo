import Anthropic from '@anthropic-ai/sdk';
import type { AiSettings } from '@ordo/shared';
import type { z } from 'zod';
import { HttpError } from '../../lib/errors.ts';
import { safeFetch } from '../../lib/safeFetch.ts';

/** One prompt in, one answer out. Both providers speak this; features don't care which it is. */
export interface CompletionRequest {
  system: string;
  prompt: string;
  /** JSON schema the answer follows (structured outputs where the provider has them). */
  schema?: Record<string, unknown>;
  maxTokens?: number;
}

export interface AiModel {
  complete(req: CompletionRequest): Promise<string>;
}

/** The provider failed or answered something unusable; shown to the person who asked. */
export const aiError = (message: string) => new HttpError(502, message, 'ai_failed');

const DEFAULT_MAX_TOKENS = 8000;

export function aiModel(settings: AiSettings, apiKey: string | null): AiModel {
  return settings.provider === 'anthropic'
    ? claude(settings, apiKey)
    : openAiCompatible(settings, apiKey);
}

function claude(settings: AiSettings, apiKey: string | null): AiModel {
  if (!apiKey) throw aiError('The Claude API needs an API key; an instance admin can add one');
  const client = new Anthropic({
    apiKey,
    // Explicit, so ANTHROPIC_BASE_URL in the server's environment can't redirect it.
    baseURL: settings.baseUrl ?? 'https://api.anthropic.com',
    timeout: 120_000,
    maxRetries: 2,
  });
  return {
    async complete(req) {
      let res: Anthropic.Message;
      try {
        res = await client.messages.create({
          model: settings.model,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: req.system,
          messages: [{ role: 'user', content: req.prompt }],
          ...(req.schema && {
            output_config: { format: { type: 'json_schema', schema: req.schema } },
          }),
        });
      } catch (err) {
        if (err instanceof Anthropic.APIError)
          throw aiError(`The Claude API answered ${err.status ?? 'with an error'}: ${err.message}`);
        throw err;
      }
      if (res.stop_reason === 'refusal') throw aiError('The model declined to answer');
      if (res.stop_reason === 'max_tokens')
        throw aiError('The answer was too long and got cut off');
      return res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    },
  };
}

interface ChatCompletion {
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  error?: { message?: string } | string;
}

function openAiCompatible(settings: AiSettings, apiKey: string | null): AiModel {
  if (!settings.baseUrl) throw aiError('The OpenAI-compatible endpoint needs a base URL');
  const url = `${settings.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const host = new URL(url).host;
  return {
    async complete(req) {
      const send = (structured: boolean) =>
        safeFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey && { authorization: `Bearer ${apiKey}` }),
          },
          body: JSON.stringify({
            model: settings.model,
            messages: [
              { role: 'system', content: req.system },
              { role: 'user', content: req.prompt },
            ],
            max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
            stream: false,
            ...(structured &&
              req.schema && {
                response_format: {
                  type: 'json_schema',
                  json_schema: { name: 'answer', strict: true, schema: req.schema },
                },
              }),
          }),
          // Only an instance admin (or the operator's env) sets this URL, and a model on the LAN
          // or the same host is the point of this provider, so private addresses are allowed.
          allowPrivate: true,
          // Local models on modest hardware are slow.
          timeoutMs: 180_000,
        }).catch((err: unknown) => {
          throw aiError(`Couldn't reach ${host}: ${err instanceof Error ? err.message : err}`);
        });
      let res = await send(true);
      // Older servers reject json_schema; the prompt asks for JSON as well, so try without it.
      if (req.schema && res.status === 400) res = await send(false);
      let body: ChatCompletion = {};
      try {
        body = res.json<ChatCompletion>();
      } catch {}
      if (!res.ok) {
        const detail =
          typeof body.error === 'string' ? body.error : body.error?.message || res.text();
        throw aiError(`${host} answered ${res.status}: ${detail.slice(0, 300)}`);
      }
      const choice = body.choices?.[0];
      if (choice?.finish_reason === 'length')
        throw aiError('The answer was too long and got cut off');
      const text = choice?.message?.content;
      if (typeof text !== 'string') throw aiError(`${host} sent no answer`);
      // Reasoning models served this way often put their thinking in the answer.
      return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    },
  };
}

/** The JSON object in an answer, checked against `schema`; tolerates code fences and chatter. */
export function parseAnswer<T>(text: string, schema: z.ZodType<T>): T {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw aiError("The model's answer wasn't in the expected format; try again");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw aiError("The model's answer wasn't in the expected format; try again");
  return parsed.data;
}
