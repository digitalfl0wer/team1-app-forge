import { z } from 'zod';
import { CATEGORIES } from '../ai/types';

export const TODO_STATUSES = ['todo', 'up_next', 'in_progress', 'done'] as const;

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'STALE_CONTENT'
  | 'NOT_ALLOWED_MODEL'
  | 'NO_ELIGIBLE_MODEL'
  | 'NEEDS_CLARIFICATION'
  | 'BLOCKED_BY_GUARD'
  | 'PROVIDER_ERROR'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'INSUFFICIENT_CREDIT'
  | 'INTERNAL';

export type ErrorResult = { success: false; error: { code: ErrorCode; message: string } };

export const fail = (code: ErrorCode, message: string): ErrorResult => ({
  success: false,
  error: { code, message },
});

// IDs are BIGINT AUTO_RANDOM values that exceed JS safe integers, so they are digit strings.
export const idSchema = z.string().regex(/^\d{1,20}$/, 'id must be a string of 1-20 digits');

export const descriptionSchema = z
  .string()
  .trim()
  .min(1, 'description must not be empty')
  .max(255, 'description must be at most 255 characters');

// Empty string (and null) clears the notes; stored as NULL.
export const notesSchema = z
  .string()
  .max(5000, 'notes must be at most 5000 characters')
  .nullable()
  .transform((value) => (value === null || value === '' ? null : value));

export const statusSchema = z.enum(TODO_STATUSES);

export const addTodoSchema = z.strictObject({ description: descriptionSchema });

export const getTodoSchema = z.strictObject({ id: idSchema });

export const updateTodoSchema = z
  .strictObject({
    id: idSchema,
    description: descriptionSchema.optional(),
    notes: notesSchema.optional(),
  })
  .refine((value) => value.description !== undefined || value.notes !== undefined, {
    message: 'at least one of description or notes is required',
  });

export const setTodoStatusSchema = z.strictObject({ id: idSchema, status: statusSchema });

export const deleteTodoSchema = z.strictObject({ id: idSchema });

export const startTaskSchema = z.strictObject({ todoId: idSchema });

export const chooseCategorySchema = z.strictObject({ runId: idSchema, category: z.enum(CATEGORIES) });

export const confirmRunSchema = z.strictObject({
  runId: idSchema,
  modelId: z.string().min(1, 'modelId must not be empty').max(100, 'modelId must be at most 100 characters'),
});

export const getAiRunsSchema = z.strictObject({ todoId: idSchema });

/** Parses a payload; on failure returns a user-safe INVALID_INPUT envelope (no input echoed back). */
export function parsePayload<S extends z.ZodType>(
  schema: S,
  payload: unknown
): { ok: true; data: z.output<S> } | { ok: false; error: ErrorResult } {
  const parsed = schema.safeParse(payload ?? {});
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  const message = parsed.error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
  return { ok: false, error: fail('INVALID_INPUT', message) };
}
