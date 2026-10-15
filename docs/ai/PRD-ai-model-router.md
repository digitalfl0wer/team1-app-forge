# PRD — AI Model Router

> **V1 scope:** V1 is text-only. Image, audio and video generation, and attachments, are V2. See `docs/ai/v1-scope.md`, which is binding and wins over this document where they differ. Sections below marked **(V2)** are not built in V1.

## Product

Team 1 Todo — Atlassian Forge Jira Application

## Owner

Brie — AI Model Routing / AI Context Integration

## Status

V1 implementation

## Purpose

Team 1 Todo is an existing Todo application running inside Jira using Atlassian Forge.

This feature expands the existing application with a secure AI task-routing and execution layer.

The core product idea is:

**Choose the right AI model for the task instead of sending every task to the same model.**

AI is an enhancement to the Todo application. Normal Todo functionality must continue to work when AI is unavailable.

## Product Principles

1. Normal Todo CRUD must work without AI.
2. Creating a Todo must not call AI.
3. Opening or editing a Todo must not call AI.
4. AI begins only when the user explicitly clicks Start Task.
5. A low-cost classifier determines what the task requires.
6. Application code, not the LLM, chooses from an approved model registry.
7. The user sees the recommendation, capabilities, and current pricing before worker execution.
8. The user must explicitly confirm the worker model before execution.
9. AI responses are attached to the Todo.
10. Multiple AI runs are preserved as history.
11. AI failures must never delete, corrupt, or block access to a Todo.
12. Security and cost controls are enforced by application code, not only by prompts.
13. The existing frontend should be extended, not redesigned.

## Existing Application Architecture

Current request path:

```text
React/Vite frontend
→ Forge Bridge invoke()
→ Forge resolver
→ Forge SQL
```

- Active frontend source: `src/frame`
- Forge backend resolver: `src/resolvers/index.ts`
- Forge SQL migrations: `src/sql/migration.ts`
- Forge entry point: `src/index.ts`
- Forge configuration: `manifest.yml`

Generated output must not be edited directly:

- `dist/`
- `src/frame/build/`

## Core Todo Requirements

The Todo application must support full CRUD independently of AI.

### Create

A user can create a Todo.

Creating a Todo:

- saves the task
- does not call OpenRouter
- sets `ai_state` to `not_started`

The existing description column should remain the short task text for V1 to avoid an unnecessary destructive rename.

### Read

A user can:

- view all Todos
- open an individual Todo
- view its current status
- view AI state (`ai_state`)
- view prior AI runs

### Update

A user can update:

- task text (`description`)
- longer task details (`notes`)
- status

Supported Todo statuses:

- todo
- up_next
- in_progress
- done

Changing task text or notes bumps `content_version`, resets `ai_state` to `not_started`, and marks any run awaiting confirmation as `stale`, which invalidates a stale AI recommendation.

Changing status alone must not trigger AI analysis.

### Delete

A user can delete a Todo.

Deleting a Todo must also clean up dependent application-owned AI run records (and attachment metadata as appropriate, once attachments exist in V2).

## Task Detail Experience

The existing Todo list should remain visually recognizable.

Each Todo should provide an ellipsis menu with:

- Open
- Edit
- Change status
- Delete

Opening a Todo should provide a detail view containing:

- task text
- notes (longer details)
- status
- attachment area **(V2)**
- AI state
- Start Task button
- model recommendation
- pricing/capability details
- AI response history

Opening a Todo does not call AI.

## Start Task Flow

AI begins only after the user deliberately clicks Start Task.

Expected flow:

```text
Todo
→ Start Task
→ Task classification
→ Capability detection
→ Approved model registry
→ Deterministic model filtering/scoring
→ Recommendation
→ Price + capabilities + reason
→ User confirmation
→ Model execution
→ Response stored
→ Result attached to Todo
```

## Task Classification

The classifier's responsibility is to understand the task.

The classifier does not freely select a model.

Logical classification shape:

