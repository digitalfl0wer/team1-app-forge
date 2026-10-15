import { getRegistry } from './modelRegistry';
import { chatCompletion } from './openrouter';

export type GuardVerdict = { verdict: 'safe' | 'unsafe' | 'error'; hazardCodes?: string[] };

export type GuardDeps = { chat?: typeof chatCompletion };

export const MAX_OUTPUT_CHARS = 20_000;
export const TRUNCATION_MARKER = '\n[output truncated]';

export function parseGuardOutput(raw: string): GuardVerdict {
  const lines = raw.trim().split(/\r?\n/);
  const first = lines[0].trim().toLowerCase();
  if (first === 'safe') return { verdict: 'safe' };
  if (first === 'unsafe') {
    const codes = (lines[1] ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter((c) => /^[A-Za-z0-9_-]{1,16}$/.test(c));
    return { verdict: 'unsafe', hazardCodes: codes };
  }
  return { verdict: 'error' };
}

/** Only an 'unsafe' verdict blocks. 'error' means the caller continues. */
export async function checkInputSafety(text: string, deps: GuardDeps = {}): Promise<GuardVerdict> {
  const guard = getRegistry().find((m) => m.executorType === 'guard' && m.approved && m.enabled);
  if (!guard) return { verdict: 'error' };
  const chat = deps.chat ?? chatCompletion;
  try {
    const res = await chat({
      model: guard.id,
      messages: [{ role: 'user', content: text }],
      maxCompletionTokens: 30,
      temperature: 0,
    });
    return parseGuardOutput(res.content);
  } catch {
    // chatCompletion already logged code/status/model.
    return { verdict: 'error' };
  }
}

/** Model output is untrusted: coerce to plain text, strip NULs, cap length. Never interpreted as HTML/Markdown. */
export function sanitizeModelOutput(text: unknown): string {
  let s = typeof text === 'string' ? text : text == null ? '' : String(text);
  s = s.replace(/\0/g, '');
  if (s.length > MAX_OUTPUT_CHARS) s = s.slice(0, MAX_OUTPUT_CHARS) + TRUNCATION_MARKER;
  return s;
}
