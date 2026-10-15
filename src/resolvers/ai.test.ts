import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { sql: string; params: unknown[] };
const calls: Call[] = [];
let handler: (call: Call) => unknown;

vi.mock('@forge/sql', () => ({
  sql: {
    prepare: (statement: string) => ({
      bindParams: (...params: unknown[]) => ({
        execute: async () => {
          const call = { sql: statement.replace(/\s+/g, ' ').trim(), params };
          calls.push(call);
          return handler(call);
        },
      }),
      execute: async () => {
        const call = { sql: statement.replace(/\s+/g, ' ').trim(), params: [] };
        calls.push(call);
        return handler(call);
      },
    }),
  },
}));

import { snapshotEntries } from '../ai/router';
import type { Classification } from '../ai/types';
import {
  chooseCategory,
  confirmRun,
  defaultDeps,
  getAiRuns,
  getModels,
  refreshModels,
  startTask,
  type AiDeps,
} from './ai';

// ---------------------------------------------------------------------------
// In-memory fake of the Todos and AiRuns tables, driven by the SQL the resolvers emit.
// ---------------------------------------------------------------------------

type FakeRun = Record<string, unknown> & { id: string; todo: string; status: string; seq: number };
type FakeTodo = { id: string; description: string; notes: string | null; content_version: number; ai_state: string };

let todos: Map<string, FakeTodo>;
let runs: Map<string, FakeRun>;
let seq: number;
let forceClaimZero = false;

const BASE_RUN = {
  content_version: 1,
  classification: null,
  candidates: null,
  recommended_model: null,
  confirmed_model: null,
  response: null,
  prompt_tokens: null,
  completion_tokens: null,
  cost_usd: null,
  error_code: null,
  created_at: '2026-10-15 10:00:00',
  completed_at: null,
  age_seconds: 5,
};

function addRun(over: Partial<FakeRun> & { todo?: string; status?: string }): FakeRun {
  const id = over.id ?? String(1000 + seq);
  const run = { ...BASE_RUN, todo: '42', status: 'awaiting_confirmation', ...over, id, seq: seq++ } as FakeRun;
  runs.set(id, run);
  return run;
}

const isActiveStatus = (s: string) => s === 'classifying' || s === 'running';

function fakeDb(call: Call): unknown {
  const s = call.sql;
  const p = call.params;
  if (/^SELECT .* FROM Todos WHERE/.test(s)) {
    const t = todos.get(String(p[0]));
    return { rows: t ? [t] : [] };
  }
  if (/^SELECT .* FROM AiRuns WHERE run_id/.test(s)) {
    const r = runs.get(String(p[0]));
    return { rows: r ? [r] : [] };
  }
  if (/^SELECT .* FROM AiRuns WHERE todo_id = CAST\(\? AS SIGNED\) AND status IN \('classifying', 'running'\)$/.test(s)) {
    return { rows: [...runs.values()].filter((r) => r.todo === String(p[0]) && isActiveStatus(r.status)) };
  }
  if (/ORDER BY created_at DESC, run_id DESC/.test(s)) {
    return {
      rows: [...runs.values()].filter((r) => r.todo === String(p[0])).sort((a, b) => b.seq - a.seq),
    };
  }
  if (/^SELECT CAST\(run_id AS CHAR\) AS id FROM AiRuns/.test(s)) {
    const latest = [...runs.values()]
      .filter((r) => r.todo === String(p[0]) && r.status === 'classifying')
      .sort((a, b) => b.seq - a.seq)[0];
    return { rows: latest ? [{ id: latest.id }] : [] };
  }
  if (/^INSERT INTO AiRuns/.test(s)) {
    const todoId = String(p[1]);
    if (!todos.has(todoId) || [...runs.values()].some((r) => r.todo === todoId && isActiveStatus(r.status))) {
      return { rows: { affectedRows: 0 } };
    }
    addRun({ todo: todoId, status: 'classifying', content_version: Number(p[0]), age_seconds: 0 });
    return { rows: { affectedRows: 1 } };
  }
  if (/^UPDATE AiRuns SET status = 'stale', completed_at = CURRENT_TIMESTAMP WHERE todo_id/.test(s)) {
    let n = 0;
    for (const r of runs.values()) {
      if (r.todo === String(p[0]) && r.id !== String(p[1]) && ['awaiting_confirmation', 'needs_clarification'].includes(r.status)) {
        r.status = 'stale';
        n++;
      }
    }
    return { rows: { affectedRows: n } };
  }
  const upd = /^UPDATE AiRuns SET (.+) WHERE run_id = CAST\(\? AS SIGNED\) AND status IN \((.+)\)$/.exec(s);
  if (upd) {
    const assignments = upd[1].split(', ');
    const bound = assignments.filter((a) => a.endsWith('= ?')).length;
    const statusCount = upd[2].split(', ').length;
    const runId = String(p[bound]);
    const from = p.slice(bound + 1, bound + 1 + statusCount) as string[];
    const r = runs.get(runId);
    if (!r || !from.includes(r.status) || forceClaimZero) return { rows: { affectedRows: 0 } };
    let i = 0;
    for (const a of assignments) {
      const col = a.split(' = ')[0];
      r[col] = a.endsWith('CURRENT_TIMESTAMP') ? '2026-10-15 10:05:00' : p[i++];
      if (a.endsWith('CURRENT_TIMESTAMP') && col === 'confirmed_at') r.age_seconds = 0;
    }
    return { rows: { affectedRows: 1 } };
  }
  if (/^UPDATE Todos SET ai_state = \? WHERE/.test(s)) {
    const t = todos.get(String(p[1]));
    if (t && t.content_version === Number(p[2])) {
      t.ai_state = String(p[0]);
      return { rows: { affectedRows: 1 } };
    }
    return { rows: { affectedRows: 0 } };
  }
  if (/^UPDATE Todos SET ai_state = 'failed'/.test(s)) {
    const t = todos.get(String(p[0]));
    if (t && ['classifying', 'running'].includes(t.ai_state)) t.ai_state = 'failed';
    return { rows: { affectedRows: 1 } };
  }
  throw new Error(`unexpected SQL in test: ${s}`);
}

