import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({ fetch: vi.fn() }));

import { buildRequestBody, chatCompletion, OpenRouterError } from './openrouter';
import type { ChatCompletionOptions, FetchLike } from './openrouter';

const FAKE_KEY = 'sk-or-fake-key-for-tests-123';
const messages = [{ role: 'user' as const, content: 'SECRET PROMPT TEXT' }];

const okBody = (over: Record<string, unknown> = {}) => ({
  model: 'x/y',
  choices: [{ finish_reason: 'stop', message: { content: 'hello' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0002 },
  ...over,
});

const respond = (status: number, body: unknown) => async () => ({ status, json: async () => body });

function opts(fetchImpl: FetchLike, extra: Partial<ChatCompletionOptions> = {}): ChatCompletionOptions {
  return {
    model: 'x/y',
    messages,
    maxCompletionTokens: 100,
    fetchImpl,
    sleep: async () => undefined,
    ...extra,
  };
}

async function failure(p: Promise<unknown>): Promise<OpenRouterError> {
  try {
    await p;
  } catch (e) {
    return e as OpenRouterError;
  }
  throw new Error('expected failure');
}

let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', FAKE_KEY);
  vi.stubEnv('AI_MOCK', undefined);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('request building', () => {
  it('sends the expected headers, URL and body; key only in Authorization', async () => {
    const f = vi.fn(respond(200, okBody()));
    await chatCompletion(opts(f, { temperature: 0 }));
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['HTTP-Referer']).toBeUndefined(); // optional; we do not send a site URL
    expect(init.headers['X-OpenRouter-Title']).toBeTruthy();
    expect(init.headers['X-Title']).toBeTruthy();
    expect(init.body).not.toContain(FAKE_KEY);
    const others = Object.entries(init.headers).filter(([k]) => k !== 'Authorization');
    expect(JSON.stringify(others)).not.toContain(FAKE_KEY);
  });

  it('builds json_schema strict body with require_parameters', () => {
    const body = buildRequestBody({
      model: 'm',
      messages,
      maxCompletionTokens: 300,
      responseFormat: { name: 'n', schema: { type: 'object' } },
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body).toMatchObject({
      model: 'm',
      max_completion_tokens: 300,
      response_format: { type: 'json_schema', json_schema: { name: 'n', strict: true, schema: { type: 'object' } } },
      provider: { require_parameters: true },
    });
  });

  it('never sends temperature with a strict schema, only when asked and without one', () => {
    const schema = { name: 'n', schema: { type: 'object' } };
    expect(buildRequestBody({ model: 'm', messages, maxCompletionTokens: 5, temperature: 0, responseFormat: schema })).not.toHaveProperty('temperature');
    expect(buildRequestBody({ model: 'm', messages, maxCompletionTokens: 5 })).not.toHaveProperty('temperature');
    expect(buildRequestBody({ model: 'm', messages, maxCompletionTokens: 5, temperature: 0 })).toMatchObject({ temperature: 0 });
  });

  it('omits response_format and provider when no schema', () => {
    const body = buildRequestBody({ model: 'm', messages, maxCompletionTokens: 5 });
    expect(body).not.toHaveProperty('response_format');
    expect(body).not.toHaveProperty('provider');
  });

  it('parses content, usage and cost', async () => {
    const r = await chatCompletion(opts(respond(200, okBody())));
    expect(r).toEqual({
      content: 'hello',
      finishReason: 'stop',
      model: 'x/y',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      costUsd: 0.0002,
    });
  });

  it('costUsd null when absent', async () => {
    const r = await chatCompletion(opts(respond(200, okBody({ usage: { prompt_tokens: 1, completion_tokens: 1 } }))));
    expect(r.costUsd).toBeNull();
    expect(r.usage.totalTokens).toBe(2);
  });
});

describe('error mapping', () => {
  it.each([
    [402, 'INSUFFICIENT_CREDIT'],
    [408, 'TIMEOUT'],
    [429, 'RATE_LIMITED'],
    [401, 'PROVIDER_ERROR'],
    [403, 'PROVIDER_ERROR'],
    [400, 'PROVIDER_ERROR'],
    [500, 'PROVIDER_ERROR'],
    [503, 'PROVIDER_ERROR'],
  ])('status %i -> %s', async (status, code) => {
    const e = await failure(chatCompletion(opts(respond(status, { error: { message: 'raw provider text' } }))));
    expect(e).toBeInstanceOf(OpenRouterError);
    expect(e.code).toBe(code);
    expect(e.status).toBe(status);
    expect(e.userMessage).not.toContain('raw provider text');
  });

  it('402 message depends on limit_source', async () => {
    const key = await failure(
      chatCompletion(opts(respond(402, { error: { metadata: { limit_source: 'key' } } }))),
    );
    const credits = await failure(chatCompletion(opts(respond(402, { error: {} }))));
    expect(key.userMessage).toMatch(/key/i);
    expect(credits.userMessage).toMatch(/credits/i);
    expect(key.userMessage).not.toBe(credits.userMessage);
  });

  it('missing key -> PROVIDER_ERROR, no fetch', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const f = vi.fn(respond(200, okBody()));
    const e = await failure(chatCompletion(opts(f)));
    expect(e.code).toBe('PROVIDER_ERROR');
    expect(e.userMessage).toBe('AI is not configured');
    expect(f).not.toHaveBeenCalled();
  });

  it('200 with body.error is a failure', async () => {
    const e = await failure(chatCompletion(opts(respond(200, { error: { code: 429, message: 'slow' } }))));
    expect(e.code).toBe('RATE_LIMITED');
    const e2 = await failure(chatCompletion(opts(respond(200, { error: { message: 'weird' } }))));
    expect(e2.code).toBe('PROVIDER_ERROR');
  });

  it.each(['error', 'length'])('finish_reason %s is a failure', async (reason) => {
    const body = okBody({ choices: [{ finish_reason: reason, message: { content: 'partial' } }] });
    const e = await failure(chatCompletion(opts(respond(200, body))));
    expect(e.code).toBe('PROVIDER_ERROR');
  });

  it('invalid body shape is a failure', async () => {
    const e = await failure(chatCompletion(opts(respond(200, { choices: [] }))));
    expect(e.code).toBe('PROVIDER_ERROR');
  });

  it('network failure maps to PROVIDER_ERROR without leaking the cause', async () => {
    const f: FetchLike = async () => {
      throw new Error(`boom ${FAKE_KEY}`);
    };
    const e = await failure(chatCompletion(opts(f)));
    expect(e.code).toBe('PROVIDER_ERROR');
    expect(e.message).not.toContain(FAKE_KEY);
  });
});

describe('timeout', () => {
  it('maps an AbortError from fetch to TIMEOUT', async () => {
    const f: FetchLike = async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    };
    expect((await failure(chatCompletion(opts(f)))).code).toBe('TIMEOUT');
  });

  it('enforces the timeout via race even if fetch ignores the signal', async () => {
    vi.useFakeTimers();
    const f: FetchLike = () => new Promise(() => undefined); // never settles, ignores signal
    const p = failure(chatCompletion(opts(f, { timeoutMs: 1000 })));
    await vi.advanceTimersByTimeAsync(1001);
    expect((await p).code).toBe('TIMEOUT');
  });

  it('aborts the signal when the timeout fires', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const f: FetchLike = (_u, init) => {
      signal = init.signal;
      return new Promise(() => undefined);
    };
    const p = failure(chatCompletion(opts(f, { timeoutMs: 50 })));
    await vi.advanceTimersByTimeAsync(60);
    await p;
    expect(signal?.aborted).toBe(true);
  });

  it('uses a 20s default', async () => {
    vi.useFakeTimers();
    const f: FetchLike = () => new Promise(() => undefined);
    let done = false;
    const p = failure(chatCompletion(opts(f))).then((e) => {
      done = true;
      return e;
    });
    await vi.advanceTimersByTimeAsync(19_900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect((await p).code).toBe('TIMEOUT');
  });
});

