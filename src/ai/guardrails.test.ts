import { describe, expect, it, vi } from 'vitest';
import { checkInputSafety, MAX_OUTPUT_CHARS, sanitizeModelOutput } from './guardrails';
import { OpenRouterError } from './openrouter';
import type { ChatCompletionResult } from './openrouter';

const reply = (content: string) =>
  vi.fn(
    async (): Promise<ChatCompletionResult> => ({
      content,
      finishReason: 'stop',
      model: 'm',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      costUsd: null,
    }),
  );

describe('checkInputSafety', () => {
  it('safe', async () => {
    expect(await checkInputSafety('hello', { chat: reply('safe') })).toEqual({ verdict: 'safe' });
    expect(await checkInputSafety('hello', { chat: reply(' Safe\n') })).toEqual({ verdict: 'safe' });
  });

  it('unsafe with codes', async () => {
    expect(await checkInputSafety('x', { chat: reply('unsafe\nS1, S9') })).toEqual({
      verdict: 'unsafe',
      hazardCodes: ['S1', 'S9'],
    });
  });

  it('unsafe without codes', async () => {
    expect(await checkInputSafety('x', { chat: reply('unsafe') })).toEqual({ verdict: 'unsafe', hazardCodes: [] });
  });

  it.each(['', 'maybe', 'safely done', 'The text is safe', '{"a":1}'])('garbage %j -> error', async (g) => {
    expect((await checkInputSafety('x', { chat: reply(g) })).verdict).toBe('error');
  });

  it('transport error -> error', async () => {
    const chat = vi.fn(async () => {
      throw new OpenRouterError('TIMEOUT', 'timed out');
    });
    expect(await checkInputSafety('x', { chat })).toEqual({ verdict: 'error' });
  });

  it('uses registry guard model, user message, no response_format', async () => {
    const chat = reply('safe');
    await checkInputSafety('the content', { chat });
    const arg = (chat.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(arg.model).toBe('meta-llama/llama-guard-4-12b');
    expect(arg.messages).toEqual([{ role: 'user', content: 'the content' }]);
    expect(arg).not.toHaveProperty('responseFormat');
  });
});

describe('sanitizeModelOutput', () => {
  it('coerces non-strings', () => {
    expect(sanitizeModelOutput(null)).toBe('');
    expect(sanitizeModelOutput(undefined)).toBe('');
    expect(sanitizeModelOutput(42)).toBe('42');
  });
  it('removes NULs and leaves HTML/Markdown untouched', () => {
    expect(sanitizeModelOutput('a\0b<script>**x**</script>')).toBe('ab<script>**x**</script>');
  });
  it('caps with marker', () => {
    const out = sanitizeModelOutput('a'.repeat(MAX_OUTPUT_CHARS + 500));
    expect(out.startsWith('a'.repeat(MAX_OUTPUT_CHARS))).toBe(true);
    expect(out.length).toBeGreaterThan(MAX_OUTPUT_CHARS);
    expect(out).toMatch(/truncated\]$/);
    expect(sanitizeModelOutput('a'.repeat(MAX_OUTPUT_CHARS))).toHaveLength(MAX_OUTPUT_CHARS);
  });
});