```json
{
  "category": "coding",
  "subcategory": "debugging",
  "requirements": ["code_reasoning", "structured_output"],
  "inputModalities": ["text"],
  "outputModality": "text",
  "reasoningLevel": "high",
  "needsTools": false,
  "needsLongContext": false,
  "confidence": 0.94
}
```

Initial primary categories:

- coding
- research
- writing
- data
- reasoning_planning
- summarization
- multimodal
- image_generation
- audio_generation
- video_generation
- automation_tool_use
- general

The classifier output must be validated at runtime (zod schema in `src/ai/types.ts`).

Invalid classifier output: retry once; if it is still invalid, the run ends with status `needs_clarification` (the user picks a category). Confidence below 0.6 also ends as `needs_clarification`. The application never escalates to a more expensive model to compensate.

The classifier cannot authorize arbitrary model IDs.

In V1 the classifier is `openai/gpt-6-luna`, called as a normal chat model with a strict `json_schema` response format (see `docs/ai/v1-scope.md`, "How the classifier works"). Confidence below 0.6 ends the run as `needs_clarification`.

## Model Selection

Model selection happens in deterministic application code.

### Stage 1 — Determine executor/model type

Possible model roles:

- router
- guard
- text
- image
- audio
- video

### Stage 2 — Hard filters

Remove models that cannot satisfy hard task requirements.

Examples:

- model is not approved
- model is disabled
- wrong executor/model type
- unsupported input modality
- unsupported output modality
- insufficient context
- required tool support missing
- model currently unavailable

A cheap model that cannot perform the task is not eligible.

### Stage 3 — Scoring

Score the remaining eligible models using centralized routing policy.

Possible factors:

- primary category fit
- subcategory fit
- coding strength
- reasoning requirement
- multimodal capability
- long-context capability
- structured-output support
- tool-use support
- current cost
- current latency
- current availability

Primary routing principle:

**Use the least expensive model that reliably satisfies the task requirements.**

The most expensive, newest, largest, or most popular model should not automatically win.

### Stage 4 — Recommendation

Return:

- recommended model
- recommendation reason
- detected requirements
- current pricing
- useful capabilities
- cheaper alternative when appropriate
- stronger alternative when appropriate

### Stage 5 — User confirmation

Recommendation is not execution.

A worker model must not run until the user explicitly confirms the model.

There must be no silent escalation to a more expensive model.

## Approved OpenRouter Registry

The application uses a curated allowlist of eleven registry entries. Ten are enabled model roles; `openai/gpt-6-luna-decisions` is registered but disabled.

Exact availability and volatile metadata must be verified from OpenRouter at runtime or during initialization.

Note: the registry is now 11 entries, with `openai/gpt-6-luna-decisions` disabled.

### 1. Router / Classifier

- Name: GPT-6 Luna
- OpenRouter model ID: `openai/gpt-6-luna`

Purpose:

- classification
- routing
- requirement detection
- reporting classification confidence (low confidence asks the user; it never escalates)

Important implementation note: this is a normal chat model called through the standard chat-completions path with structured outputs (`response_format` of type `json_schema`, `strict: true`, `provider.require_parameters: true`).

### 1a. Router / Classifier (disabled)

- Name: GPT-6 Luna Decisions
- OpenRouter model ID: `openai/gpt-6-luna-decisions`
- State: registered, `enabled: false`

OpenRouter lists this model with output modality `decisions` and no chat parameters, so it is not callable as a chat model. Its calling convention is unverified. Do not assume an OpenRouter "Decisions API" exists. It must not be used as the router.

### 2. Safety

- Name: Llama Guard 4 12B
- OpenRouter model ID: `meta-llama/llama-guard-4-12b`

Purpose:

- input safety classification
- output safety classification

Llama Guard is defense-in-depth and is not the application's primary security boundary.

### 3. Budget Coding / Agentic

- Name: DeepSeek V4.1 Flash
- OpenRouter model ID: `deepseek/deepseek-v4.1-flash`

