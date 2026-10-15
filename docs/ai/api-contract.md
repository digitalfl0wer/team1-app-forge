# Resolver and Data Contract

Extend what exists. Do not rename existing resolvers, change their current response shapes, or rewrite `src/frame/src/App.tsx` from scratch.

## Conventions

- Todo and run IDs are **strings** (BIGINT AUTO_RANDOM exceeds JS safe integers). Query with `CAST(todo_id AS CHAR) AS id` and bind with `CAST(? AS SIGNED)`, as the existing resolvers do.
- Every resolver validates its payload at runtime with zod. Never trust TypeScript types for browser input.
- SQL always uses `.prepare(...).bindParams(...)`.
- New resolvers return `{ success: true, ... }` or `{ success: false, error: { code, message } }`. They do not throw for expected failures. `message` is user-safe (no stack traces, no secrets).
- Error codes: `INVALID_INPUT`, `NOT_FOUND`, `STALE_CONTENT`, `NOT_ALLOWED_MODEL`, `NO_ELIGIBLE_MODEL`, `NEEDS_CLARIFICATION`, `BLOCKED_BY_GUARD`, `PROVIDER_ERROR`, `TIMEOUT`, `RATE_LIMITED`, `INSUFFICIENT_CREDIT`, `INTERNAL`.
- AI failure never changes or deletes a Todo.

## Existing resolvers (keep as-is, extend additively)

| Resolver | Payload | Returns |
|---|---|---|
| `addTodo` | `{ description }` | `{ success: boolean }` (unchanged) |
| `getTodo` | `{ id }` | Todo or `null` |
| `getTodos` | none | `Todo[]` ordered by `created_at DESC` |

`Todo` gains additive fields: `notes`, `ai_state`, `content_version`, `updated_at`. Existing fields stay.

```ts
type Todo = {
  id: string;
  description: string;       // the task text, 1-255 chars
  notes: string | null;      // optional detail, up to 5000 chars
  status: 'todo' | 'up_next' | 'in_progress' | 'done';
  ai_state: 'not_started' | 'classifying' | 'awaiting_confirmation' | 'running' | 'succeeded' | 'failed';
  content_version: number;   // bumps when description or notes change
  created_at: string;
  updated_at: string;
};
```

## Schema migrations (append-only; never edit `v001`)

### `v002` to `v005` (landed): `v002_todos_add_notes`, `v003_todos_add_ai_state`, `v004_todos_add_content_version`, `v005_todos_add_updated_at`

```sql
ALTER TABLE Todos ADD COLUMN notes TEXT NULL;
ALTER TABLE Todos ADD COLUMN ai_state VARCHAR(30) NOT NULL DEFAULT 'not_started';
ALTER TABLE Todos ADD COLUMN content_version INT NOT NULL DEFAULT 1;
ALTER TABLE Todos ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
```

Forge SQL migrations run one statement per `enqueue`; enqueue each statement as its own named migration (`v002_...`, `v003_...`) following the existing pattern in `src/sql/migration.ts`. Existing rows keep working through the defaults.

### `v006_create_ai_runs` (AI wave; next free migration number)

```sql
CREATE TABLE IF NOT EXISTS AiRuns (
  run_id BIGINT PRIMARY KEY AUTO_RANDOM,
  todo_id BIGINT NOT NULL,
  content_version INT NOT NULL,
  status VARCHAR(30) NOT NULL,
  classification TEXT NULL,
  candidates TEXT NULL,
  recommended_model VARCHAR(100) NULL,
  confirmed_model VARCHAR(100) NULL,
  response MEDIUMTEXT NULL,
  prompt_tokens INT NULL,
  completion_tokens INT NULL,
  cost_usd DECIMAL(12,8) NULL,
  error_code VARCHAR(40) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,
  INDEX idx_airruns_todo (todo_id)
);
```

Run statuses: `classifying`, `awaiting_confirmation`, `running`, `succeeded`, `failed`, `stale`, `needs_clarification`, `blocked_by_guard`, `no_eligible_model`. Foreign keys are not relied on: `deleteTodo` deletes the Todo's `AiRuns` rows in code first.

## New CRUD resolvers

| Resolver | Payload | Behaviour |
|---|---|---|
| `updateTodo` | `{ id, description?, notes? }` | At least one field required. If `description` or `notes` actually changed: `content_version + 1`, `ai_state = 'not_started'`, and any run in `awaiting_confirmation` becomes `stale`. Returns `{ success: true, todo }`. |
| `setTodoStatus` | `{ id, status }` | `status` in `todo | up_next | in_progress | done`. Does not touch `content_version` or AI state. Returns `{ success: true, todo }`. |
| `deleteTodo` | `{ id }` | Deletes `AiRuns` rows for the Todo (once that table exists), then the Todo. Returns `{ success: true }`. `NOT_FOUND` if absent. |

Validation: `id` matches `/^\d{1,20}$/`; `description` trimmed 1-255 chars; `notes` up to 5000 chars (empty string stores `NULL`); unknown payload keys rejected.

## AI resolvers (AI wave; shapes may be refined, the rules may not)

| Resolver | Payload | Behaviour |
|---|---|---|
| `startTask` | `{ todoId }` | Guard, classify, route. Creates an `AiRuns` row. Returns the run with `status`, `classification`, and `candidates` (per model: id, display name, pricing or `pricingUnavailable`, capabilities, `estimatedMaxCostUsd`, reason) plus `recommendedModelId`, `pricingUrl` fallback links. No worker executes. |
| `chooseCategory` | `{ runId, category }` | For `needs_clarification` runs: user picks a category from the enum; routing continues. |
| `confirmRun` | `{ runId, modelId }` | Re-reads the run. Rejects unless the run is `awaiting_confirmation`, `modelId` is in the stored candidates and still enabled/approved, and the Todo's `content_version` still equals the run's. Then executes with the V1 caps and stores response, usage, and cost. |
| `getAiRuns` | `{ todoId }` | Run history newest first. Never overwritten. |
| `getModels` | none | Registry plus cached OpenRouter metadata, with `fetchedAt` and `source` (`live`, `cache`, `snapshot`). |
| `refreshModels` | none | Refetch metadata, update cache. |

## Frontend rules

- Statuses in the UI: To do, Up next, In progress, Done.
- The list view stays recognisable. Add: tab bar (Todos, Models), status filter, ellipsis menu per Todo.
- Model output is rendered as plain text. No `dangerouslySetInnerHTML`.
- AI errors are shown inline on the detail view with a retry; the Todo stays usable.
- External links use `router.open(url)` from `@forge/bridge`.
