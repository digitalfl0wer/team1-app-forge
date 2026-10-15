import { describe, expect, it } from 'vitest';
import {
  addTodoSchema,
  deleteTodoSchema,
  parsePayload,
  setTodoStatusSchema,
  updateTodoSchema,
} from './validation';

describe('id', () => {
  it.each(['1', '123456789012345678', '12345678901234567890'])('accepts %s', (id) => {
    expect(deleteTodoSchema.safeParse({ id }).success).toBe(true);
  });
  it.each(['', 'abc', '-1', '1.5', ' 1', '1 ', '123456789012345678901', '1; DROP TABLE Todos'])(
    'rejects %j',
    (id) => {
      expect(deleteTodoSchema.safeParse({ id }).success).toBe(false);
    }
  );
  it('rejects numbers', () => {
    expect(deleteTodoSchema.safeParse({ id: 5 }).success).toBe(false);
  });
});

describe('description', () => {
  it('trims', () => {
    const r = addTodoSchema.parse({ description: '  hi  ' });
    expect(r.description).toBe('hi');
  });
  it('accepts 255 chars, rejects 256', () => {
    expect(addTodoSchema.safeParse({ description: 'a'.repeat(255) }).success).toBe(true);
    expect(addTodoSchema.safeParse({ description: 'a'.repeat(256) }).success).toBe(false);
  });
  it('rejects empty and whitespace-only', () => {
    expect(addTodoSchema.safeParse({ description: '' }).success).toBe(false);
    expect(addTodoSchema.safeParse({ description: '   ' }).success).toBe(false);
  });
  it('rejects non-strings and missing', () => {
    expect(addTodoSchema.safeParse({ description: 1 }).success).toBe(false);
    expect(addTodoSchema.safeParse({}).success).toBe(false);
  });
});

describe('notes', () => {
  const base = { id: '1' };
  it('accepts 5000, rejects 5001', () => {
    expect(updateTodoSchema.safeParse({ ...base, notes: 'a'.repeat(5000) }).success).toBe(true);
    expect(updateTodoSchema.safeParse({ ...base, notes: 'a'.repeat(5001) }).success).toBe(false);
  });
  it('maps empty string and null to null', () => {
    expect(updateTodoSchema.parse({ ...base, notes: '' }).notes).toBeNull();
    expect(updateTodoSchema.parse({ ...base, notes: null }).notes).toBeNull();
  });
  it('keeps non-empty notes', () => {
    expect(updateTodoSchema.parse({ ...base, notes: 'x' }).notes).toBe('x');
  });
});

describe('updateTodo payload', () => {
  it('requires at least one field', () => {
    expect(updateTodoSchema.safeParse({ id: '1' }).success).toBe(false);
  });
  it('accepts description only', () => {
    expect(updateTodoSchema.safeParse({ id: '1', description: 'x' }).success).toBe(true);
  });
});

describe('status', () => {
  it.each(['todo', 'up_next', 'in_progress', 'done'])('accepts %s', (status) => {
    expect(setTodoStatusSchema.safeParse({ id: '1', status }).success).toBe(true);
  });
  it.each(['', 'TODO', 'blocked', 'in-progress', 1, null])('rejects %j', (status) => {
    expect(setTodoStatusSchema.safeParse({ id: '1', status }).success).toBe(false);
  });
});

describe('unknown keys', () => {
  it('are rejected by every schema', () => {
    expect(addTodoSchema.safeParse({ description: 'x', extra: 1 }).success).toBe(false);
    expect(updateTodoSchema.safeParse({ id: '1', description: 'x', ai_state: 'done' }).success).toBe(false);
    expect(setTodoStatusSchema.safeParse({ id: '1', status: 'done', foo: 1 }).success).toBe(false);
    expect(deleteTodoSchema.safeParse({ id: '1', foo: 1 }).success).toBe(false);
  });
});

describe('parsePayload', () => {
  it('returns an INVALID_INPUT envelope without echoing input', () => {
    const r = parsePayload(deleteTodoSchema, { id: 'secret-value' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.success).toBe(false);
      expect(r.error.error.code).toBe('INVALID_INPUT');
      expect(r.error.error.message).not.toContain('secret-value');
    }
  });
  it('treats undefined payload as empty object', () => {
    expect(parsePayload(deleteTodoSchema, undefined).ok).toBe(false);
  });
});
