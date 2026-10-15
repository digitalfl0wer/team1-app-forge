import { sql, type UpdateQueryResponse } from '@forge/sql';
import { sqlCatalogStore } from '../ai/catalogStore';
import { runWorker } from '../ai/executor';
import { checkInputSafety } from '../ai/guardrails';
import { classifyTask } from '../ai/classifier';
import { getModelEntries, toModelsTable, type ModelEntriesResult, type ModelsTableRow } from '../ai/modelCatalog';
import { MODELS_PRICING_URL, SNAPSHOT_DATE, isApprovedAndEnabled, modelPricingUrl } from '../ai/modelRegistry';
import { route, snapshotEntries } from '../ai/router';
import { CATEGORIES, type Candidate, type Category, type Classification, type MetadataSource } from '../ai/types';
import { sqlErrorText } from './todos';
import {
  chooseCategorySchema,
  confirmRunSchema,
  fail,
  getAiRunsSchema,
  parsePayload,
  startTaskSchema,
  type ErrorCode,
  type ErrorResult,
} from './validation';
import { z } from 'zod';

// @types/node is not installed; Forge runtime provides process.env.
declare const process: { env: Record<string, string | undefined> };

// ---------------------------------------------------------------------------
// Public shapes (pinned in docs/ai/api-contract.md)
// ---------------------------------------------------------------------------

export type AiRunStatus =
  | 'classifying'
  | 'awaiting_confirmation'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'stale'
  | 'needs_clarification'
  | 'blocked_by_guard'
  | 'no_eligible_model';

export type AiCandidate = {
  modelId: string;
  displayName: string;
  routingTier: string;
  score: number;
  estimatedMaxCostUsd: number | null;
  inputPerMillionUsd: number | null;
  outputPerMillionUsd: number | null;
  priceLabel: string;
  contextLength: number | null;
  capabilities: { structuredOutputs: boolean; tools: boolean; vision: boolean; longContext: boolean };
  metadataSource: MetadataSource;
  pricingUrl: string;
  reason: string;
};

export type AiRun = {
  id: string;
  todoId: string;
  status: AiRunStatus;
  contentVersion: number;
  category: string | null;
  recommendedModelId: string | null;
  candidates: AiCandidate[];
  cheaperAlternativeModelId: string | null;
  strongerAlternativeModelId: string | null;
  reason: string | null;
  estimatedInputTokens: number | null;
  outputCapTokens: number | null;
  confirmedModelId: string | null;
  response: string | null;
  usage: { promptTokens: number; completionTokens: number } | null;
  costUsd: number | null;
  errorCode: string | null;
  message: string | null;
  pricingUrls: { general: string; recommendedModel: string | null };
  createdAt: string;
  completedAt: string | null;
};

export type ModelsResult = {
  success: true;
  models: ModelsTableRow[];
  fetchedAt: string | null;
  source: MetadataSource;
  error?: string;
};

type RunResult = { success: true; run: AiRun } | ErrorResult;

/** Injectable collaborators (tests). Production uses defaultDeps. */
export type AiDeps = {
  guard: typeof checkInputSafety;
  classify: typeof classifyTask;
  worker: typeof runWorker;
  loadEntries: (opts: { forceRefresh?: boolean }) => Promise<ModelEntriesResult>;
};

export const defaultDeps: AiDeps = {
  guard: checkInputSafety,
  classify: classifyTask,
  worker: runWorker,
  loadEntries: async ({ forceRefresh }) => {
    // AI_MOCK=1: no network at all (not even the model list); use the committed snapshot.
    if (process.env.AI_MOCK === '1') return { entries: snapshotEntries(), fetchedAt: null, source: 'snapshot' };
    return getModelEntries({ store: sqlCatalogStore, forceRefresh });
  },
};

// ---------------------------------------------------------------------------
// Constants and messages
// ---------------------------------------------------------------------------

/** A run in classifying/running longer than this is reported (and persisted) as failed/TIMEOUT. */
export const STUCK_AFTER_SECONDS = 120;

