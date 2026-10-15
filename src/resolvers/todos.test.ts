import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { sql: string; params: unknown[] };
const calls: Call[] = [];
let handler: (call: Call) => unknown;

vi.mock('@forge/sql', () => ({
  sql: {
    prepare: (statement: string) => ({
      bindParams: (...params: unknown[]) => ({
        execute: async () => {
          const call = { sql: statement, params };
          calls.push(call);
          return handler(call);
        },
      }),
      execute: async () => {
        const call = { sql: statement, params: [] };
        calls.push(call);
        return handler(call);
      },
    }),
  },
}));

import { addTodo, deleteTodo, getTodo, getTodos, setTodoStatus, updateTodo } from './todos';

const row = (over: Record<string, unknown> = {}) => ({
  id: '42',
  description: 'old',
  notes: null,
  status: 'todo',
  ai_state: 'succeeded',
  content_version: 3,
  created_at: 't',
  updated_at: 't',
  ...over,
});

const isSelect = (c: Call) => /^\s*SELECT/i.test(c.sql);
const writes = () => calls.filter((c) => !isSelect(c));

beforeEach(() => {
  calls.length = 0;
  handler = (c) => (isSelect(c) ? { rows: [row()] } : { rows: { affectedRows: 1 } });
});

describe('addTodo', () => {
  it('keeps the { success } shape', async () => {
    expect(await addTodo({ description: ' hi ' })).toEqual({ success: true });
    expect(calls[0].params).toEqual(['hi']);
  });
  it('rejects invalid input without touching SQL', async () => {
    const r = await addTodo({ description: '' });
    expect(r).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
    expect(calls).toHaveLength(0);
  });
});

describe('getTodo / getTodos', () => {
  it('returns the row including additive fields', async () => {
    const todo = await getTodo({ id: '42' });
    expect(todo).toMatchObject({ notes: null, ai_state: 'succeeded', content_version: 3 });
    expect(calls[0].sql).toMatch(/notes, status, ai_state, content_version, created_at, updated_at/);
  });
  it('returns null for missing or invalid id', async () => {
    handler = () => ({ rows: [] });
    expect(await getTodo({ id: '42' })).toBeNull();
    expect(await getTodo({ id: 'x' })).toBeNull();
  });
  it('lists todos', async () => {
    expect(await getTodos()).toHaveLength(1);
    expect(calls[0].sql).toMatch(/ORDER BY created_at DESC/);
  });
});

