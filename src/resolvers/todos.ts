import { sql, type UpdateQueryResponse } from '@forge/sql';
import {
  addTodoSchema,
  deleteTodoSchema,
  fail,
  getTodoSchema,
  parsePayload,
  setTodoStatusSchema,
  updateTodoSchema,
  type ErrorResult,
} from './validation';

export type Todo = {
  id: string;
  description: string;
  notes: string | null;
  status: 'todo' | 'up_next' | 'in_progress' | 'done';
  ai_state:
    | 'not_started'
    | 'classifying'
    | 'awaiting_confirmation'
    | 'running'
    | 'succeeded'
    | 'failed';
  content_version: number;
  created_at: string;
  updated_at: string;
};

// todo_id is an AUTO_RANDOM BIGINT that can exceed JS's safe integer range, so it travels as a string.
const TODO_COLUMNS = `CAST(todo_id AS CHAR) AS id, description, notes, status, ai_state, content_version, created_at, updated_at`;

const INTERNAL_MESSAGE = 'Something went wrong. Please try again.';

async function fetchTodo(id: string): Promise<Todo | null> {
  const result = await sql
    .prepare<Todo>(`SELECT ${TODO_COLUMNS} FROM Todos WHERE todo_id = CAST(? AS SIGNED)`)
    .bindParams(id)
    .execute();
  return result.rows[0] ?? null;
}

/**
 * Forge wraps database failures in a ForgeSQLAPIError whose own message is only
 * "Unknown SQL execution error"; the MySQL details (errno, code, sqlMessage) live in
 * `error.context.debug`. Look at both so the detectors below match real Forge errors.
 */
export function sqlErrorText(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) parts.push(error.message);
  else parts.push(String(error));
  const debug = (error as { context?: { debug?: Record<string, unknown> } } | null)?.context?.debug;
  if (debug && typeof debug === 'object') {
    for (const key of ['message', 'code', 'errno', 'sqlMessage'] as const) {
      const value = debug[key];
      if (value !== undefined && value !== null) parts.push(String(value));
    }
  }
  return parts.join(' ');
}

function isMissingColumnError(error: unknown): boolean {
  return /unknown column|ER_BAD_FIELD_ERROR|\b1054\b/i.test(sqlErrorText(error));
}

const LEGACY_COLUMNS = 'CAST(todo_id AS CHAR) AS id, description, status, created_at';

type LegacyTodo = Pick<Todo, 'id' | 'description' | 'status' | 'created_at'>;

// Used when migrations v002-v005 have not run yet: fills the additive fields with their defaults.
const withDefaults = (row: LegacyTodo): Todo => ({
  ...row,
  notes: null,
  ai_state: 'not_started',
  content_version: 1,
  updated_at: row.created_at,
});

function isMissingTableError(error: unknown): boolean {
  return /doesn't exist|does not exist|no such table|ER_NO_SUCH_TABLE|\b1146\b/i.test(sqlErrorText(error));
}

/**
 * Runs an AiRuns statement, tolerating the table not existing yet.
 * TODO(AI wave): once the v00N_create_ai_runs migration has landed everywhere, drop the guard.
 */
async function runAiRunsStatement(statement: string, id: string): Promise<void> {
  try {
    await sql.prepare<UpdateQueryResponse>(statement).bindParams(id).execute();
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }
  }
}

function internalError(operation: string, error: unknown): ErrorResult {
  if (isMissingColumnError(error)) {
    console.error(`${operation} failed: database schema is not migrated yet`);
    return fail('INTERNAL', 'The app is still updating its database. Please try again in a few minutes.');
  }
  console.error(`${operation} failed`, error instanceof Error ? error.message : String(error));
  return fail('INTERNAL', INTERNAL_MESSAGE);
}

export async function addTodo(payload: unknown): Promise<{ success: boolean } | ErrorResult> {
  const parsed = parsePayload(addTodoSchema, payload);
  if (!parsed.ok) return parsed.error;
  try {
    const result = await sql
      .prepare<UpdateQueryResponse>('INSERT INTO Todos (description) VALUES (?)')
      .bindParams(parsed.data.description)
      .execute();
    return { success: result.rows.affectedRows === 1 };
  } catch (error) {
    return internalError('addTodo', error);
  }
}

