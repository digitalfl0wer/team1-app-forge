import { describe, expect, it } from 'vitest';
import { mockChatCompletion, mockClassification } from './mockProvider';
import { classificationSchema } from './types';

describe('mockClassification', () => {
  const cases: [string, string, string | null, number][] = [
    ['fix this bug', 'coding', 'high', 0.9],
    ['write some code', 'coding', 'high', 0.9],
    ['make an image of a cat', 'image_generation', null, 0.9],
    ['summarize the report', 'summarization', 'low', 0.9],
    ['plan the offsite', 'general', 'medium', 0.9],
    ['debug it MOCK_AMBIGUOUS', 'coding', 'high', 0.3],
  ];
  it.each(cases)('%s', (text, category, level, confidence) => {
    const c = mockClassification(text);
    expect(classificationSchema.safeParse(c).success).toBe(true);
    expect(c.category).toBe(category);
    if (level) expect(c.reasoningLevel).toBe(level);
    expect(c.confidence).toBe(confidence);
  });
});

describe('mockChatCompletion', () => {
  it('guard: safe and unsafe', async () => {
    const guard = 'meta-llama/llama-guard-4-12b';
    const safe = await mockChatCompletion({ model: guard, messages: [{ role: 'user', content: 'hi' }], maxCompletionTokens: 5 });
    const bad = await mockChatCompletion({ model: guard, messages: [{ role: 'user', content: 'MOCK_UNSAFE' }], maxCompletionTokens: 5 });
    expect(safe.content).toBe('safe');
    expect(bad.content).toBe('unsafe\nS1');
  });
  it('worker returns canned answer', async () => {
    const r = await mockChatCompletion({ model: 'any/model', messages: [{ role: 'user', content: 'hi' }], maxCompletionTokens: 5 });
    expect(r.content).toMatch(/Mock/);
    expect(r.costUsd).toBe(0);
  });
});