const codingClassification: Classification = {
  category: 'coding',
  subcategory: 'debugging',
  requirements: ['code_reasoning'],
  inputModalities: ['text'],
  outputModality: 'text',
  reasoningLevel: 'high',
  needsTools: false,
  needsLongContext: false,
  confidence: 0.9,
};

function makeDeps(over: Partial<AiDeps> = {}): AiDeps & {
  guard: ReturnType<typeof vi.fn>;
  classify: ReturnType<typeof vi.fn>;
  worker: ReturnType<typeof vi.fn>;
  loadEntries: ReturnType<typeof vi.fn>;
} {
  return {
    guard: vi.fn(async () => ({ verdict: 'safe' as const })),
    classify: vi.fn(async () => ({
      ok: true as const,
      classification: codingClassification,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      costUsd: 0,
    })),
    worker: vi.fn(async () => ({
      ok: true as const,
      text: 'Here is the answer',
      usage: { promptTokens: 11, completionTokens: 22 },
      costUsd: 0.0034,
    })),
    loadEntries: vi.fn(async () => ({ entries: snapshotEntries(), fetchedAt: null, source: 'snapshot' as const })),
    ...over,
  } as never;
}

const missingTable = Object.assign(new Error('Unknown SQL execution error'), {
  context: { debug: { code: 'ER_NO_SUCH_TABLE', errno: 1146, sqlMessage: "Table 'AiRuns' doesn't exist" } },
});