const MIGRATING_MESSAGE = 'The app is still updating its database. Please try again in a few minutes.';
const INTERNAL_MESSAGE = 'Something went wrong. Please try again.';
const ALREADY_RUNNING_MESSAGE = 'An AI run is already in progress for this task. Please wait for it to finish.';
const BLOCKED_MESSAGE = 'This task was blocked by the safety check and was not sent to any AI model.';
const TIMEOUT_MESSAGE = 'The AI run took too long and was stopped. You can try again.';
const FAILED_MESSAGE = 'The AI run failed. You can try again.';
const CLARIFY_MESSAGE = 'Please pick a category so routing can continue.';
const MODELS_FALLBACK_ERROR = 'Live model data is unavailable. Showing the last known data.';

const STATUSES: readonly AiRunStatus[] = [
  'classifying',
  'awaiting_confirmation',
  'running',
  'succeeded',
  'failed',
  'stale',
  'needs_clarification',
  'blocked_by_guard',
  'no_eligible_model',
];
const TERMINAL: readonly AiRunStatus[] = ['succeeded', 'failed', 'stale', 'blocked_by_guard', 'no_eligible_model'];
const CLASSIFIER_CODES: readonly ErrorCode[] = [
  'INVALID_INPUT',
  'PROVIDER_ERROR',
  'TIMEOUT',
  'RATE_LIMITED',
  'INSUFFICIENT_CREDIT',
];

type AiState = 'not_started' | 'classifying' | 'awaiting_confirmation' | 'running' | 'succeeded' | 'failed';

const aiStateFor = (status: AiRunStatus): AiState =>
  status === 'classifying' ||
  status === 'awaiting_confirmation' ||
  status === 'running' ||
  status === 'succeeded' ||
  status === 'failed'
    ? status
    : 'not_started';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function isMissingSchemaError(error: unknown): boolean {
  return /doesn't exist|does not exist|no such table|ER_NO_SUCH_TABLE|unknown column|ER_BAD_FIELD_ERROR|\b1146\b|\b1054\b/i.test(
    sqlErrorText(error),
  );
}

function aiInternalError(operation: string, error: unknown): ErrorResult {
  if (isMissingSchemaError(error)) {
    console.error(`[ai] ${operation} failed: database schema is not migrated yet`);
    return fail('INTERNAL', MIGRATING_MESSAGE);
  }
  // Only the operation name: never SQL text, prompts, keys or responses.
  console.error(`[ai] ${operation} failed`);
  return fail('INTERNAL', INTERNAL_MESSAGE);
}

// ---------------------------------------------------------------------------
// Stored JSON (defensive parsing: corrupt columns never crash a resolver)
// ---------------------------------------------------------------------------

const candidateSchema = z.object({
  modelId: z.string(),
  displayName: z.string(),
  routingTier: z.string(),
  score: z.number(),
  estimatedMaxCostUsd: z.number().nullable(),
  inputPerMillionUsd: z.number().nullable(),
  outputPerMillionUsd: z.number().nullable(),
  priceLabel: z.string(),
  contextLength: z.number().nullable(),
  capabilities: z.object({
    structuredOutputs: z.boolean(),
    tools: z.boolean(),
    vision: z.boolean(),
    longContext: z.boolean(),
  }),
  metadataSource: z.enum(['live', 'cache', 'snapshot']),
  pricingUrl: z.string(),
  reason: z.string(),
});

/** Stored in AiRuns.classification. */
type Meta = { category: string | null; classification: Classification | null; message: string | null };
const metaSchema = z.object({
  category: z.string().nullish(),
  classification: z.unknown().optional(),
  message: z.string().nullish(),
});

