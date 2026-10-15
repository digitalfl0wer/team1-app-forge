// Pure view logic for the Todo UI. No DOM, no React, no bridge imports.

export const TODO_STATUSES = ['todo', 'up_next', 'in_progress', 'done'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export type AiState =
    | 'not_started'
    | 'classifying'
    | 'awaiting_confirmation'
    | 'running'
    | 'succeeded'
    | 'failed';

export type Todo = {
    id: string;
    description: string;
    notes: string | null;
    status: TodoStatus;
    ai_state: AiState;
    content_version: number;
    created_at: string;
    updated_at: string;
};

export type StatusFilter = 'all' | TodoStatus;

export const DESCRIPTION_MAX = 255;
export const NOTES_MAX = 5000;

export const STATUS_LABELS: Record<TodoStatus, string> = {
    todo: 'To do',
    up_next: 'Up next',
    in_progress: 'In progress',
    done: 'Done',
};

export function isTodoStatus(value: unknown): value is TodoStatus {
    return typeof value === 'string' && (TODO_STATUSES as readonly string[]).indexOf(value) !== -1;
}

/** Label for a status; unknown values fall back to the raw text so the UI never breaks. */
export function statusLabel(status: string): string {
    return isTodoStatus(status) ? STATUS_LABELS[status] : status;
}

export function filterLabel(filter: StatusFilter): string {
    return filter === 'all' ? 'All' : STATUS_LABELS[filter];
}

export function filterTodos(todos: Todo[], filter: StatusFilter): Todo[] {
    return filter === 'all' ? todos : todos.filter((todo) => todo.status === filter);
}

export type StatusCounts = Record<StatusFilter, number>;

export function countByStatus(todos: Todo[]): StatusCounts {
    const counts: StatusCounts = { all: todos.length, todo: 0, up_next: 0, in_progress: 0, done: 0 };
    for (const todo of todos) {
        if (isTodoStatus(todo.status)) counts[todo.status] += 1;
    }
    return counts;
}

/** Returns an error message, or null when the description is valid (matches the backend: trimmed 1-255). */
export function validateDescription(raw: string): string | null {
    const length = raw.trim().length;
    if (length === 0) return 'Task text is required.';
    if (length > DESCRIPTION_MAX) return `Task text must be at most ${DESCRIPTION_MAX} characters.`;
    return null;
}

/** Notes are optional, up to 5000 characters (not trimmed by the backend). */
export function validateNotes(raw: string): string | null {
    if (raw.length > NOTES_MAX) return `Notes must be at most ${NOTES_MAX} characters.`;
    return null;
}

export function remainingChars(raw: string, max: number): number {
    return max - raw.length;
}

/** Hint such as "12 characters left" or "3 characters over the limit". */
export function remainingHint(raw: string, max: number): string {
    const left = remainingChars(raw, max);
    const abs = Math.abs(left);
    const noun = abs === 1 ? 'character' : 'characters';
    return left >= 0 ? `${left} ${noun} left` : `${abs} ${noun} over the limit`;
}

export type EditDraft = { description: string; notes: string };

export function draftFromTodo(todo: Todo): EditDraft {
    return { description: todo.description, notes: todo.notes ?? '' };
}

export type DraftErrors = { description: string | null; notes: string | null };

export function validateDraft(draft: EditDraft): DraftErrors {
    return {
        description: validateDescription(draft.description),
        notes: validateNotes(draft.notes),
    };
}

export function isDraftValid(draft: EditDraft): boolean {
    const errors = validateDraft(draft);
    return errors.description === null && errors.notes === null;
}

/** True when saving the draft would change the stored Todo. */
export function isDraftChanged(todo: Todo, draft: EditDraft): boolean {
    return draft.description.trim() !== todo.description || draft.notes !== (todo.notes ?? '');
}

/** Payload fields for updateTodo: only the fields that changed (empty notes clears them). */
export function draftToUpdate(todo: Todo, draft: EditDraft): { description?: string; notes?: string } {
    const update: { description?: string; notes?: string } = {};
    const description = draft.description.trim();
    if (description !== todo.description) update.description = description;
    if (draft.notes !== (todo.notes ?? '')) update.notes = draft.notes;
    return update;
}

/** Replaces the Todo with the same id, keeping order. */
export function replaceTodo(todos: Todo[], next: Todo): Todo[] {
    return todos.map((todo) => (todo.id === next.id ? next : todo));
}

export function removeTodo(todos: Todo[], id: string): Todo[] {
    return todos.filter((todo) => todo.id !== id);
}

export function formatTimestamp(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