beforeEach(() => {
  calls.length = 0;
  seq = 1;
  forceClaimZero = false;
  todos = new Map([['42', { id: '42', description: 'Fix the login bug', notes: 'stack trace attached', content_version: 1, ai_state: 'not_started' }]]);
  runs = new Map();
  handler = fakeDb;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const run = (r: unknown) => (r as { run: import('./ai').AiRun }).run;
const state = () => todos.get('42')?.ai_state;

async function awaitingRun(deps = makeDeps()) {
  const r = await startTask({ todoId: '42' }, deps);
  expect(r).toMatchObject({ success: true });
  return run(r);
}

// ---------------------------------------------------------------------------

describe('startTask', () => {
  it('happy path (injected deps): persists a recommendation and mirrors ai_state', async () => {
    const deps = makeDeps();
    const r = await startTask({ todoId: '42' }, deps);
    expect(r.success).toBe(true);
    const out = run(r);
    expect(out.status).toBe('awaiting_confirmation');
    expect(out.category).toBe('coding');
    expect(out.contentVersion).toBe(1);
    expect(out.candidates.length).toBeGreaterThan(0);
    expect(out.recommendedModelId).toBe(out.candidates[0].modelId);
    expect(out.candidates[0]).toMatchObject({ pricingUrl: expect.stringMatching(/^https:\/\/openrouter\.ai\//) });
    expect(out.candidates[0].priceLabel).toMatch(/per 1M tokens|Price unavailable/);
    expect(out.outputCapTokens).toBe(2500);
    expect(out.estimatedInputTokens).toBeGreaterThan(0);
    expect(out.reason).toBeTruthy();
    expect(out.pricingUrls).toEqual({
      general: 'https://openrouter.ai/models',
      recommendedModel: `https://openrouter.ai/${out.recommendedModelId}`,
    });
    expect(state()).toBe('awaiting_confirmation');
    expect(deps.worker).not.toHaveBeenCalled();
    expect(deps.guard).toHaveBeenCalledTimes(1);
    // Every statement uses bound params: no payload text in SQL.
    for (const c of calls) expect(c.sql).not.toContain('Fix the login bug');
  });

  it('mock mode: no network, snapshot catalog, real mock guard/classifier', async () => {
    vi.stubEnv('AI_MOCK', '1');
    const store = vi.fn();
    expect(await defaultDeps.loadEntries({})).toMatchObject({ source: 'snapshot', fetchedAt: null });
    expect(store).not.toHaveBeenCalled();
    const r = await startTask({ todoId: '42' }); // defaultDeps
    expect(r).toMatchObject({ success: true });
    expect(run(r).status).toBe('awaiting_confirmation');
    expect(run(r).category).toBe('coding'); // 'bug' in the task text
    const c = await confirmRun({ runId: run(r).id, modelId: run(r).recommendedModelId });
    expect(run(c).status).toBe('succeeded');
    expect(run(c).response).toMatch(/^Mock answer/);
  });

  it('blocked_by_guard: no classification, no worker, ai_state back to not_started', async () => {
    const deps = makeDeps({ guard: vi.fn(async () => ({ verdict: 'unsafe' as const, hazardCodes: ['S1'] })) });
    const r = await startTask({ todoId: '42' }, deps);
    expect(r.success).toBe(true);
    expect(run(r)).toMatchObject({ status: 'blocked_by_guard', errorCode: 'BLOCKED_BY_GUARD', candidates: [], category: null });
    expect(run(r).message).toMatch(/safety check/);
    expect(deps.classify).not.toHaveBeenCalled();
    expect(deps.worker).not.toHaveBeenCalled();
    expect(state()).toBe('not_started');
  });

  it('guard error is logged and the flow continues', async () => {
    const deps = makeDeps({ guard: vi.fn(async () => ({ verdict: 'error' as const })) });
    const out = run(await startTask({ todoId: '42' }, deps));
    expect(out.status).toBe('awaiting_confirmation');
    expect(deps.classify).toHaveBeenCalled();
  });

  it('classifier needs_clarification becomes a persisted run', async () => {
    const deps = makeDeps({
      classify: vi.fn(async () => ({ ok: false as const, kind: 'needs_clarification' as const, code: 'NEEDS_CLARIFICATION', message: 'pick' })),
    });
    const out = run(await startTask({ todoId: '42' }, deps));
    expect(out).toMatchObject({ status: 'needs_clarification', errorCode: 'NEEDS_CLARIFICATION', candidates: [] });
    expect(state()).toBe('not_started');
  });

  it('low router confidence becomes needs_clarification with the detected category', async () => {
    const deps = makeDeps({
      classify: vi.fn(async () => ({
        ok: true as const,
        classification: { ...codingClassification, confidence: 0.3 },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        costUsd: null,
      })),
    });
    const out = run(await startTask({ todoId: '42' }, deps));
    expect(out).toMatchObject({ status: 'needs_clarification', category: 'coding' });
    expect(state()).toBe('not_started');
  });

  it('classifier provider failure persists a failed run (success:true) and ai_state failed', async () => {
    const deps = makeDeps({
      classify: vi.fn(async () => ({ ok: false as const, kind: 'error' as const, code: 'RATE_LIMITED', message: 'The AI service is busy. Try again shortly.' })),
    });
    const r = await startTask({ todoId: '42' }, deps);
    expect(r.success).toBe(true);
    expect(run(r)).toMatchObject({ status: 'failed', errorCode: 'RATE_LIMITED', message: 'The AI service is busy. Try again shortly.' });
    expect(state()).toBe('failed');
    expect(todos.get('42')?.description).toBe('Fix the login bug');
  });

  it('unknown classifier error codes are normalised', async () => {
    const deps = makeDeps({
      classify: vi.fn(async () => ({ ok: false as const, kind: 'error' as const, code: 'weird', message: 'x' })),
    });
    expect(run(await startTask({ todoId: '42' }, deps)).errorCode).toBe('PROVIDER_ERROR');
  });

  it('no_eligible_model is a persisted run', async () => {
    const deps = makeDeps({
      classify: vi.fn(async () => ({
        ok: true as const,
        classification: { ...codingClassification, category: 'image_generation' as const, subcategory: 'other', outputModality: 'image' as const },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        costUsd: null,
      })),
    });
    const out = run(await startTask({ todoId: '42' }, deps));
    expect(out).toMatchObject({ status: 'no_eligible_model', errorCode: 'NO_ELIGIBLE_MODEL', candidates: [], recommendedModelId: null });
    expect(out.pricingUrls).toEqual({ general: 'https://openrouter.ai/models', recommendedModel: null });
    expect(state()).toBe('not_started');
  });

  it('rejects when a run is already active (under 2 minutes)', async () => {
    addRun({ status: 'running', age_seconds: 30 });
    const deps = makeDeps();
    expect(await startTask({ todoId: '42' }, deps)).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
    expect(deps.guard).not.toHaveBeenCalled();
    addRun({ status: 'classifying', age_seconds: 5, todo: '42' });
    expect(await startTask({ todoId: '42' }, deps)).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
  });

  it('rejects when the atomic insert guard loses a race', async () => {
    const original = handler;
    handler = (c) => (/^INSERT INTO AiRuns/.test(c.sql) ? { rows: { affectedRows: 0 } } : original(c));
    expect(await startTask({ todoId: '42' }, makeDeps())).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
  });

  it('a stuck run (over 2 minutes) is failed with TIMEOUT and does not block', async () => {
    const stuck = addRun({ status: 'running', age_seconds: 500 });
    const out = run(await startTask({ todoId: '42' }, makeDeps()));
    expect(out.status).toBe('awaiting_confirmation');
    expect(runs.get(stuck.id)).toMatchObject({ status: 'failed', error_code: 'TIMEOUT' });
  });

  it('supersedes older pending runs', async () => {
    const old = addRun({ status: 'awaiting_confirmation' });
    await awaitingRun();
    expect(runs.get(old.id)?.status).toBe('stale');
  });

  it('validates input and handles a missing Todo', async () => {
    expect(await startTask({ todoId: 42 }, makeDeps())).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
    expect(await startTask({ todoId: '1', extra: 1 }, makeDeps())).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
    expect(await startTask(undefined, makeDeps())).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
    expect(await startTask({ todoId: '999' }, makeDeps())).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    expect(calls.some((c) => c.sql.startsWith('INSERT'))).toBe(false);
  });

  it('an unexpected pipeline error ends as a failed INTERNAL run with a safe message', async () => {
    const deps = makeDeps({ classify: vi.fn(async () => { throw new Error('SELECT secret FROM boom'); }) });
    const out = run(await startTask({ todoId: '42' }, deps));
    expect(out).toMatchObject({ status: 'failed', errorCode: 'INTERNAL', message: 'Something went wrong. Please try again.' });
    expect(state()).toBe('failed');
  });
});

describe('chooseCategory', () => {
  async function clarificationRun() {
    const deps = makeDeps({
      classify: vi.fn(async () => ({ ok: false as const, kind: 'needs_clarification' as const, code: 'NEEDS_CLARIFICATION', message: 'pick' })),
    });
    return run(await startTask({ todoId: '42' }, deps));
  }

  it('continues routing with a synthetic classification', async () => {
    const r0 = await clarificationRun();
    const deps = makeDeps();
    const r = await chooseCategory({ runId: r0.id, category: 'writing' }, deps);
    expect(r.success).toBe(true);
    expect(run(r)).toMatchObject({ id: r0.id, status: 'awaiting_confirmation', category: 'writing' });
    expect(run(r).candidates.length).toBeGreaterThan(0);
    expect(state()).toBe('awaiting_confirmation');
    expect(deps.classify).not.toHaveBeenCalled();
    expect(deps.guard).not.toHaveBeenCalled();
    expect(runs.get(r0.id)?.error_code).toBeNull();
  });

  it('rejects categories outside the enum, bad ids and unknown keys', async () => {
    for (const payload of [{ runId: '1', category: 'hacking' }, { runId: 'x', category: 'coding' }, { runId: '1', category: 'coding', z: 1 }, {}]) {
      expect(await chooseCategory(payload, makeDeps())).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
    }
  });

  it('only works for needs_clarification runs and unknown runs are NOT_FOUND', async () => {
    const rec = await awaitingRun();
    expect(await chooseCategory({ runId: rec.id, category: 'coding' }, makeDeps())).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
    expect(await chooseCategory({ runId: '987', category: 'coding' }, makeDeps())).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
  });

  it('a lost claim is rejected', async () => {
    const r0 = await clarificationRun();
    forceClaimZero = true;
    const deps = makeDeps();
    expect(await chooseCategory({ runId: r0.id, category: 'coding' }, deps)).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
    expect(deps.loadEntries).not.toHaveBeenCalled();
  });

  it('stale content marks the run stale', async () => {
    const r0 = await clarificationRun();
    todos.get('42')!.content_version = 2;
    expect(await chooseCategory({ runId: r0.id, category: 'coding' }, makeDeps())).toMatchObject({ success: false, error: { code: 'STALE_CONTENT' } });
    expect(runs.get(r0.id)?.status).toBe('stale');
  });
});

describe('confirmRun', () => {
  it('happy path: claims, executes once, stores response, usage and cost', async () => {
    const deps = makeDeps();
    const rec = await awaitingRun(deps);
    const r = await confirmRun({ runId: rec.id, modelId: rec.recommendedModelId }, deps);
    expect(r.success).toBe(true);
    expect(run(r)).toMatchObject({
      status: 'succeeded',
      response: 'Here is the answer',
      usage: { promptTokens: 11, completionTokens: 22 },
      costUsd: 0.0034,
      confirmedModelId: rec.recommendedModelId,
      errorCode: null,
    });
    expect(run(r).completedAt).toBeTruthy();
    expect(deps.worker).toHaveBeenCalledTimes(1);
    expect(deps.worker).toHaveBeenCalledWith({ modelId: rec.recommendedModelId, description: 'Fix the login bug', notes: 'stack trace attached' });
    expect(state()).toBe('succeeded');
  });

  it('double confirm: the second call is rejected and the worker ran once', async () => {
    const deps = makeDeps();
    const rec = await awaitingRun(deps);
    const payload = { runId: rec.id, modelId: rec.recommendedModelId };
    const [a, b] = await Promise.all([confirmRun(payload, deps), confirmRun(payload, deps)]);
    const results = [a, b];
    expect(results.filter((x) => x.success)).toHaveLength(1);
    expect(results.find((x) => !x.success)).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(deps.worker).toHaveBeenCalledTimes(1);
  });

  it('a lost atomic claim (affectedRows 0) is rejected without calling the worker', async () => {
    const deps = makeDeps();
    const rec = await awaitingRun(deps);
    forceClaimZero = true;
    expect(await confirmRun({ runId: rec.id, modelId: rec.recommendedModelId }, deps)).toMatchObject({
      success: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(deps.worker).not.toHaveBeenCalled();
  });

  it('rejects a model that is not in the stored candidates', async () => {
    const deps = makeDeps();
    const rec = await awaitingRun(deps);
    for (const modelId of ['evil/model', 'meta-llama/llama-guard-4-12b']) {
      expect(await confirmRun({ runId: rec.id, modelId }, deps)).toMatchObject({ success: false, error: { code: 'NOT_ALLOWED_MODEL' } });
    }
    expect(deps.worker).not.toHaveBeenCalled();
    expect(runs.get(rec.id)?.status).toBe('awaiting_confirmation');
  });

  it('rejects a stored candidate that is no longer approved or enabled', async () => {
    const deps = makeDeps();
    const rec = await awaitingRun(deps);
    const r = runs.get(rec.id)!;
    const stored = JSON.parse(String(r.candidates));
    stored.candidates[0].modelId = 'removed/model';
    r.candidates = JSON.stringify(stored);
    expect(await confirmRun({ runId: rec.id, modelId: 'removed/model' }, deps)).toMatchObject({ success: false, error: { code: 'NOT_ALLOWED_MODEL' } });
  });

  it('stale content version: STALE_CONTENT, run marked stale, no worker', async () => {
    const deps = makeDeps();
    const rec = await awaitingRun(deps);
    todos.get('42')!.content_version = 2;
    expect(await confirmRun({ runId: rec.id, modelId: rec.recommendedModelId }, deps)).toMatchObject({ success: false, error: { code: 'STALE_CONTENT' } });
    expect(runs.get(rec.id)?.status).toBe('stale');
    expect(deps.worker).not.toHaveBeenCalled();
  });

  it('provider failure: failed run (success:true), Todo content untouched', async () => {
    const deps = makeDeps({ worker: vi.fn(async () => ({ ok: false as const, code: 'TIMEOUT' as const, message: 'The AI request timed out. Try again.' })) });
    const rec = await awaitingRun(deps);
    const r = await confirmRun({ runId: rec.id, modelId: rec.recommendedModelId }, deps);
    expect(r.success).toBe(true);
    expect(run(r)).toMatchObject({ status: 'failed', errorCode: 'TIMEOUT', message: 'The AI request timed out. Try again.', response: null, usage: null });
    expect(state()).toBe('failed');
    expect(todos.get('42')).toMatchObject({ description: 'Fix the login bug', notes: 'stack trace attached', content_version: 1 });
    expect(calls.filter((c) => /Todos/.test(c.sql) && /^(UPDATE|DELETE)/.test(c.sql) && !/ai_state/.test(c.sql))).toHaveLength(0);
  });

  it('a throwing worker also ends as a safe failed run', async () => {
    const deps = makeDeps({ worker: vi.fn(async () => { throw new Error('raw provider text'); }) });
    const rec = await awaitingRun(deps);
    const out = run(await confirmRun({ runId: rec.id, modelId: rec.recommendedModelId }, deps));
    expect(out).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_ERROR', message: 'The AI request failed.' });
  });

  it('only awaiting_confirmation runs can be confirmed', async () => {
    const deps = makeDeps();
    const r = addRun({ status: 'succeeded' });
    expect(await confirmRun({ runId: r.id, modelId: 'x' }, deps)).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
    expect(await confirmRun({ runId: '555', modelId: 'x' }, deps)).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
  });

  it('validates the payload', async () => {
    for (const payload of [{ runId: '1' }, { runId: '1', modelId: '' }, { runId: '1', modelId: 'm'.repeat(101) }, { runId: 'abc', modelId: 'm' }, { runId: '1', modelId: 'm', extra: true }]) {
      expect(await confirmRun(payload, makeDeps())).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
    }
  });
});

describe('getAiRuns', () => {
  it('returns newest first', async () => {
    addRun({ id: '1', status: 'failed', error_code: 'PROVIDER_ERROR' });
    addRun({ id: '2', status: 'succeeded', response: 'ok' });
    addRun({ id: '3', status: 'stale', todo: '77' });
    const r = await getAiRuns({ todoId: '42' });
    expect(r).toMatchObject({ success: true });
    expect((r as { runs: { id: string }[] }).runs.map((x) => x.id)).toEqual(['2', '1']);
  });

  it('reports and persists a stuck running run as failed TIMEOUT', async () => {
    const stuck = addRun({ status: 'running', age_seconds: 121 });
    const fresh = addRun({ status: 'classifying', age_seconds: 119 });
    todos.get('42')!.ai_state = 'running';
    const { runs: out } = (await getAiRuns({ todoId: '42' })) as { runs: import('./ai').AiRun[] };
    const byId = new Map(out.map((x) => [x.id, x]));
    expect(byId.get(stuck.id)).toMatchObject({ status: 'failed', errorCode: 'TIMEOUT' });
    expect(byId.get(stuck.id)?.message).toMatch(/too long/);
    expect(byId.get(fresh.id)?.status).toBe('classifying');
    expect(runs.get(stuck.id)).toMatchObject({ status: 'failed', error_code: 'TIMEOUT' });
    expect(state()).toBe('failed');
  });

  it('tolerates corrupt JSON columns and bad values', async () => {
    addRun({
      id: '9',
      classification: '{not json',
      candidates: '[1, "x", {"modelId": 5}]',
      status: 'awaiting_confirmation',
      cost_usd: 'abc',
      prompt_tokens: 'x',
      created_at: new Date('2026-10-15T10:00:00Z'),
    });
    addRun({ id: '10', classification: '"str"', candidates: '{"candidates": "nope"}', status: 'weird' });
    const r = (await getAiRuns({ todoId: '42' })) as { success: true; runs: import('./ai').AiRun[] };
    expect(r.success).toBe(true);
    const nine = r.runs.find((x) => x.id === '9')!;
    expect(nine).toMatchObject({ candidates: [], category: null, costUsd: null, usage: null, createdAt: '2026-10-15T10:00:00.000Z' });
    expect(r.runs.find((x) => x.id === '10')).toMatchObject({ status: 'failed', candidates: [] });
  });

  it('reads the DECIMAL cost and token columns as numbers', async () => {
    addRun({ id: '5', status: 'succeeded', cost_usd: '0.00340000', prompt_tokens: 3, completion_tokens: '4' });
    const { runs: out } = (await getAiRuns({ todoId: '42' })) as { runs: import('./ai').AiRun[] };
    expect(out[0]).toMatchObject({ costUsd: 0.0034, usage: { promptTokens: 3, completionTokens: 4 } });
  });

  it('validates the payload', async () => {
    expect(await getAiRuns({ todoId: 'x' })).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
  });
});

describe('getModels / refreshModels', () => {
  it('returns the table, source and fetchedAt', async () => {
    const deps = makeDeps({
      loadEntries: vi.fn(async () => ({ entries: snapshotEntries(), fetchedAt: '2026-10-15T00:00:00.000Z', source: 'cache' as const })),
    });
    const r = await getModels(deps);
    expect(r).toMatchObject({ success: true, source: 'cache', fetchedAt: '2026-10-15T00:00:00.000Z' });
    expect((r as { models: unknown[] }).models.length).toBe(snapshotEntries().length);
    expect(deps.loadEntries).toHaveBeenCalledWith({ forceRefresh: false });
    expect(r).not.toHaveProperty('error');
  });

  it('refreshModels forces a refresh', async () => {
    const deps = makeDeps();
    await refreshModels(deps);
    expect(deps.loadEntries).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it('falls back to a generic message instead of raw provider text', async () => {
    const deps = makeDeps({
      loadEntries: vi.fn(async () => ({ entries: snapshotEntries(), fetchedAt: null, source: 'snapshot' as const, error: 'OpenRouter model list returned HTTP 500: secret' })),
    });
    const r = (await getModels(deps)) as { source: string; error: string };
    expect(r.source).toBe('snapshot');
    expect(r.error).toMatch(/unavailable/);
    expect(r.error).not.toMatch(/500|secret/);
  });

  it('survives a throwing loader with the snapshot', async () => {
    const deps = makeDeps({ loadEntries: vi.fn(async () => { throw new Error('boom'); }) });
    expect(await refreshModels(deps)).toMatchObject({ success: true, source: 'snapshot', fetchedAt: null });
  });

  it('mock mode never touches the network or SQL', async () => {
    vi.stubEnv('AI_MOCK', '1');
    expect(await getModels(defaultDeps)).toMatchObject({ success: true, source: 'snapshot' });
    expect(calls).toHaveLength(0);
  });
});

describe('error handling', () => {
  it('missing table gives the updating-database message', async () => {
    handler = (c) => {
      if (/AiRuns/.test(c.sql)) throw missingTable;
      return fakeDb(c);
    };
    for (const r of [
      await startTask({ todoId: '42' }, makeDeps()),
      await getAiRuns({ todoId: '42' }),
      await confirmRun({ runId: '1', modelId: 'm' }, makeDeps()),
      await chooseCategory({ runId: '1', category: 'coding' }, makeDeps()),
    ]) {
      expect(r).toMatchObject({ success: false, error: { code: 'INTERNAL' } });
      expect((r as { error: { message: string } }).error.message).toMatch(/still updating its database/);
    }
  });

  it('other SQL failures never leak raw SQL', async () => {
    handler = () => {
      throw new Error("You have an error in your SQL syntax near 'SELECT secret_column FROM AiRuns'");
    };
    const r = await getAiRuns({ todoId: '42' });
    expect(r).toEqual({ success: false, error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
    expect(JSON.stringify(r)).not.toMatch(/SELECT|syntax/);
  });

  it('never logs prompts or responses', async () => {
    const spy = vi.spyOn(console, 'error');
    const deps = makeDeps({ worker: vi.fn(async () => ({ ok: false as const, code: 'PROVIDER_ERROR' as const, message: 'm' })) });
    const rec = await awaitingRun(deps);
    await confirmRun({ runId: rec.id, modelId: rec.recommendedModelId }, deps);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain('Fix the login bug');
    expect(logged).not.toContain('stack trace');
  });
});