/** Stored in AiRuns.candidates. */
type Details = {
  candidates: AiCandidate[];
  cheaperAlternativeModelId: string | null;
  strongerAlternativeModelId: string | null;
  reason: string | null;
  estimatedInputTokens: number | null;
  outputCapTokens: number | null;
};
const detailsSchema = z.object({
  candidates: z.array(z.unknown()),
  cheaperAlternativeModelId: z.string().nullish(),
  strongerAlternativeModelId: z.string().nullish(),
  reason: z.string().nullish(),
  estimatedInputTokens: z.number().nullish(),
  outputCapTokens: z.number().nullish(),
});

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string' || text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readMeta(text: unknown): Meta {
  const parsed = metaSchema.safeParse(parseJson(text));
  const empty: Meta = { category: null, classification: null, message: null };
  if (!parsed.success) return empty;
  const category = parsed.data.category;
  return {
    category: typeof category === 'string' && (CATEGORIES as readonly string[]).includes(category) ? category : null,
    classification: (parsed.data.classification as Classification | undefined) ?? null,
    message: parsed.data.message ?? null,
  };
}

function readDetails(text: unknown): Details {
  const json = parseJson(text);
  const parsed = detailsSchema.safeParse(Array.isArray(json) ? { candidates: json } : json);
  const empty: Details = {
    candidates: [],
    cheaperAlternativeModelId: null,
    strongerAlternativeModelId: null,
    reason: null,
    estimatedInputTokens: null,
    outputCapTokens: null,
  };
  if (!parsed.success) return empty;
  const d = parsed.data;
  const candidates: AiCandidate[] = [];
  for (const item of d.candidates) {
    const c = candidateSchema.safeParse(item);
    if (c.success) candidates.push(c.data);
  }
  return {
    candidates,
    cheaperAlternativeModelId: d.cheaperAlternativeModelId ?? null,
    strongerAlternativeModelId: d.strongerAlternativeModelId ?? null,
    reason: d.reason ?? null,
    estimatedInputTokens: d.estimatedInputTokens ?? null,
    outputCapTokens: d.outputCapTokens ?? null,
  };
}

function priceLabel(c: Candidate): string {
  if (c.inputPerMillionUsd === null || c.outputPerMillionUsd === null) return 'Price unavailable';
  const rates = `$${c.inputPerMillionUsd} in / $${c.outputPerMillionUsd} out per 1M tokens`;
  return c.metadataSource === 'snapshot' ? `Last known price (${SNAPSHOT_DATE}): ${rates}` : rates;
}

