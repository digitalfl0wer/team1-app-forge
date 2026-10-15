# V1 Scope and Decisions

Status: agreed 2026-10-15. This file is the tie-breaker when the other docs in `docs/ai/` are broader than V1.

## In V1

- Full Todo CRUD that works with AI completely off, timed out, or failing.
- Statuses: `todo`, `up_next`, `in_progress`, `done`.
- Ellipsis menu per Todo: Open, Edit, Change status, Delete.
- Detail view with task, notes, status, AI state, Start Task, recommendation, run history.
- **Start Task** is the only AI trigger. Creating, opening, editing, or changing status never calls AI.
- Text models only. Classification, deterministic routing, price/capability confirmation, execution, stored history.
- A **Models** tab listing every registry model with live metadata (price, context window, modalities, supported parameters).
- Unit tests for validation, routing, classification parsing, and the OpenRouter client (mocked fetch).

## Not in V1 (V2 notes)

- **Image, audio, video generation.** Models stay in the registry with `enabled: false`; the router hard-filters them out. V2 needs an async job (Forge queue consumer, up to 15 minutes), a `todo_media` table, and a polling resolver. Storage options and limits are summarised below.
- **Attachments.** No storage in V1. `attachments` stays out of the schema.
- Drag-and-drop board, priorities, due dates.

### V2 media storage (research summary, 2026-10-15)

| Option | Limit | Status | Fit |
|---|---|---|---|
| Forge SQL (blob/text) | 6 MiB row, 4 MiB response | GA | small images, short audio |
| KVS / Custom Entities | 240 KiB per value | GA | metadata and URLs |
| Forge Object Store | 1 GB per object | Preview/EAP | video and large files; resolver-side upload unconfirmed |
| Jira attachments via `requestJira` | not found | GA | needs an issue; poor fit for a Todo |
| Provider URL only | provider-defined | n/a | not durable; needs `permissions.external.media` entries |

First V2 task: test whether the Custom UI frame can display `data:` / `blob:` images and audio.

## Models and routing decisions

- **Router / classifier: `openai/gpt-6-luna`** (cheap, supports structured outputs). `openai/gpt-6-luna-decisions` is registered but `enabled: false`: OpenRouter lists it with output modality `decisions` and no chat parameters, so it is not callable as a chat model.
- **Guard: `meta-llama/llama-guard-4-12b`.** Plain text output (`safe`, or `unsafe` plus hazard codes). Not a worker. `unsafe` blocks the run with status `blocked_by_guard`. A guard transport error is logged and the run continues. Unparseable guard output counts as a guard error.
- **Text workers:** `deepseek/deepseek-v4.1-flash`, `google/gemini-3.8-flash`, `anthropic/claude-sonnet-5.5`, `openai/gpt-6.1-sol`, `anthropic/claude-opus-5.5`.
- `claude-sonnet-5.5` and `gpt-6.1-sol` are priced the same, so the registry must give the router a capability reason to prefer one (Sol: tool use / agentic; Sonnet: balanced writing and coding).
- `strengths` in the registry are the team's assessment, not benchmarks. Label them that way in the UI.

## How the classifier works

Input: task text (`description`) and `notes` only. No other Todos, no Jira data, no secrets.

1. **Guard check** on the input text.
2. **Classify** with `openai/gpt-6-luna`: `temperature: 0`, `max_completion_tokens: 300`, `response_format` `json_schema` with `strict: true` and `provider.require_parameters: true`.
3. The schema contains only enums, booleans and a number: `category`, `subcategory` (enum per category), `requirements[]`, `inputModalities[]`, `outputModality`, `reasoningLevel`, `needsTools`, `needsLongContext`, `confidence`. **No model IDs and no free text**, so prompt injection in a Todo cannot steer anything beyond those enums.
4. The Todo text is wrapped in delimiters and labelled as untrusted data in the prompt.
5. **zod validates** the parsed JSON server-side. On failure, retry once; after that the run ends as `needs_clarification`.
6. **`confidence < 0.6`** (one constant, easy to tune) also ends as `needs_clarification`: the UI asks the user to pick a category, then deterministic routing continues. Never escalate to an expensive model to compensate for low confidence.
7. **Deterministic router** (no LLM): hard filters first (approved, enabled, executor type, modalities, context, structured-output/tool support), then centralised weighted scoring, then least-expensive among close scores.
8. Recommendation plus alternatives are stored on the run. The user confirms a model; only a model in the stored candidate list may execute.

## Limits

- Worker `max_completion_tokens`: **1500** for V1.
- OpenRouter request timeout: **20 s** (Forge resolver limit is 25 s). Timeout is a stored run status, never an error that touches the Todo.
- Retries: one retry for 429/5xx on classification; none on worker runs (user can click retry).
- Cost shown before confirm: worst case = estimated input tokens x input price + 1500 x output price. Actual `usage.cost` from OpenRouter is stored after the run.

## Pricing when live data is unavailable

If live pricing cannot be fetched or parsed, show the **last known price** from the committed registry snapshot, clearly labelled with its date (for example "Last known price (2026-10-15), live price unavailable"), still require explicit confirmation, and show links to check current pricing on OpenRouter: `https://openrouter.ai/models` and `https://openrouter.ai/<model-id>`. Show "Price unavailable" only when no price exists at all (live or snapshot). Never invent a price.

Links:

- General: `https://openrouter.ai/models`
- Per model: `https://openrouter.ai/<model-id>` (for example `https://openrouter.ai/anthropic/claude-sonnet-5.5`)

In the Custom UI frame open external links with `router.open(url)` from `@forge/bridge`. Verify in the tunnel that the link opens.

## Mock provider

Because `forge tunnel` uses the deployed manifest, real OpenRouter calls only work after the egress permission is deployed. The OpenRouter client therefore has a mock mode returning canned classification, guard, and worker responses. It is enabled only when `AI_MOCK=1` is set (tunnel: `FORGE_USER_VAR_AI_MOCK=1`), and is off by default. It must never be enabled in a deployed environment by default.

## Deploy sequence (Brie runs this at the end)

1. `forge lint`
2. `forge variables set --encrypt -e development OPENROUTER_API_KEY` (paste at the prompt)
3. `forge deploy -e development` (add `--approve MAJOR_VERSION_RULE` if lint stops on it)
4. `forge install --upgrade -e development` (site: `one-atlas-ufiq.atlassian.net`)
5. Run the schema-migration webtrigger once
6. Tunnel: `export FORGE_USER_VAR_OPENROUTER_API_KEY=...` in the terminal that runs `forge tunnel -e development`
