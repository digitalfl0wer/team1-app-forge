import { describe, expect, it } from 'vitest';
import {
    countByStatus,
    draftFromTodo,
    draftToUpdate,
    filterTodos,
    isDraftChanged,
    isDraftValid,
    remainingHint,
    removeTodo,
    replaceTodo,
    statusLabel,
    validateDescription,
    validateNotes,
    type Todo,
} from './todoView';

const make = (id: string, status: Todo['status'], extra: Partial<Todo> = {}): Todo => ({
    id,
    description: `Task ${id}`,
    notes: null,
    status,
    ai_state: 'not_started',
    content_version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...extra,
});

const todos = [make('1', 'todo'), make('2', 'done'), make('3', 'todo'), make('4', 'in_progress')];

describe('status labels', () => {
    it('maps statuses to labels', () => {
        expect(statusLabel('todo')).toBe('To do');
        expect(statusLabel('up_next')).toBe('Up next');
        expect(statusLabel('in_progress')).toBe('In progress');
        expect(statusLabel('done')).toBe('Done');
        expect(statusLabel('weird')).toBe('weird');
    });
});

describe('filtering and counts', () => {
    it('filters by status and keeps all', () => {
        expect(filterTodos(todos, 'all')).toHaveLength(4);
        expect(filterTodos(todos, 'todo').map((t) => t.id)).toEqual(['1', '3']);
        expect(filterTodos(todos, 'up_next')).toEqual([]);
    });
    it('counts per status', () => {
        expect(countByStatus(todos)).toEqual({ all: 4, todo: 2, up_next: 0, in_progress: 1, done: 1 });
        expect(countByStatus([]).all).toBe(0);
    });
});

describe('validation', () => {
    it('validates description like the backend (trimmed 1-255)', () => {
        expect(validateDescription('   ')).not.toBeNull();
        expect(validateDescription('  ok  ')).toBeNull();
        expect(validateDescription('a'.repeat(255))).toBeNull();
        expect(validateDescription('a'.repeat(256))).not.toBeNull();
        expect(validateDescription(' ' + 'a'.repeat(255) + ' ')).toBeNull();
    });
    it('validates notes up to 5000', () => {
        expect(validateNotes('')).toBeNull();
        expect(validateNotes('a'.repeat(5000))).toBeNull();
        expect(validateNotes('a'.repeat(5001))).not.toBeNull();
    });
    it('formats hints', () => {
        expect(remainingHint('abc', 5)).toBe('2 characters left');
        expect(remainingHint('abcd', 5)).toBe('1 character left');
        expect(remainingHint('abcdefg', 5)).toBe('2 characters over the limit');
    });
});

describe('drafts', () => {
    const todo = make('1', 'todo', { notes: 'n' });
    it('starts unchanged and valid', () => {
        const draft = draftFromTodo(todo);
        expect(isDraftChanged(todo, draft)).toBe(false);
        expect(isDraftValid(draft)).toBe(true);
        expect(draftToUpdate(todo, draft)).toEqual({});
    });
    it('sends only changed fields, trimmed; empty notes clear', () => {
        expect(draftToUpdate(todo, { description: '  New  ', notes: 'n' })).toEqual({ description: 'New' });
        expect(draftToUpdate(todo, { description: 'Task 1', notes: '' })).toEqual({ notes: '' });
        expect(isDraftChanged(todo, { description: 'Task 1  ', notes: 'n' })).toBe(false);
    });
    it('treats null notes as empty', () => {
        expect(draftFromTodo(make('2', 'todo')).notes).toBe('');
        expect(isDraftChanged(make('2', 'todo'), { description: 'Task 2', notes: '' })).toBe(false);
    });
    it('rejects invalid drafts', () => {
        expect(isDraftValid({ description: '', notes: '' })).toBe(false);
        expect(isDraftValid({ description: 'x', notes: 'a'.repeat(5001) })).toBe(false);
    });
});

describe('list helpers', () => {
    it('replaces and removes by id', () => {
        const next = make('2', 'todo');
        expect(replaceTodo(todos, next)[1].status).toBe('todo');
        expect(removeTodo(todos, '2').map((t) => t.id)).toEqual(['1', '3', '4']);
    });
});
