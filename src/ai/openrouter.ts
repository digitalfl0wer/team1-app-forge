import { fetch as forgeFetch } from '@forge/api';
import { mockChatCompletion } from './mockProvider';

// @types/node is not installed; Forge runtime provides process.env.
declare const process: { env: Record<string, string | undefined> };

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_TIMEOUT_MS = 20_000;
const APP_TITLE = 'Team 1 Todo';
const RETRY_DELAY_MS = 500;

export type OpenRouterErrorCode =
  | 'PROVIDER_ERROR'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'INSUFFICIENT_CREDIT';

export class OpenRouterError extends Error {
  readonly code: OpenRouterErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly userMessage: string;

  constructor(code: OpenRouterErrorCode, userMessage: string, status?: number, retryable = false) {
    // The message is the user-safe message: never provider text, prompts or secrets.
    super(userMessage);
    this.name = 'OpenRouterError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.userMessage = userMessage;
  }
}

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type ResponseFormatOption = { name: string; schema: Record<string, unknown> };

export type MinimalResponse = {
  status: number;
  json(): Promise<unknown>;
};
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<MinimalResponse>;

export type ChatCompletionOptions = {
  model: string;
  messages: ChatMessage[];
  maxCompletionTokens: number;
  temperature?: number;
  responseFormat?: ResponseFormatOption;
  timeoutMs?: number;
  /** Opt-in retry count, clamped to 1. Applies only to 429 and 5xx. */
  retries?: number;
  /** Injectable for tests. Defaults to the egress-proxied fetch from @forge/api. */
  fetchImpl?: FetchLike;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
};

export type ChatCompletionResult = {
  content: string;
  finishReason: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  costUsd: number | null;
};

export function buildRequestBody(opts: ChatCompletionOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    max_completion_tokens: opts.maxCompletionTokens,
    temperature: opts.temperature ?? 0,
  };
  if (opts.responseFormat) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: opts.responseFormat.name, strict: true, schema: opts.responseFormat.schema },
    };
    body.provider = { require_parameters: true };
  }
  return body;
}

export function buildHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-OpenRouter-Title': APP_TITLE,
    'X-Title': APP_TITLE,
  };
}

function logFailure(err: OpenRouterError, model: string): void {
  // Only code, status and model. Never key, headers, body or prompt.
  console.error(`[ai] openrouter failure code=${err.code} status=${err.status ?? 'n/a'} model=${model}`);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function errorFromStatus(status: number, errorBody: Record<string, unknown> | null): OpenRouterError {
  if (status === 402) {
    const meta = asRecord(errorBody?.metadata);
    const source = typeof meta?.limit_source === 'string' ? meta.limit_source.toLowerCase() : '';
    const msg = source.includes('key')
      ? 'The AI key spending limit has been reached. Ask an admin to raise it.'
      : 'AI credits are exhausted. Ask an admin to add credits.';
    return new OpenRouterError('INSUFFICIENT_CREDIT', msg, status);
  }
  if (status === 408) return new OpenRouterError('TIMEOUT', 'The AI request timed out. Try again.', status);
  if (status === 429)
    return new OpenRouterError('RATE_LIMITED', 'The AI service is busy. Try again shortly.', status, true);
  if (status >= 500)
    return new OpenRouterError('PROVIDER_ERROR', 'The AI service is temporarily unavailable.', status, true);
  return new OpenRouterError('PROVIDER_ERROR', 'The AI request failed.', status);
}

function timeoutError(): OpenRouterError {
  return new OpenRouterError('TIMEOUT', 'The AI request timed out. Try again.');
}

function parseSuccess(body: unknown, requestedModel: string): ChatCompletionResult {
  const rec = asRecord(body);
  const err = asRecord(rec?.error);
  if (err) {
    const code = typeof err.code === 'number' ? err.code : Number(err.code);
    throw errorFromStatus(Number.isFinite(code) && code >= 400 ? code : 502, err);
  }
  const choices = rec?.choices;
  const choice = Array.isArray(choices) ? asRecord(choices[0]) : null;
  if (!choice) throw new OpenRouterError('PROVIDER_ERROR', 'The AI returned an invalid response.');
  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'unknown';
  if (finishReason === 'error') throw new OpenRouterError('PROVIDER_ERROR', 'The AI provider reported an error.');
  if (finishReason === 'length')
    throw new OpenRouterError('PROVIDER_ERROR', 'The AI response was cut off before it finished (truncated).');
  const message = asRecord(choice.message);
  const content = message?.content;
  if (typeof content !== 'string') throw new OpenRouterError('PROVIDER_ERROR', 'The AI returned an empty response.');
  const usage = asRecord(rec?.usage);
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const promptTokens = num(usage?.prompt_tokens);
  const completionTokens = num(usage?.completion_tokens);
  const cost = usage?.cost;
  return {
    content,
    finishReason,
    model: typeof rec?.model === 'string' ? rec.model : requestedModel,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: typeof usage?.total_tokens === 'number' ? usage.total_tokens : promptTokens + completionTokens,
    },
    costUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
  };
}

async function attempt(
  opts: ChatCompletionOptions,
  apiKey: string,
  fetchImpl: FetchLike,
): Promise<ChatCompletionResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError());
    }, timeoutMs);
  });
  const work = (async (): Promise<ChatCompletionResult> => {
    let res: MinimalResponse;
    try {
      res = await fetchImpl(OPENROUTER_URL, {
        method: 'POST',
        headers: buildHeaders(apiKey),
        body: JSON.stringify(buildRequestBody(opts)),
        signal: controller.signal,
      });
    } catch (e) {
      if (e instanceof OpenRouterError) throw e;
      const name = e && typeof e === 'object' ? (e as { name?: unknown }).name : undefined;
      if (name === 'AbortError' || name === 'TimeoutError') throw timeoutError();
      throw new OpenRouterError('PROVIDER_ERROR', 'Could not reach the AI service.');
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.status < 200 || res.status >= 300) {
      throw errorFromStatus(res.status, asRecord(asRecord(body)?.error));
    }
    return parseSuccess(body, opts.model);
  })();
  // Avoid unhandled rejection if the timeout wins the race.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
  if (process.env.AI_MOCK === '1') return mockChatCompletion(opts);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const err = new OpenRouterError('PROVIDER_ERROR', 'AI is not configured');
    logFailure(err, opts.model);
    throw err;
  }
  const fetchImpl = opts.fetchImpl ?? (forgeFetch as unknown as FetchLike);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = Math.min(Math.max(opts.retries ?? 0, 0), 1);

  for (let n = 0; ; n++) {
    try {
      return await attempt(opts, apiKey, fetchImpl);
    } catch (e) {
      const err =
        e instanceof OpenRouterError ? e : new OpenRouterError('PROVIDER_ERROR', 'The AI request failed.');
      logFailure(err, opts.model);
      if (n < maxRetries && err.retryable) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
}