Purpose:

- coding
- debugging
- cost-efficient reasoning
- agentic workflows
- multimodal understanding where supported

### 4. Multimodal / Research

- Name: Gemini 3.8 Flash
- OpenRouter model ID: `google/gemini-3.8-flash`

Purpose:

- multimodal understanding
- research
- long-context work
- general reasoning

### 5. Balanced Premium

- Name: Claude Sonnet 5.5
- OpenRouter model ID: `anthropic/claude-sonnet-5.5`

Purpose:

- writing
- coding
- documents
- polished professional output
- feature development

### 6. Professional / Agentic

- Name: GPT-6.1 Sol
- OpenRouter model ID: `openai/gpt-6.1-sol`

Purpose:

- coding
- document-heavy work
- multi-step professional workflows
- agentic tasks

### 7. Heavy Reasoning / Coding

- Name: Claude Opus 5.5
- OpenRouter model ID: `anthropic/claude-opus-5.5`

Purpose:

- difficult reasoning
- large codebase work
- complex debugging
- multi-step technical analysis

### 8. Image Generation / Editing (V2)

- Name: Nano Banana 2 / Gemini 3.1 Flash Image
- OpenRouter model ID: `google/gemini-3.1-flash-image`

Purpose:

- image generation
- image editing

### 9. Speech / Audio (V2)

- Name: Eleven v4 Turbo
- OpenRouter model ID: `elevenlabs/eleven-v4-turbo`

Purpose:

- text-to-speech
- generated spoken audio

### 10. Video (V2)

- Name: Veo 3.1 Lite
- OpenRouter model ID: `google/veo-3.1-lite`

Purpose:

- text-to-video
- image-to-video

In V1, models 8-10 stay in the registry with `enabled: false` and the router hard-filters them out.

## Model Metadata

Application-owned stable registry metadata may include:

- model ID
- display name
- role
- approved/enabled state
- strengths
- routing categories
- executor type
- product-specific notes

Volatile metadata should come from OpenRouter where available:

- current input pricing
- current output pricing
- context length
- modalities
- supported parameters
- provider availability
- latency/throughput metadata when useful

Do not treat prices copied into documentation as the application's source of truth.

If live pricing cannot be fetched or parsed, show the **last known price** from the committed registry snapshot, clearly labelled with its date (for example "Last known price (2026-10-15), live price unavailable"), still require explicit confirmation, and show links to check current pricing on OpenRouter: `https://openrouter.ai/models` and `https://openrouter.ai/<model-id>`. Show "Price unavailable" only when no price exists at all (live or snapshot). Never invent a price. (see `docs/ai/v1-scope.md`).

## Provider / Executor Abstraction

Not all OpenRouter models execute through the same API shape.

The backend should expose a common application-level execution interface while dispatching internally to the correct executor.

Logical executor types:

- classification (structured-output chat model; the disabled decisions model has no verified calling convention)
- text generation
- image generation/editing **(V2)**
- speech generation **(V2)**
- video generation **(V2)**

Video generation may require an asynchronous job lifecycle.

The UI should not pretend all model types are synchronous if the provider API is asynchronous.

## Recommendation Screen

Before worker execution, display:

- task category
- detected requirements
- recommended model
- why it was recommended
- current input/output pricing or relevant media pricing (or the labelled last known snapshot price, with OpenRouter links)
- context size when relevant
- supported modalities/capabilities
- cheaper alternative when appropriate
- stronger alternative when appropriate

The UI must clearly state that actual cost depends on usage.

## User Confirmation

Classification may occur automatically after Start Task.

Worker execution may not.

The user must explicitly approve the selected worker model before execution.

The backend must independently enforce this rule. It must not rely only on a disabled frontend button.

## AI Results and History

AI output is attached to its Todo.

Do not overwrite old AI responses.

A Todo may have multiple AI runs.

Each run should preserve enough information to answer:

