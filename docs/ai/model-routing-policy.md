# Model Routing Policy

> V1 is text-only; media models are registered but disabled until V2. See `docs/ai/v1-scope.md`, which is binding.

## Purpose

This document defines how Team 1 Todo selects an AI model after task classification.

The classifier identifies task requirements.

Deterministic application code selects from the approved model registry.

## Core Principle

**Use the least expensive model that reliably satisfies the task requirements.**

Do not assume:

- most expensive = best
- newest = best
- biggest = best
- most popular = best

Task fit and hard capability requirements come first.

Cost optimization happens only among eligible models.

## Approved Registry

Only models in the application allowlist may execute.

The browser, user text, classifier output, and worker-model output may not add arbitrary model IDs.

Current approved registry:

| Role | Model ID |
|---|---|
| Router / classifier | `openai/gpt-6-luna` |
| Router / classifier (disabled; output modality `decisions`, not callable as a chat model) | `openai/gpt-6-luna-decisions` |
| Safety | `meta-llama/llama-guard-4-12b` |
| Budget coding / agentic | `deepseek/deepseek-v4.1-flash` |
| Multimodal / research | `google/gemini-3.8-flash` |
| Balanced premium | `anthropic/claude-sonnet-5.5` |
| Professional / agentic | `openai/gpt-6.1-sol` |
| Heavy reasoning / coding | `anthropic/claude-opus-5.5` |
| Image generation/editing (V2, disabled in V1) | `google/gemini-3.1-flash-image` |
| Speech/audio (V2, disabled in V1) | `elevenlabs/eleven-v4-turbo` |
| Video (V2, disabled in V1) | `google/veo-3.1-lite` |

Note: the registry (`src/ai/modelRegistry.ts`) has 11 entries. Enabled in V1: `openai/gpt-6-luna`, `meta-llama/llama-guard-4-12b`, and the five text workers. Disabled: `openai/gpt-6-luna-decisions`, `google/gemini-3.1-flash-image`, `elevenlabs/eleven-v4-turbo`, `google/veo-3.1-lite`.

Exact availability and volatile metadata must be checked from OpenRouter rather than assumed from this document.

## Registry Metadata

Stable application-owned fields may include:

- id
- displayName
- role
- executorType
- approved
- enabled
- strengths
- categories
- routingTier
- product-specific notes

Volatile provider metadata should be retrieved/normalized from OpenRouter where available:

- pricing
- context length
- input modalities
- output modalities
- supported parameters
- provider availability
- latency/throughput information

Do not scatter model IDs or permanent prices through the codebase.

## Executor Types

The registry must distinguish executor types.

Suggested application-level executor types:

- decisions (kept in the list for completeness; the registry code uses `router` for the classifier role)
- guard
- text
- image
- audio
- video

The only `decisions`-type model, `openai/gpt-6-luna-decisions`, is disabled (`enabled: false`) and not used in V1. The router role is filled by `openai/gpt-6-luna`.

Not all OpenRouter models use the same endpoint or lifecycle.

Examples:

- GPT-6 Luna (`openai/gpt-6-luna`) is a normal chat model used with structured outputs.
- GPT-6 Luna Decisions (`openai/gpt-6-luna-decisions`) has output modality `decisions` and is disabled. Its calling convention is unverified; do not assume an OpenRouter "Decisions API" exists.
- standard text workers use text/chat generation.
- Eleven v4 Turbo uses speech generation.
- Veo video generation may use an asynchronous job lifecycle.

The application should expose a common internal execution contract while dispatching to the correct executor behind it.

## Routing Stage 1 — Determine Required Output Type

Determine which output the user is requesting:

- text
- image
- audio
- video

Do not compare incompatible executor types against each other.

A request to generate a video should not score Claude Opus against Veo.

## Routing Stage 2 — Hard Filters

Before scoring, remove any model that fails a hard requirement.

Possible hard filters:

- not approved
- disabled
- wrong executor type
- unsupported input modality
- unsupported output modality
- context window too small
- required tool support missing
- required structured-output support missing
- model/provider unavailable
- task-specific restriction not met

Hard requirements always override price.

A cheap model that cannot perform the requested task is not a valid recommendation.

## Routing Stage 3 — Weighted Scoring

Only eligible models are scored.

Keep weights centralized in one routing configuration/module.

Possible factors:

- primary category fit
- subcategory fit
- reasoning-level fit
- coding strength
- research strength
- writing strength
- multimodal fit
- long-context fit
- tool-use support
- structured-output support
- current price
- current latency
- current provider availability

The exact weights are an application policy decision and must be testable.