/** Returns the Todo, or null when absent or when the payload is invalid (existing contract). */
export async function getTodo(payload: unknown): Promise<Todo | null> {
  const parsed = parsePayload(getTodoSchema, payload);
  if (!parsed.ok) return null;
  try {
    return await fetchTodo(parsed.data.id);
  } catch (error) {
    if (!isMissingColumnError(error)) throw error;
    const result = await sql
      .prepare<LegacyTodo>(`SELECT ${LEGACY_COLUMNS} FROM Todos WHERE todo_id = CAST(? AS SIGNED)`)
      .bindParams(parsed.data.id)
      .execute();
    return result.rows[0] ? withDefaults(result.rows[0]) : null;
  }
}

export async function getTodos(): Promise<Todo[]> {
  try {
    const result = await sql
      .prepare<Todo>(`SELECT ${TODO_COLUMNS} FROM Todos ORDER BY created_at DESC`)
      .execute();
    return result.rows;
  } catch (error) {
    if (!isMissingColumnError(error)) throw error;
    const result = await sql
      .prepare<LegacyTodo>(`SELECT ${LEGACY_COLUMNS} FROM Todos ORDER BY created_at DESC`)
      .execute();
    return result.rows.map(withDefaults);
  }
}

export async function updateTodo(
  payload: unknown
): Promise<{ success: true; todo: Todo } | ErrorResult> {
  const parsed = parsePayload(updateTodoSchema, payload);
  if (!parsed.ok) return parsed.error;
  const { id, description, notes } = parsed.data;

  try {
    const current = await fetchTodo(id);
    if (!current) return fail('NOT_FOUND', 'Todo not found.');

    const nextDescription = description ?? current.description;
    const nextNotes = notes === undefined ? current.notes : notes;
    const changed = nextDescription !== current.description || nextNotes !== (current.notes ?? null);

    if (!changed) {
      return { success: true, todo: current };
    }

    await sql
      .prepare<UpdateQueryResponse>(
        `UPDATE Todos
         SET description = ?, notes = ?, content_version = content_version + 1, ai_state = 'not_started'
         WHERE todo_id = CAST(? AS SIGNED)`
      )
      .bindParams(nextDescription, nextNotes, id)
      .execute();

    // Pending recommendations were made for the old content.
    // TODO(AI wave): AiRuns is created by the AI migration; this is skipped until the table exists.
    await runAiRunsStatement(
      `UPDATE AiRuns SET status = 'stale'
       WHERE todo_id = CAST(? AS SIGNED) AND status = 'awaiting_confirmation'`,
      id
    );

    const todo = await fetchTodo(id);
    if (!todo) return fail('NOT_FOUND', 'Todo not found.');
    return { success: true, todo };
  } catch (error) {
    return internalError('updateTodo', error);
  }
}

export async function setTodoStatus(
  payload: unknown
): Promise<{ success: true; todo: Todo } | ErrorResult> {
  const parsed = parsePayload(setTodoStatusSchema, payload);
  if (!parsed.ok) return parsed.error;
  const { id, status } = parsed.data;

  try {
    const current = await fetchTodo(id);
    if (!current) return fail('NOT_FOUND', 'Todo not found.');

    await sql
      .prepare<UpdateQueryResponse>('UPDATE Todos SET status = ? WHERE todo_id = CAST(? AS SIGNED)')
      .bindParams(status, id)
      .execute();

    return { success: true, todo: { ...current, status } };
  } catch (error) {
    return internalError('setTodoStatus', error);
  }
}

export async function deleteTodo(payload: unknown): Promise<{ success: true } | ErrorResult> {
  const parsed = parsePayload(deleteTodoSchema, payload);
  if (!parsed.ok) return parsed.error;
  const { id } = parsed.data;

  try {
    const current = await fetchTodo(id);
    if (!current) return fail('NOT_FOUND', 'Todo not found.');

    // TODO(AI wave): AiRuns is created by the AI migration; skipped until the table exists.
    await runAiRunsStatement('DELETE FROM AiRuns WHERE todo_id = CAST(? AS SIGNED)', id);

    const result = await sql
      .prepare<UpdateQueryResponse>('DELETE FROM Todos WHERE todo_id = CAST(? AS SIGNED)')
      .bindParams(id)
      .execute();
    if (result.rows.affectedRows === 0) return fail('NOT_FOUND', 'Todo not found.');
    return { success: true };
  } catch (error) {
    return internalError('deleteTodo', error);
  }
}
