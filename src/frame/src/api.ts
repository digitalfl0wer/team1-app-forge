import { invoke } from '@forge/bridge';
import { isTodoStatus, type Todo, type TodoStatus } from './todoView';
import { parseModels, parseRun, parseRuns } from './aiParse';
import type { AiRun, ModelsResult } from './aiTypes';

export type { Todo, TodoStatus } from './todoView';

export class ApiError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'ApiError';
        this.code = code;
    }
}

const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

/** The backend reports a not-yet-migrated database as INTERNAL on writes; the list stays readable. */
export const isDatabaseUpdating = (err: unknown): boolean =>
    err instanceof ApiError && err.code === 'INTERNAL';

/** User-safe text for any thrown value. */
export function errorMessage(err: unknown): string {
    return err instanceof ApiError ? err.message : GENERIC_MESSAGE;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function isTodo(value: unknown): value is Todo {
    return (
        isObject(value) &&
        typeof value.id === 'string' &&
        typeof value.description === 'string' &&
        (value.notes === null || typeof value.notes === 'string') &&
        isTodoStatus(value.status) &&
        typeof value.created_at === 'string'
    );
}

/** Turns a raw resolver result into data, or throws an ApiError. */
function unwrap(result: unknown): Record<string, unknown> {
    if (isObject(result) && result.success === false) {
        const error = result.error;
        if (isObject(error) && typeof error.message === 'string' && error.message) {
            throw new ApiError(typeof error.code === 'string' ? error.code : 'INTERNAL', error.message);
        }
        throw new ApiError('INTERNAL', GENERIC_MESSAGE);
    }
    if (isObject(result) && result.success === true) return result;
    throw new ApiError('INTERNAL', GENERIC_MESSAGE);
}

async function call(name: string, payload?: Record<string, unknown>): Promise<unknown> {
    try {
        return await invoke<unknown>(name, payload);
    } catch (err) {
        console.error(`${name} failed`, err);
        throw new ApiError('INTERNAL', GENERIC_MESSAGE);
    }
}

function todoFrom(result: unknown): Todo {
    const data = unwrap(result);
    if (!isTodo(data.todo)) throw new ApiError('INTERNAL', GENERIC_MESSAGE);
    return {
        ...data.todo,
        ai_state: data.todo.ai_state ?? 'not_started',
        content_version: data.todo.content_version ?? 1,
        updated_at: data.todo.updated_at ?? data.todo.created_at,
    };
}

export async function getTodos(): Promise<Todo[]> {
    const result = await call('getTodos');
    if (!Array.isArray(result)) {
        // A failure envelope is also user-safe to show.
        if (isObject(result) && result.success === false) unwrap(result);
        throw new ApiError('INTERNAL', 'Could not load todos.');
    }
    // A row with an unrecognised status is shown as "To do" rather than silently dropped:
    // hiding a Todo is worse than mislabelling it.
    return result.flatMap((row) => {
        if (!isObject(row)) return [];
        const candidate = {
            ...row,
            status: isTodoStatus(row.status) ? row.status : 'todo',
            notes: row.notes ?? null,
        };
        if (!isTodo(candidate)) return [];
        return [
            {
                ...candidate,
                ai_state: candidate.ai_state ?? 'not_started',
                content_version: candidate.content_version ?? 1,
                updated_at: candidate.updated_at ?? candidate.created_at,
            },
        ];
    });
}

export async function addTodo(description: string): Promise<void> {
    unwrap(await call('addTodo', { description }));
}

export async function updateTodo(
    id: string,
    fields: { description?: string; notes?: string }
): Promise<Todo> {
    return todoFrom(await call('updateTodo', { id, ...fields }));
}

export async function setTodoStatus(id: string, status: TodoStatus): Promise<Todo> {
    return todoFrom(await call('setTodoStatus', { id, status }));
}

export async function deleteTodo(id: string): Promise<void> {
    unwrap(await call('deleteTodo', { id }));
}

// AI resolvers. Shapes are pinned in docs/ai/api-contract.md.
const badShape = () => new ApiError('INTERNAL', GENERIC_MESSAGE);

function runFrom(result: unknown): AiRun {
    const run = parseRun(unwrap(result).run);
    if (!run) throw badShape();
    return run;
}

export async function startTask(todoId: string): Promise<AiRun> {
    return runFrom(await call('startTask', { todoId }));
}

export async function chooseCategory(runId: string, category: string): Promise<AiRun> {
    return runFrom(await call('chooseCategory', { runId, category }));
}

export async function confirmRun(runId: string, modelId: string): Promise<AiRun> {
    return runFrom(await call('confirmRun', { runId, modelId }));
}

export async function getAiRuns(todoId: string): Promise<AiRun[]> {
    const runs = parseRuns(unwrap(await call('getAiRuns', { todoId })).runs);
    if (!runs) throw badShape();
    return runs;
}

function modelsFrom(result: unknown): ModelsResult {
    const models = parseModels(unwrap(result));
    if (!models) throw badShape();
    return models;
}

export async function getModels(): Promise<ModelsResult> {
    return modelsFrom(await call('getModels'));
}

export async function refreshModels(): Promise<ModelsResult> {
    return modelsFrom(await call('refreshModels'));
}