Avoid logic scattered throughout the code such as:

```ts
if (category === "coding") {
  return "anthropic/claude-opus-5.5";
}
```

Prefer registry metadata plus centralized scoring.

## Cost Scoring

Cost should influence selection after hard requirements are satisfied.

Normalize current provider pricing into comparable application metrics where possible.

For text models, useful fields may include:

- input price
- output price
- estimated cost for the request

For media models, pricing units may differ.

Examples:

- characters for speech
- seconds/resolution for video
- image/output-specific pricing

Do not pretend unlike pricing units are directly comparable without normalization.

## Selection Philosophy

The router should generally choose the least expensive capable option when candidate quality is sufficiently close.

A premium model may win when the task's actual requirements justify it.

Examples:

**Simple rewrite**

A low-cost text worker should normally beat a heavy reasoning model.

**Complex codebase debugging**

A stronger coding/reasoning model may be justified.

**Image generation**

Only eligible image-generation executors should compete.

**Video generation**

Only eligible video-generation executors should compete.

## Recommendation Contract

The router should return enough information for an explainable UI.

Suggested normalized result:

```json
{
  "recommendedModelId": "deepseek/deepseek-v4.1-flash",
  "reason": "Strong fit for coding/debugging with lower estimated cost than premium eligible models.",
  "detectedCategory": "coding",
  "eligibleModelIds": [
    "deepseek/deepseek-v4.1-flash",
    "anthropic/claude-sonnet-5.5",
    "openai/gpt-6.1-sol",
    "anthropic/claude-opus-5.5"
  ],
  "cheaperAlternativeModelId": null,
  "strongerAlternativeModelId": "anthropic/claude-sonnet-5.5"
}
```

The exact schema may be adjusted during implementation, but the decision must remain explainable.

## Recommendation UI

Before worker execution, show:

- recommended model
- reason
- task category
- detected capabilities
- current pricing
- relevant context/capability information
- cheaper alternative when appropriate
- stronger alternative when appropriate

Clearly state that actual cost depends on usage.

## User Confirmation

Recommendation is not execution.

A worker model must not run until the user explicitly confirms a model.

The backend must enforce confirmation independently of frontend state.

Do not accept arbitrary browser-supplied model IDs.

When confirmation is submitted:

1. validate the Todo/run state
2. validate the selected model against the allowlist
3. verify it remains eligible
4. record the confirmed model
5. only then execute

## Model Availability Changes

A model may become unavailable after recommendation.

If that happens:

- do not silently choose another model
- return an availability error
- refresh eligible recommendations
- show the replacement to the user
- require confirmation again if the selected model changes

## Safety Model

Llama Guard may supplement input/output safety classification.

It must not be scored as a normal worker model.

Safety classification does not replace application-level controls.

## Router Model

GPT-6 Luna (`openai/gpt-6-luna`) performs classification/routing questions through chat completions with a strict JSON-schema response format.

It must not be scored as a normal worker merely because it is in the registry.

Its output is input to deterministic routing code.

`openai/gpt-6-luna-decisions` stays in the registry but is disabled and is never used as the router.

## Specialized Media Models

Image, audio, and video generators have different output types and may have different endpoint/lifecycle requirements. They are V2; in V1 they are disabled and hard-filtered out.

The router must select only compatible executor types.

The UI and backend must not claim a media result exists until the provider has actually produced it.

For asynchronous jobs, store a pending/running state until completion.

## Failures

### No eligible model

Return a defined no_eligible_model condition.

Do not guess.

User-facing message:

> None of the currently approved models support everything this task requires.

### Recommended model unavailable

Return an availability failure and produce a refreshed recommendation set.

Do not silently upgrade.

### Missing current metadata

If pricing/availability metadata cannot be retrieved:

- do not fabricate current pricing
- display the last known snapshot price labelled with its date (or "Price unavailable" if no price exists), with OpenRouter links
- still require explicit user confirmation before execution
- show links to check it on OpenRouter: `https://openrouter.ai/models` and `https://openrouter.ai/<model-id>`

## Evaluation

Routing must eventually be tested independently from model output quality.

Create representative tasks such as:

- simple rewrite
- summarization
- code debugging
- SQL/data analysis
- screenshot analysis
- long-document analysis
- image generation
- speech generation
- video generation
- complex architecture reasoning

For each test, define:

- expected category
- hard capability requirements
- acceptable model set
- unacceptable model set

Classifier quality and deterministic selection should be evaluated separately.

## Core Separation

Classifier:

> What does the task require?

Router:

> Which approved model best satisfies those requirements under our policy?

User:

> Do I approve that worker before it runs?