describe('updateTodo', () => {
  it('bumps content_version and resets ai_state when description changes', async () => {
    const r = await updateTodo({ id: '42', description: 'new' });
    expect(r.success).toBe(true);
    const update = calls.find((c) => /^\s*UPDATE Todos/i.test(c.sql))!;
    expect(update.sql).toMatch(/content_version = content_version \+ 1/);
    expect(update.sql).toMatch(/ai_state = 'not_started'/);
    expect(update.params).toEqual(['new', null, '42']);
    expect(calls.some((c) => /UPDATE AiRuns SET status = 'stale'/.test(c.sql))).toBe(true);
  });
  it('bumps when notes change', async () => {
    await updateTodo({ id: '42', notes: 'n' });
    const update = calls.find((c) => /^\s*UPDATE Todos/i.test(c.sql))!;
    expect(update.params).toEqual(['old', 'n', '42']);
  });
  it('does not bump or write when nothing changed', async () => {
    const r = await updateTodo({ id: '42', description: '  old  ', notes: '' });
    expect(r).toMatchObject({ success: true, todo: { content_version: 3 } });
    expect(writes()).toHaveLength(0);
  });
  it('trims before comparing', async () => {
    await updateTodo({ id: '42', description: ' old ' });
    expect(writes()).toHaveLength(0);
  });
  it('returns NOT_FOUND', async () => {
    handler = () => ({ rows: [] });
    expect(await updateTodo({ id: '42', description: 'x' })).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
  });
  it('works when AiRuns table does not exist yet', async () => {
    handler = (c) => {
      if (/AiRuns/.test(c.sql)) throw new Error("Table 'test.AiRuns' doesn't exist");
      return isSelect(c) ? { rows: [row()] } : { rows: { affectedRows: 1 } };
    };
    expect((await updateTodo({ id: '42', description: 'new' })).success).toBe(true);
  });
  it('returns INTERNAL (user-safe) on other AiRuns errors', async () => {
    handler = (c) => {
      if (/AiRuns/.test(c.sql)) throw new Error('connection reset at /secret/path');
      return isSelect(c) ? { rows: [row()] } : { rows: { affectedRows: 1 } };
    };
    const r = await updateTodo({ id: '42', description: 'new' });
    expect(r).toMatchObject({ success: false, error: { code: 'INTERNAL' } });
    expect(JSON.stringify(r)).not.toContain('/secret/path');
  });
  it('rejects invalid input', async () => {
    expect(await updateTodo({ id: '42' })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(calls).toHaveLength(0);
  });
});

describe('setTodoStatus', () => {
  it('updates only status, no version bump or AI changes', async () => {
    const r = await setTodoStatus({ id: '42', status: 'done' });
    expect(r).toMatchObject({ success: true, todo: { status: 'done', content_version: 3, ai_state: 'succeeded' } });
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0].sql).not.toMatch(/content_version|ai_state|AiRuns/);
    expect(w[0].params).toEqual(['done', '42']);
  });
  it('NOT_FOUND and INVALID_INPUT', async () => {
    expect(await setTodoStatus({ id: '42', status: 'bad' })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    handler = () => ({ rows: [] });
    expect(await setTodoStatus({ id: '42', status: 'done' })).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('deleteTodo', () => {
  it('deletes AiRuns then the Todo', async () => {
    expect(await deleteTodo({ id: '42' })).toEqual({ success: true });
    const w = writes();
    expect(w[0].sql).toMatch(/DELETE FROM AiRuns/);
    expect(w[1].sql).toMatch(/DELETE FROM Todos/);
  });
  it('succeeds when AiRuns is missing', async () => {
    handler = (c) => {
      if (/AiRuns/.test(c.sql)) throw new Error('ER_NO_SUCH_TABLE');
      return isSelect(c) ? { rows: [row()] } : { rows: { affectedRows: 1 } };
    };
    expect(await deleteTodo({ id: '42' })).toEqual({ success: true });
  });
  it('NOT_FOUND deletes nothing', async () => {
    handler = () => ({ rows: [] });
    expect(await deleteTodo({ id: '42' })).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
    expect(writes()).toHaveLength(0);
  });
});

describe('SQL safety', () => {
  it('never concatenates user strings into SQL', async () => {
    const evil = "x'); DROP TABLE Todos; --";
    await addTodo({ description: evil });
    await updateTodo({ id: '42', description: evil, notes: evil });
    await setTodoStatus({ id: '42', status: 'done' });
    await deleteTodo({ id: '42' });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.sql).not.toContain('DROP');
      expect(c.sql).not.toContain(evil);
      expect(c.sql).not.toContain('42');
    }
    expect(calls.some((c) => c.params.includes(evil))).toBe(true);
  });
});

describe('legacy schema fallback (migrations not run yet)', () => {
  const legacy = { id: '42', description: 'old', status: 'todo', created_at: 'c' };
  const legacyHandler = (c: Call) => {
    if (/notes/.test(c.sql)) throw new Error("Unknown column 'notes' in 'field list'");
    return { rows: [legacy] };
  };
  const defaults = { notes: null, ai_state: 'not_started', content_version: 1, updated_at: 'c' };

  it('getTodos falls back and fills defaults', async () => {
    handler = legacyHandler;
    const todos = await getTodos();
    expect(todos).toEqual([{ ...legacy, ...defaults }]);
    expect(calls[1].sql).not.toMatch(/notes|ai_state|content_version|updated_at/);
  });
  it('getTodo falls back and fills defaults, or null when absent', async () => {
    handler = legacyHandler;
    expect(await getTodo({ id: '42' })).toEqual({ ...legacy, ...defaults });
    handler = (c) => {
      if (/notes/.test(c.sql)) throw new Error('ER_BAD_FIELD_ERROR 1054');
      return { rows: [] };
    };
    expect(await getTodo({ id: '42' })).toBeNull();
  });
  it('fallback result has the full Todo shape', async () => {
    handler = legacyHandler;
    const [todo] = await getTodos();
    expect(Object.keys(todo).sort()).toEqual(
      ['ai_state', 'content_version', 'created_at', 'description', 'id', 'notes', 'status', 'updated_at']
    );
  });
  it('does not swallow other errors', async () => {
    handler = () => {
      throw new Error('connection reset');
    };
    await expect(getTodos()).rejects.toThrow('connection reset');
    await expect(getTodo({ id: '42' })).rejects.toThrow('connection reset');
  });
  // Real Forge error shape: the Error message is generic and MySQL details sit in context.debug.
  const forgeSqlError = (debug: Record<string, unknown>) =>
    Object.assign(new Error('Unknown SQL execution error'), {
      code: 'SQL_EXECUTION_ERROR',
      context: { debug, queryType: 'select' },
    });
  const realUnknownColumn = () =>
    forgeSqlError({
      message: "ERROR 1054 (42S22): Unknown column 'notes' in 'field list'",
      code: 'ER_BAD_FIELD_ERROR',
      errno: 1054,
      sqlState: '42S22',
      sqlMessage: "Unknown column 'notes' in 'field list'",
    });

  it('falls back on the real Forge unknown-column error shape (generic message, details in context.debug)', async () => {
    handler = (c) => {
      if (/notes/.test(c.sql)) throw realUnknownColumn();
      return { rows: [legacy] };
    };
    expect(await getTodos()).toEqual([{ ...legacy, ...defaults }]);
    expect(await getTodo({ id: '42' })).toEqual({ ...legacy, ...defaults });
  });
  it('does not treat other real Forge SQL errors as a missing column', async () => {
    handler = () => {
      throw forgeSqlError({ message: 'ERROR 1213 (40001): Deadlock found', code: 'ER_LOCK_DEADLOCK', errno: 1213 });
    };
    await expect(getTodos()).rejects.toThrow('Unknown SQL execution error');
  });
  it('tolerates a missing AiRuns table in the real Forge error shape', async () => {
    handler = (c) => {
      if (/AiRuns/.test(c.sql)) {
        throw forgeSqlError({
          message: "ERROR 1146 (42S02): Table 'AiRuns' doesn't exist",
          code: 'ER_NO_SUCH_TABLE',
          errno: 1146,
        });
      }
      return isSelect(c) ? { rows: [row()] } : { rows: { affectedRows: 1 } };
    };
    expect(await deleteTodo({ id: '42' })).toEqual({ success: true });
  });
  it('updateTodo and setTodoStatus return a user-safe INTERNAL error', async () => {
    handler = legacyHandler;
    for (const r of [
      await updateTodo({ id: '42', description: 'x' }),
      await setTodoStatus({ id: '42', status: 'done' }),
    ]) {
      expect(r).toMatchObject({ success: false, error: { code: 'INTERNAL' } });
      expect(JSON.stringify(r)).not.toMatch(/Unknown column|notes/);
    }
  });
});