- what model was used
- what happened
- whether it succeeded
- what it cost
- what it returned
- when it ran

## Data Model

### Existing Todos table

Keep the existing Todo ID, short task text, status, and created timestamp.

Add fields through new versioned migrations rather than modifying an already-applied migration.

Todo columns added by migrations `v002` to `v005` (landed), exactly as defined in `docs/ai/api-contract.md` ("Schema migrations" and the `Todo` type): `notes`, `ai_state`, `content_version`, `updated_at`. Statuses are `todo`, `up_next`, `in_progress`, `done`.

AI states (`Todo.ai_state`): `not_started`, `classifying`, `awaiting_confirmation`, `running`, `succeeded`, `failed`. Per-run statuses (`classifying`, `awaiting_confirmation`, `running`, `succeeded`, `failed`, `stale`, `needs_clarification`, `blocked_by_guard`, `no_eligible_model`) live on the `AiRuns` row; see the contract for how `ai_state` mirrors the latest run.

Older names from earlier drafts of this PRD (not used): a single `details` column (now `notes`), `ai_status`, and the states `analyzing`, `recommendation_ready`, `completed`, `analysis_failed`, `execution_failed`, `cancelled`. Per-Todo category, routing and model-selection fields are not Todo columns; they live on the run.

### AiRuns table

Use a separate table for execution history: `AiRuns`, migration `v006_create_ai_runs`. The column list is defined in `docs/ai/api-contract.md` ("`v006_create_ai_runs`") and is not repeated here.

### ModelCatalogCache table

Live OpenRouter model metadata is cached in the SQL table `ModelCatalogCache`, migration `v007` (see `docs/ai/api-contract.md`, "Behaviour rules"). It is not Forge storage.

Do not overwrite previous runs when the user runs a task again.

### Attachments / Artifacts (V2)

Attachments are not in V1. No storage exists and `attachments` stays out of the schema (see `docs/ai/v1-scope.md`). The following describes the V2 direction.

Attachment metadata may live in SQL.

Suggested metadata:

- attachment/artifact ID
- Todo ID
- optional AI run ID
- source: user or model
- media type
- filename
- MIME type
- storage key/location
- byte size
- created timestamp

Large binary media should not be stored in the main Todo row.

Use an appropriate object/file storage mechanism for actual media bytes.

## Backend Resolver/API Responsibilities

Existing:

- addTodo
- getTodo
- getTodos

Add or extend as appropriate:

- updateTodo
- setTodoStatus
- deleteTodo
- startTask (guard, classify, route; returns the recommendation)
- chooseCategory (user picks a category for a `needs_clarification` run)
- confirmRun (explicit confirmation, then execution)
- getAiRuns (run history)
- getModels
- refreshModels

Payloads and return shapes are defined only in `docs/ai/api-contract.md`. (Older draft names `routeTodo`, `getModelRecommendations`, `executeTodo` and `getTodoRuns` are not used.)

Potential attachment/artifact resolvers may be added when media storage is implemented (V2).

Resolver responsibilities:

- runtime-validate browser payloads
- enforce model allowlist
- enforce user confirmation
- access Forge SQL
- access encrypted backend secrets
- call OpenRouter
- normalize external errors
- return only safe data to the frontend

## Frontend Requirements

Preserve the existing frontend design and behavior.

Add only the UI required for:

- CRUD
- task details
- Start Task
- recommendation
- confirmation
- execution state
- results/history
- attachments/artifacts (V2)

The frontend must never contain or receive the OpenRouter API key.

## Multimodal Support (V2)

V1 is text-only. The following is the longer-term architecture direction.

The architecture should support inputs:

- text
- images
- documents
- audio
- video

The architecture should support outputs:

- text
- image
- audio
- video

Not every model supports every modality.

Routing must hard-filter incompatible models.

If a media executor is not yet implemented, the application must show that capability as unavailable rather than falsely claiming success.

## Security Requirements

The repository is public.

Therefore:

