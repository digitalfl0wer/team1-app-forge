import { getModel } from './modelRegistry';
import type { ChatCompletionOptions, ChatCompletionResult } from './openrouter';
import type { Classification } from './types';

// Keep in sync with the prompt wrapper in classifier.ts.
const TASK_BEGIN = '<<<BEGIN_UNTRUSTED_TASK_DATA>>>';
const TASK_END = '<<<END_UNTRUSTED_TASK_DATA>>>';

function lastUserText(opts: ChatCompletionOptions): string {
  for (let i = opts.messages.length - 1; i >= 0; i--) {
    if (opts.messages[i].role === 'user') return opts.messages[i].content;
  }
  return '';
}

function extractTaskText(content: string): string {
  const start = content.indexOf(TASK_BEGIN);
  const end = content.indexOf(TASK_END);
  if (start === -1 || end === -1 || end < start) return content;
  return content.slice(start + TASK_BEGIN.length, end);
}

export function mockClassification(taskText: string): Classification {
  const t = taskText.toLowerCase();
  const confidence = taskText.includes('MOCK_AMBIGUOUS') ? 0.3 : 0.9;
  const base = {
    requirements: [] as Classification['requirements'],
    inputModalities: ['text'] as Classification['inputModalities'],
    outputModality: 'text' as Classification['outputModality'],
    needsTools: false,
    needsLongContext: false,
    confidence,
  };
  if (/\b(image|picture)\b/.test(t)) {
    return {
      ...base,
      category: 'image_generation',
      subcategory: 'other',
      requirements: ['image_generation'],
      outputModality: 'image',
      reasoningLevel: 'low',
    };
  }
  if (/bug|debug|code/.test(t)) {
    return {
      ...base,
      category: 'coding',
      subcategory: /bug|debug/.test(t) ? 'debugging' : 'implementation',
      requirements: ['code_reasoning'],
      reasoningLevel: 'high',
    };
  }
  if (/summari[sz]e/.test(t)) {
    return { ...base, category: 'summarization', subcategory: 'other', reasoningLevel: 'low' };
  }
  return { ...base, category: 'general', subcategory: 'other', reasoningLevel: 'medium' };
}

function result(opts: ChatCompletionOptions, content: string, completionTokens: number): ChatCompletionResult {
  const promptTokens = Math.max(1, Math.ceil(opts.messages.reduce((n, m) => n + m.content.length, 0) / 4));
  return {
    content,
    finishReason: 'stop',
    model: opts.model,
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    costUsd: 0,
  };
}

/** Deterministic canned responses. No network. Only reachable when AI_MOCK === '1'. */
export async function mockChatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const text = lastUserText(opts);
  if (opts.responseFormat) {
    return result(opts, JSON.stringify(mockClassification(extractTaskText(text))), 60);
  }
  if (getModel(opts.model)?.executorType === 'guard') {
    return result(opts, text.includes('MOCK_UNSAFE') ? 'unsafe\nS1' : 'safe', 3);
  }
  return result(opts, 'Mock answer: this is a canned response generated without calling any AI model.', 25);
}