describe('retry', () => {
  it('does not retry by default', async () => {
    const f = vi.fn(respond(429, {}));
    await failure(chatCompletion(opts(f)));
    expect(f).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500, 503])('retries %i once and can succeed', async (status) => {
    const f = vi.fn().mockResolvedValueOnce({ status, json: async () => ({}) });
    f.mockResolvedValueOnce({ status: 200, json: async () => okBody() });
    const r = await chatCompletion(opts(f, { retries: 1 }));
    expect(r.content).toBe('hello');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('retries at most once even if retries is larger', async () => {
    const f = vi.fn(respond(503, {}));
    const e = await failure(chatCompletion(opts(f, { retries: 5 })));
    expect(e.code).toBe('PROVIDER_ERROR');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 402, 403])('does not retry %i', async (status) => {
    const f = vi.fn(respond(status, {}));
    await failure(chatCompletion(opts(f, { retries: 1 })));
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('does not retry timeouts', async () => {
    const f = vi.fn(async () => {
      const err = new Error('x');
      err.name = 'AbortError';
      throw err;
    });
    await failure(chatCompletion(opts(f as unknown as FetchLike, { retries: 1 })));
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('secrecy', () => {
  it('never leaks key, prompt or auth header into errors or console', async () => {
    const statuses = [401, 402, 429, 500];
    for (const s of statuses) {
      const e = await failure(
        chatCompletion(
          opts(respond(s, { error: { message: `bad ${FAKE_KEY} SECRET PROMPT TEXT` } }), { retries: 1 }),
        ),
      );
      expect(JSON.stringify([e.message, e.userMessage, e.code, e.stack])).not.toContain(FAKE_KEY);
      expect(e.message).not.toContain('SECRET PROMPT TEXT');
    }
    const logged = JSON.stringify([errSpy.mock.calls, logSpy.mock.calls, warnSpy.mock.calls]);
    expect(logged).not.toContain(FAKE_KEY);
    expect(logged).not.toContain('SECRET PROMPT TEXT');
    expect(logged).not.toContain('Bearer');
    expect(errSpy).toHaveBeenCalled();
    expect(logged).toMatch(/code=/);
  });
});

describe('mock mode', () => {
  it('is off by default: the network path is used', async () => {
    const f = vi.fn(respond(200, okBody()));
    const r = await chatCompletion(opts(f));
    expect(f).toHaveBeenCalledTimes(1);
    expect(r.content).toBe('hello');
  });

  it.each(['true', '0', 'yes', ' 1', '1 ', 'TRUE', ''])('AI_MOCK=%j does not enable mock', async (v) => {
    vi.stubEnv('AI_MOCK', v);
    const f = vi.fn(respond(200, okBody()));
    await chatCompletion(opts(f));
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('AI_MOCK=1 bypasses network and key, costUsd 0', async () => {
    vi.stubEnv('AI_MOCK', '1');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const f = vi.fn(respond(500, {}));
    const r = await chatCompletion(opts(f));
    expect(f).not.toHaveBeenCalled();
    expect(r.costUsd).toBe(0);
    expect(r.content.length).toBeGreaterThan(0);
    expect(r.usage.totalTokens).toBeGreaterThan(0);
  });
});