- no OpenRouter secret may exist in Git
- no secret may exist in frontend code
- no secret may be sent to the browser
- no secret may appear in logs
- OpenRouter requests originate from Forge backend code
- external egress is restricted to required domains
- resolver payloads are validated at runtime
- SQL uses prepared statements/bound parameters
- only allowlisted models may execute
- model output is treated as untrusted
- model output cannot authorize new permissions or arbitrary model IDs
- user confirmation is enforced server-side
- requests have token/time/cost guardrails (V1: worker `max_completion_tokens` 1500, OpenRouter request timeout 20 s)
- AI failure never breaks normal Todo CRUD

See `docs/ai/security.md`.

## Context Architecture

### PRD

Defines what the product should do and why.

### AGENTS.md

Defines how coding agents should work in this repository.

### Runtime skill

Defines how the runtime task classifier should classify a Todo.

### Model routing policy

Defines how deterministic application code selects among eligible models.

### Dynamic runtime context

May include only what is relevant to the current operation:

- current Todo task text
- current Todo notes
- explicitly attached files (V2)
- current model metadata
- confirmed model choice
- prior run metadata when useful

Do not dump every available document or record into every request.

## Multi-Agent Architecture

V1 is not intentionally designed as a complex multi-agent orchestration system.

Classifier, router, guardrails, and executors are separate responsibilities and may remain ordinary application modules/functions.

Introduce separate agents only if responsibilities later require materially different:

- tools
- permissions
- context
- reasoning process
- lifecycle

## Failure Handling

AI failures must degrade gracefully.

Handle at minimum:

- classification failure
- invalid classifier result (retry once, then `needs_clarification`)
- OpenRouter timeout
- provider unavailable
- model unavailable
- rate limit
- insufficient credit
- no eligible model
- malformed model response
- safety rejection
- execution failure
- cancelled request (no cancelled state exists in V1; see `docs/ai/api-contract.md`)

Examples of human-readable messages:

Classification failure:

> We couldn't analyze this task right now. Your task is safe. Try again when you're ready.

(Used for provider failures during classification. Invalid or low-confidence classifier output is not a failure state: the run is `needs_clarification` and the user picks a category.)

No eligible model:

> None of the currently approved models support everything this task requires.

Model unavailable:

> That model isn't available right now. Choose another recommended model or try again.

Rate limited:

> The AI service is receiving too many requests right now. Please try again shortly.

Insufficient credit:

> This request can't run because the AI account does not currently have enough available credit.

Technical details belong in backend logs without secrets.

## Acceptance Criteria

V1 is complete when:

- normal CRUD works without AI
- task details can be added and edited
- creating a Todo does not invoke AI
- opening a Todo does not invoke AI
- editing a Todo does not automatically invoke AI
- Start Task initiates classification
- classifier output is runtime validated
- unapproved models cannot execute
- hard capability filters run before scoring
- recommendation is deterministic and explainable
- current pricing is shown when available (otherwise the labelled last known snapshot price, or "Price unavailable" if none, with OpenRouter links)
- the user must confirm before worker execution
- backend also enforces confirmation
- text execution works end-to-end
- AI response is attached to the Todo
- previous AI runs remain available
- failure states are visible and recoverable
- secrets remain backend-only
- AI failure never breaks CRUD
- all 11 registry entries are represented (`openai/gpt-6-luna-decisions` and the V2 media models disabled)
- media executor support is accurately reported and never faked
- type-check/lint/build checks pass or known blockers are documented

## Future Work

Potential future additions:

- Budget / Balanced / Maximum Quality user preferences
- automatic routing eval suite
- compare multiple models on the same task
- confidence-based escalation: intentionally not done. Low confidence asks the user to pick a category; it never silently upgrades to a more expensive model
- embeddings
- semantic Todo search
- RAG over approved project documents
- richer Jira issue context
- category-specific runtime skills
- model performance history
- personalized routing based on observed results
- justified multi-agent orchestration