function toAiCandidate(c: Candidate): AiCandidate {
  return {
    modelId: c.modelId,
    displayName: c.displayName,
    routingTier: c.routingTier,
    score: c.score,
    estimatedMaxCostUsd: c.estimatedMaxCostUsd,
    inputPerMillionUsd: c.inputPerMillionUsd,
    outputPerMillionUsd: c.outputPerMillionUsd,
    priceLabel: priceLabel(c),
    contextLength: c.contextLength,
    capabilities: { ...c.capabilities },
    metadataSource: c.metadataSource,
    pricingUrl: c.pricingUrl,
    reason: c.reason,
  };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type RunRow = {
  id: string;
  todo: string;
  content_version: number | string;
  status: string;
  classification: string | null;
  candidates: string | null;
  recommended_model: string | null;
  confirmed_model: string | null;
  response: string | null;
  prompt_tokens: number | string | null;
  completion_tokens: number | string | null;
  cost_usd: number | string | null;
  error_code: string | null;
  created_at: string | Date;
  completed_at: string | Date | null;
  age_seconds: number | string | null;
};

// "confirmed_at" doubles as "last claimed at" (confirm or chooseCategory), so the 2-minute
// stuck check measures the current phase, not the whole life of the run.
const RUN_COLUMNS = `CAST(run_id AS CHAR) AS id, CAST(todo_id AS CHAR) AS todo, content_version, status, classification, candidates, recommended_model, confirmed_model, response, prompt_tokens, completion_tokens, cost_usd, error_code, created_at, completed_at, TIMESTAMPDIFF(SECOND, COALESCE(confirmed_at, created_at), CURRENT_TIMESTAMP) AS age_seconds`;

type TodoRow = { id: string; description: string; notes: string | null; content_version: number | string };

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : String(v));
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function toAiRun(row: RunRow): AiRun {
  const meta = readMeta(row.classification);
  const details = readDetails(row.candidates);
  const status = (STATUSES as readonly string[]).includes(row.status) ? (row.status as AiRunStatus) : 'failed';
  const prompt = numOrNull(row.prompt_tokens);
  const completion = numOrNull(row.completion_tokens);
  const errorCode = row.error_code ?? null;
  let message = meta.message;
  if (!message) {
    if (errorCode === 'TIMEOUT') message = TIMEOUT_MESSAGE;
    else if (status === 'failed') message = FAILED_MESSAGE;
    else if (status === 'blocked_by_guard') message = BLOCKED_MESSAGE;
    else if (status === 'needs_clarification') message = CLARIFY_MESSAGE;
  }
  return {
    id: row.id,
    todoId: row.todo,
    status,
    contentVersion: numOrNull(row.content_version) ?? 0,
    category: meta.category,
    recommendedModelId: row.recommended_model ?? null,
    candidates: details.candidates,
    cheaperAlternativeModelId: details.cheaperAlternativeModelId,
    strongerAlternativeModelId: details.strongerAlternativeModelId,
    reason: details.reason,
    estimatedInputTokens: details.estimatedInputTokens,
    outputCapTokens: details.outputCapTokens,
    confirmedModelId: row.confirmed_model ?? null,
    response: row.response ?? null,
    usage: prompt !== null && completion !== null ? { promptTokens: prompt, completionTokens: completion } : null,
    costUsd: numOrNull(row.cost_usd),
    errorCode,
    message,
    pricingUrls: {
      general: MODELS_PRICING_URL,
      recommendedModel: row.recommended_model ? modelPricingUrl(row.recommended_model) : null,
    },
    createdAt: iso(row.created_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
  };
}

async function loadRunRow(runId: string): Promise<RunRow | null> {
  const result = await sql
    .prepare<RunRow>(`SELECT ${RUN_COLUMNS} FROM AiRuns WHERE run_id = CAST(? AS SIGNED)`)
    .bindParams(runId)
    .execute();
  return result.rows[0] ?? null;
}

async function loadTodo(todoId: string): Promise<TodoRow | null> {
  const result = await sql
    .prepare<TodoRow>(
      'SELECT CAST(todo_id AS CHAR) AS id, description, notes, content_version FROM Todos WHERE todo_id = CAST(? AS SIGNED)',
    )
    .bindParams(todoId)
    .execute();
  return result.rows[0] ?? null;
}

const NOW = Symbol('now');
type RunColumn =
  | 'status'
  | 'classification'
  | 'candidates'
  | 'recommended_model'
  | 'confirmed_model'
  | 'response'
  | 'prompt_tokens'
  | 'completion_tokens'
  | 'cost_usd'
  | 'error_code'
  | 'confirmed_at'
  | 'completed_at';
type SetValue = string | number | null | typeof NOW;

/** Guarded update: only applies while the run is still in one of `from`. True when exactly one row changed. */
async function updateRun(
  runId: string,
  from: readonly AiRunStatus[],
  set: Partial<Record<RunColumn, SetValue>>,
): Promise<boolean> {
  const columns = Object.keys(set) as RunColumn[];
  const assignments = columns.map((c) => (set[c] === NOW ? `${c} = CURRENT_TIMESTAMP` : `${c} = ?`));
  const params = columns.filter((c) => set[c] !== NOW).map((c) => set[c] as string | number | null);
  const marks = from.map(() => '?').join(', ');
  const result = await sql
    .prepare<UpdateQueryResponse>(
      `UPDATE AiRuns SET ${assignments.join(', ')} WHERE run_id = CAST(? AS SIGNED) AND status IN (${marks})`,
    )
    .bindParams(...params, runId, ...from)
    .execute();
  return result.rows.affectedRows === 1;
}

/** Mirrors the run onto the Todo, but never overwrites a Todo whose content changed since the run. */
async function setAiState(todoId: string, contentVersion: number, state: AiState): Promise<void> {
  await sql
    .prepare<UpdateQueryResponse>(
      'UPDATE Todos SET ai_state = ? WHERE todo_id = CAST(? AS SIGNED) AND content_version = ?',
    )
    .bindParams(state, todoId, contentVersion)
    .execute();
}

const metaJson = (m: Meta): string => JSON.stringify(m);

// ---------------------------------------------------------------------------
// Stuck runs
// ---------------------------------------------------------------------------

const isActive = (status: string): boolean => status === 'classifying' || status === 'running';
const isStuck = (row: Pick<RunRow, 'status' | 'age_seconds'>): boolean =>
  isActive(row.status) && (numOrNull(row.age_seconds) ?? 0) > STUCK_AFTER_SECONDS;

/** Persists a stuck run as failed/TIMEOUT and returns the patched row. */
async function failStuck(row: RunRow): Promise<RunRow> {
  const changed = await updateRun(row.id, ['classifying', 'running'], {
    status: 'failed',
    error_code: 'TIMEOUT',
    completed_at: NOW,
  });
  if (changed) {
    await sql
      .prepare<UpdateQueryResponse>(
        "UPDATE Todos SET ai_state = 'failed' WHERE todo_id = CAST(? AS SIGNED) AND ai_state IN ('classifying', 'running')",
      )
      .bindParams(row.todo)
      .execute();
    console.error(`[ai] run timed out runId=${row.id}`);
  }
  return { ...row, status: 'failed', error_code: 'TIMEOUT', completed_at: row.completed_at ?? new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

type Ctx = { runId: string; todoId: string; contentVersion: number };

type Outcome = {
  status: AiRunStatus;
  meta: Meta;
  details?: Details | null;
  recommendedModel?: string | null;
  errorCode?: string | null;
};

/** Writes the outcome of classification/routing, mirrors ai_state, and returns the stored run. */
async function settle(ctx: Ctx, from: readonly AiRunStatus[], o: Outcome): Promise<RunResult> {
  await updateRun(ctx.runId, from, {
    status: o.status,
    classification: metaJson(o.meta),
    candidates: o.details ? JSON.stringify(o.details) : null,
    recommended_model: o.recommendedModel ?? null,
    error_code: o.errorCode ?? null,
    completed_at: TERMINAL.includes(o.status) ? NOW : null,
  });
  await setAiState(ctx.todoId, ctx.contentVersion, aiStateFor(o.status));
  return reload(ctx.runId);
}

async function reload(runId: string): Promise<RunResult> {
  const row = await loadRunRow(runId);
  return row ? { success: true, run: toAiRun(row) } : fail('NOT_FOUND', 'AI run not found.');
}

async function failRun(ctx: Ctx, from: readonly AiRunStatus[], meta: Meta, code: string, message: string) {
  return settle(ctx, from, { status: 'failed', meta: { ...meta, message }, errorCode: code });
}

async function routeAndSettle(
  ctx: Ctx,
  from: readonly AiRunStatus[],
  classification: Classification,
  meta: Meta,
  deps: AiDeps,
): Promise<RunResult> {
  const loaded = await deps.loadEntries({});
  const result = route(classification, loaded.entries);
  const base: Meta = { ...meta, category: result.detectedCategory, classification };

  if (result.kind === 'needs_clarification') {
    return settle(ctx, from, {
      status: 'needs_clarification',
      meta: { ...base, message: CLARIFY_MESSAGE },
      errorCode: 'NEEDS_CLARIFICATION',
    });
  }
  if (result.kind === 'no_eligible_model') {
    return settle(ctx, from, {
      status: 'no_eligible_model',
      meta: { ...base, message: result.message },
      errorCode: 'NO_ELIGIBLE_MODEL',
    });
  }
  const details: Details = {
    candidates: result.candidates.map(toAiCandidate),
    cheaperAlternativeModelId: result.cheaperAlternativeModelId,
    strongerAlternativeModelId: result.strongerAlternativeModelId,
    reason: result.reason,
    estimatedInputTokens: result.estimatedInputTokens,
    outputCapTokens: result.outputCapTokens,
  };
  return settle(ctx, from, {
    status: 'awaiting_confirmation',
    meta: { ...base, message: null },
    details,
    recommendedModel: result.recommendedModelId,
  });
}

/** Guard, classify, route for a freshly created `classifying` run. Never throws for provider problems. */
async function runPipeline(ctx: Ctx, todo: TodoRow, deps: AiDeps): Promise<RunResult> {
  const from = ['classifying'] as const;
  const empty: Meta = { category: null, classification: null, message: null };
  try {
    const verdict = await deps.guard(`${todo.description}\n${todo.notes ?? ''}`.trim());
    if (verdict.verdict === 'unsafe') {
      console.error(`[ai] input blocked by guard runId=${ctx.runId}`);
      return settle(ctx, from, {
        status: 'blocked_by_guard',
        meta: { ...empty, message: BLOCKED_MESSAGE },
        errorCode: 'BLOCKED_BY_GUARD',
      });
    }
    if (verdict.verdict === 'error') console.error(`[ai] guard unavailable, continuing runId=${ctx.runId}`);

    const classified = await deps.classify({ description: todo.description, notes: todo.notes });
    if (!classified.ok) {
      if (classified.kind === 'needs_clarification') {
        return settle(ctx, from, {
          status: 'needs_clarification',
          meta: { ...empty, message: CLARIFY_MESSAGE },
          errorCode: 'NEEDS_CLARIFICATION',
        });
      }
      const code = (CLASSIFIER_CODES as readonly string[]).includes(classified.code) ? classified.code : 'PROVIDER_ERROR';
      return failRun(ctx, from, empty, code, classified.message || FAILED_MESSAGE);
    }
    return await routeAndSettle(ctx, from, classified.classification, empty, deps);
  } catch (error) {
    if (isMissingSchemaError(error)) throw error;
    console.error(`[ai] pipeline failed runId=${ctx.runId}`);
    return failRun(ctx, from, empty, 'INTERNAL', INTERNAL_MESSAGE);
  }
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

export async function startTask(payload: unknown, deps: AiDeps = defaultDeps): Promise<RunResult> {
  const parsed = parsePayload(startTaskSchema, payload);
  if (!parsed.ok) return parsed.error;
  const { todoId } = parsed.data;

  try {
    const todo = await loadTodo(todoId);
    if (!todo) return fail('NOT_FOUND', 'Todo not found.');
    const contentVersion = numOrNull(todo.content_version) ?? 1;

    // One active run per Todo. Runs stuck for more than 2 minutes are failed and no longer block.
    const active = await sql
      .prepare<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM AiRuns WHERE todo_id = CAST(? AS SIGNED) AND status IN ('classifying', 'running')`,
      )
      .bindParams(todoId)
      .execute();
    for (const row of active.rows) {
      if (!isStuck(row)) return fail('INVALID_INPUT', ALREADY_RUNNING_MESSAGE);
      await failStuck(row);
    }

    // The NOT EXISTS guard makes the one-active-run rule atomic against concurrent Start clicks.
    const inserted = await sql
      .prepare<UpdateQueryResponse>(
        `INSERT INTO AiRuns (todo_id, content_version, status)
         SELECT todo_id, CAST(? AS SIGNED), 'classifying' FROM Todos
         WHERE todo_id = CAST(? AS SIGNED)
           AND NOT EXISTS (SELECT 1 FROM AiRuns WHERE todo_id = CAST(? AS SIGNED) AND status IN ('classifying', 'running'))`,
      )
      .bindParams(contentVersion, todoId, todoId)
      .execute();
    if (inserted.rows.affectedRows !== 1) return fail('INVALID_INPUT', ALREADY_RUNNING_MESSAGE);

    // AUTO_RANDOM ids are not reliably returned as insertId: read the one classifying run back.
    const created = await sql
      .prepare<{ id: string }>(
        `SELECT CAST(run_id AS CHAR) AS id FROM AiRuns
         WHERE todo_id = CAST(? AS SIGNED) AND status = 'classifying' ORDER BY created_at DESC LIMIT 1`,
      )
      .bindParams(todoId)
      .execute();
    const runId = created.rows[0]?.id;
    if (!runId) return fail('INTERNAL', INTERNAL_MESSAGE);
    const ctx: Ctx = { runId, todoId, contentVersion };

    // Older pending recommendations are superseded by this run.
    await sql
      .prepare<UpdateQueryResponse>(
        `UPDATE AiRuns SET status = 'stale', completed_at = CURRENT_TIMESTAMP
         WHERE todo_id = CAST(? AS SIGNED) AND run_id <> CAST(? AS SIGNED)
           AND status IN ('awaiting_confirmation', 'needs_clarification')`,
      )
      .bindParams(todoId, runId)
      .execute();
    await setAiState(todoId, contentVersion, 'classifying');

    return await runPipeline(ctx, todo, deps);
  } catch (error) {
    return aiInternalError('startTask', error);
  }
}

export async function chooseCategory(payload: unknown, deps: AiDeps = defaultDeps): Promise<RunResult> {
  const parsed = parsePayload(chooseCategorySchema, payload);
  if (!parsed.ok) return parsed.error;
  const { runId, category } = parsed.data;

  try {
    const row = await loadRunRow(runId);
    if (!row) return fail('NOT_FOUND', 'AI run not found.');
    if (row.status !== 'needs_clarification') {
      return fail('INVALID_INPUT', 'This run is not waiting for a category.');
    }
    const todo = await loadTodo(row.todo);
    if (!todo) return fail('NOT_FOUND', 'Todo not found.');
    const contentVersion = numOrNull(row.content_version) ?? 0;
    const ctx: Ctx = { runId, todoId: row.todo, contentVersion };

    if ((numOrNull(todo.content_version) ?? 0) !== contentVersion) {
      await updateRun(runId, ['needs_clarification'], { status: 'stale', completed_at: NOW });
      return fail('STALE_CONTENT', 'The task changed since this run started. Start the task again.');
    }

    // Atomic claim: only one caller continues routing.
    const claimed = await updateRun(runId, ['needs_clarification'], {
      status: 'classifying',
      error_code: null,
      confirmed_at: NOW,
    });
    if (!claimed) return fail('INVALID_INPUT', 'This run is not waiting for a category.');
    await setAiState(ctx.todoId, contentVersion, 'classifying');

    const synthetic: Classification = {
      category: category as Category,
      subcategory: 'other',
      requirements: [],
      inputModalities: ['text'],
      outputModality: 'text',
      reasoningLevel: 'medium',
      needsTools: false,
      needsLongContext: false,
      confidence: 1,
    };
    try {
      return await routeAndSettle(
        ctx,
        ['classifying'],
        synthetic,
        { category, classification: synthetic, message: null },
        deps,
      );
    } catch (error) {
      if (isMissingSchemaError(error)) throw error;
      console.error(`[ai] routing failed runId=${runId}`);
      return failRun(ctx, ['classifying'], { category, classification: synthetic, message: null }, 'INTERNAL', INTERNAL_MESSAGE);
    }
  } catch (error) {
    return aiInternalError('chooseCategory', error);
  }
}

export async function confirmRun(payload: unknown, deps: AiDeps = defaultDeps): Promise<RunResult> {
  const parsed = parsePayload(confirmRunSchema, payload);
  if (!parsed.ok) return parsed.error;
  const { runId, modelId } = parsed.data;

  try {
    const row = await loadRunRow(runId);
    if (!row) return fail('NOT_FOUND', 'AI run not found.');
    if (row.status !== 'awaiting_confirmation') {
      return fail('INVALID_INPUT', 'This run is no longer waiting for confirmation.');
    }
    const run = toAiRun(row);

    // Allowlist twice: the stored candidate list AND the live registry (executor re-checks too).
    if (!run.candidates.some((c) => c.modelId === modelId) || !isApprovedAndEnabled(modelId)) {
      return fail('NOT_ALLOWED_MODEL', 'That model is not available for this run.');
    }

    const todo = await loadTodo(run.todoId);
    if (!todo) return fail('NOT_FOUND', 'Todo not found.');
    if ((numOrNull(todo.content_version) ?? 0) !== run.contentVersion) {
      await updateRun(runId, ['awaiting_confirmation'], { status: 'stale', completed_at: NOW });
      return fail('STALE_CONTENT', 'The task changed since this recommendation was made. Start the task again.');
    }

    // Atomic claim: prevents double execution and double billing.
    const claimed = await updateRun(runId, ['awaiting_confirmation'], {
      status: 'running',
      confirmed_model: modelId,
      confirmed_at: NOW,
    });
    if (!claimed) return fail('INVALID_INPUT', 'This run is no longer waiting for confirmation.');
    await setAiState(run.todoId, run.contentVersion, 'running');

    const meta = readMeta(row.classification);
    let result: Awaited<ReturnType<AiDeps['worker']>>;
    try {
      result = await deps.worker({ modelId, description: todo.description, notes: todo.notes });
    } catch {
      result = { ok: false, code: 'PROVIDER_ERROR', message: 'The AI request failed.' };
    }

    if (result.ok) {
      const cost = result.costUsd === null ? null : Number(result.costUsd.toFixed(8));
      await updateRun(runId, ['running'], {
        status: 'succeeded',
        response: result.text,
        prompt_tokens: result.usage.promptTokens,
        completion_tokens: result.usage.completionTokens,
        cost_usd: cost,
        error_code: null,
        completed_at: NOW,
      });
      await setAiState(run.todoId, run.contentVersion, 'succeeded');
    } else {
      console.error(`[ai] worker failed runId=${runId} code=${result.code}`);
      await updateRun(runId, ['running'], {
        status: 'failed',
        classification: metaJson({ ...meta, message: result.message }),
        error_code: result.code,
        completed_at: NOW,
      });
      await setAiState(run.todoId, run.contentVersion, 'failed');
    }
    return await reload(runId);
  } catch (error) {
    return aiInternalError('confirmRun', error);
  }
}

export async function getAiRuns(payload: unknown): Promise<{ success: true; runs: AiRun[] } | ErrorResult> {
  const parsed = parsePayload(getAiRunsSchema, payload);
  if (!parsed.ok) return parsed.error;
  try {
    const result = await sql
      .prepare<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM AiRuns WHERE todo_id = CAST(? AS SIGNED) ORDER BY created_at DESC, run_id DESC`,
      )
      .bindParams(parsed.data.todoId)
      .execute();
    const runs: AiRun[] = [];
    for (const row of result.rows) runs.push(toAiRun(isStuck(row) ? await failStuck(row) : row));
    return { success: true, runs };
  } catch (error) {
    return aiInternalError('getAiRuns', error);
  }
}

async function modelsResponse(forceRefresh: boolean, deps: AiDeps): Promise<ModelsResult | ErrorResult> {
  try {
    const loaded = await deps.loadEntries({ forceRefresh });
    const out: ModelsResult = {
      success: true,
      models: toModelsTable(loaded.entries, { fetchedAt: loaded.fetchedAt, source: loaded.source }),
      fetchedAt: loaded.fetchedAt,
      source: loaded.source,
    };
    // Raw provider/SQL error text is never returned to the browser.
    if (loaded.error) out.error = MODELS_FALLBACK_ERROR;
    return out;
  } catch {
    // Last resort: the committed snapshot still lets the Models tab render.
    console.error(`[ai] ${forceRefresh ? 'refreshModels' : 'getModels'} failed, using snapshot`);
    const entries = snapshotEntries();
    return {
      success: true,
      models: toModelsTable(entries, { fetchedAt: null, source: 'snapshot' }),
      fetchedAt: null,
      source: 'snapshot',
      error: MODELS_FALLBACK_ERROR,
    };
  }
}

export const getModels = (deps: AiDeps = defaultDeps) => modelsResponse(false, deps);
export const refreshModels = (deps: AiDeps = defaultDeps) => modelsResponse(true, deps);
