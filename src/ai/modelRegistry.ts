import type { ModelCapabilities, ModelMetadata, RegistryModel } from './types';

/**
 * Approved model allowlist. This is the ONLY place model IDs live.
 *
 * App-owned fields (role, executorType, approved, enabled, categories, strengths,
 * routingTier, capabilities, notes) are authoritative. Volatile fields live in `snapshot`,
 * a committed fallback dated SNAPSHOT_DATE; live OpenRouter metadata overrides it at runtime.
 *
 * `categories`, `reasoningStrength` and `strengths` are the TEAM'S ASSESSMENT, not benchmarks.
 *
 * Sonnet 5.5 and GPT-6.1 Sol are priced identically (2/10), so price cannot separate them.
 * The profiles do instead:
 *   - Sol: professional / agentic. Higher automation_tool_use, data and reasoning_planning fit.
 *   - Sonnet: balanced writing and coding. Higher writing, coding and summarization fit.
 * Scoring (see router.ts) uses categoryFit plus a tool-use fit term, so tool/agentic tasks go
 * to Sol and writing/coding tasks go to Sonnet.
 */
export const SNAPSHOT_DATE = '2026-10-15';
const SNAPSHOT_FETCHED_AT = '2026-10-15T00:00:00.000Z';

export const MODELS_PRICING_URL = 'https://openrouter.ai/models';

export function modelPricingUrl(id: string): string {
  return `https://openrouter.ai/${id}`;
}

const NO_CAPS: ModelCapabilities = { structuredOutputs: false, tools: false, vision: false, longContext: false };

function snap(
  id: string,
  partial: Omit<ModelMetadata, 'id' | 'fetchedAt' | 'source' | 'supportedParameters' | 'maxCompletionTokens'> &
    Partial<Pick<ModelMetadata, 'supportedParameters' | 'maxCompletionTokens'>>,
): ModelMetadata {
  return {
    id,
    supportedParameters: [],
    maxCompletionTokens: null,
    ...partial,
    fetchedAt: SNAPSHOT_FETCHED_AT,
    source: 'snapshot',
  };
}

const TEXT_PARAMS = ['max_tokens', 'temperature', 'response_format', 'structured_outputs', 'tools', 'tool_choice'];

const REGISTRY: readonly RegistryModel[] = [
  {
    id: 'openai/gpt-6-luna',
    displayName: 'GPT-6 Luna',
    role: 'Router / classifier',
    executorType: 'router',
    approved: true,
    enabled: true,
    categories: {},
    reasoningStrength: 0.4,
    strengths: ['Cheap, fast classification with strict structured outputs (team assessment)'],
    routingTier: 'budget',
    capabilities: { structuredOutputs: true, tools: false, vision: true, longContext: false },
    notes: 'Classifier only. Never competes as a worker.',
    snapshot: snap('openai/gpt-6-luna', {
      pricing: { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.5 },
      contextLength: null,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      // Matches the live list: openai/gpt-6-luna does NOT support temperature.
      supportedParameters: ['max_tokens', 'max_completion_tokens', 'response_format', 'structured_outputs', 'reasoning'],
    }),
  },
  {
    id: 'openai/gpt-6-luna-decisions',
    displayName: 'GPT-6 Luna Decisions',
    role: 'Router (disabled; not a chat model)',
    executorType: 'router',
    approved: true,
    enabled: false,
    categories: {},
    reasoningStrength: 0.4,
    strengths: ['Probability-based decisions (team assessment)'],
    routingTier: 'budget',
    capabilities: NO_CAPS,
    notes:
      "Registered but disabled: OpenRouter lists output modality 'decisions' and no chat parameters, so it is not callable as a chat model.",
    snapshot: snap('openai/gpt-6-luna-decisions', {
      pricing: null,
      pricingUnitNote: 'Not callable as a chat model; pricing not captured.',
      contextLength: null,
      inputModalities: ['text'],
      outputModalities: ['decisions'],
    }),
  },
  {
    id: 'meta-llama/llama-guard-4-12b',
    displayName: 'Llama Guard 4 12B',
    role: 'Safety guard',
    executorType: 'guard',
    approved: true,
    enabled: true,
    categories: {},
    reasoningStrength: 0.2,
    strengths: ['Input/output safety classification (team assessment)'],
    routingTier: 'budget',
    capabilities: { structuredOutputs: false, tools: false, vision: true, longContext: false },
    notes: 'Plain text output: safe, or unsafe plus hazard codes. Never a worker.',
    snapshot: snap('meta-llama/llama-guard-4-12b', {
      pricing: { inputPerMillionUsd: 0.18, outputPerMillionUsd: 0.18 },
      contextLength: 163_840,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      supportedParameters: ['max_tokens', 'temperature'],
    }),
  },
  {
    id: 'deepseek/deepseek-v4.1-flash',
    displayName: 'DeepSeek V4.1 Flash',
    role: 'Budget coding / agentic',
    executorType: 'text',
    approved: true,
    enabled: true,
    categories: {
      coding: 0.75,
      writing: 0.7,
      data: 0.7,
      research: 0.6,
      reasoning_planning: 0.6,
      summarization: 0.8,
      multimodal: 0.5,
      automation_tool_use: 0.65,
      general: 0.75,
    },
    reasoningStrength: 0.65,
    strengths: ['Very low cost', 'Solid everyday coding', 'Reasoning mode available (team assessment)'],
    routingTier: 'budget',
    capabilities: { structuredOutputs: true, tools: true, vision: true, longContext: true },
    snapshot: snap('deepseek/deepseek-v4.1-flash', {
      pricing: { inputPerMillionUsd: 0.02376, outputPerMillionUsd: 0.72 },
      contextLength: 1_048_576,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      supportedParameters: [...TEXT_PARAMS, 'reasoning'],
    }),
  },
  {
    id: 'google/gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    role: 'Multimodal / research',
    executorType: 'text',
    approved: true,
    enabled: true,
    categories: {
      coding: 0.7,
      writing: 0.8,
      data: 0.75,
      research: 0.85,
      reasoning_planning: 0.7,
      summarization: 0.9,
      multimodal: 0.95,
      automation_tool_use: 0.7,
      general: 0.8,
    },
    reasoningStrength: 0.7,
    strengths: ['Broad modality input (image, video, audio, files)', 'Fast research and summarization (team assessment)'],
    routingTier: 'standard',
    capabilities: { structuredOutputs: true, tools: true, vision: true, longContext: true },
    snapshot: snap('google/gemini-3.8-flash', {
      pricing: { inputPerMillionUsd: 0.75, outputPerMillionUsd: 3.75 },
      contextLength: 1_048_576,
      inputModalities: ['text', 'image', 'video', 'file', 'audio'],
      outputModalities: ['text'],
      supportedParameters: TEXT_PARAMS,
    }),
  },
  {
    id: 'anthropic/claude-sonnet-5.5',
    displayName: 'Claude Sonnet 5.5',
    role: 'Balanced premium',
    executorType: 'text',
    approved: true,
    enabled: true,
    categories: {
      coding: 0.9,
      writing: 0.95,
      data: 0.8,
      research: 0.85,
      reasoning_planning: 0.85,
      summarization: 0.9,
      multimodal: 0.8,
      automation_tool_use: 0.7,
      general: 0.9,
    },
    reasoningStrength: 0.85,
    strengths: ['Balanced writing and coding', 'Strong editing and tone (team assessment)'],
    routingTier: 'premium',
    capabilities: { structuredOutputs: true, tools: true, vision: true, longContext: true },
    notes: 'Same price as GPT-6.1 Sol; separated by profile (writing/coding vs tool use/agentic).',
    snapshot: snap('anthropic/claude-sonnet-5.5', {
      pricing: { inputPerMillionUsd: 2, outputPerMillionUsd: 10 },
      contextLength: 1_000_000,
      inputModalities: ['text', 'image', 'file'],
      outputModalities: ['text'],
      supportedParameters: TEXT_PARAMS,
    }),
  },
  {
    id: 'openai/gpt-6.1-sol',
    displayName: 'GPT-6.1 Sol',
    role: 'Professional / agentic',
    executorType: 'text',
    approved: true,
    enabled: true,
    categories: {
      coding: 0.85,
      writing: 0.8,
      data: 0.9,
      research: 0.85,
      reasoning_planning: 0.9,
      summarization: 0.8,
      multimodal: 0.8,
      automation_tool_use: 0.95,
      general: 0.85,
    },
    reasoningStrength: 0.85,
    strengths: ['Tool use and agentic workflows', 'Professional analysis and planning (team assessment)'],
    routingTier: 'premium',
    capabilities: { structuredOutputs: true, tools: true, vision: true, longContext: true },
    notes: 'Price rises to 4/15 per M tokens above 272k prompt tokens. Same base price as Sonnet 5.5.',
    snapshot: snap('openai/gpt-6.1-sol', {
      pricing: {
        inputPerMillionUsd: 2,
        outputPerMillionUsd: 10,
        longPromptTier: { aboveInputTokens: 272_000, inputPerMillionUsd: 4, outputPerMillionUsd: 15 },
      },
      contextLength: 1_050_000,
      inputModalities: ['text', 'image', 'file'],
      outputModalities: ['text'],
      supportedParameters: TEXT_PARAMS,
    }),
  },
  {
    id: 'anthropic/claude-opus-5.5',
    displayName: 'Claude Opus 5.5',
    role: 'Heavy reasoning / coding',
    executorType: 'text',
    approved: true,
    enabled: true,
    categories: {
      coding: 1,
      writing: 0.95,
      data: 0.9,
      research: 0.95,
      reasoning_planning: 1,
      summarization: 0.9,
      multimodal: 0.85,
      automation_tool_use: 0.9,
      general: 0.95,
    },
    reasoningStrength: 1,
    strengths: ['Hardest multi-step reasoning and debugging', 'Architecture work (team assessment)'],
    routingTier: 'flagship',
    capabilities: { structuredOutputs: true, tools: true, vision: true, longContext: true },
    snapshot: snap('anthropic/claude-opus-5.5', {
      pricing: { inputPerMillionUsd: 4, outputPerMillionUsd: 20 },
      contextLength: 1_000_000,
      inputModalities: ['text', 'image', 'file'],
      outputModalities: ['text'],
      supportedParameters: TEXT_PARAMS,
    }),
  },
  {
    id: 'google/gemini-3.1-flash-image',
    displayName: 'Gemini 3.1 Flash Image',
    role: 'Image generation / editing',
    executorType: 'image',
    approved: true,
    enabled: false,
    categories: { image_generation: 1 },
    reasoningStrength: 0.5,
    strengths: ['Image generation and editing (team assessment)'],
    routingTier: 'standard',
    capabilities: { structuredOutputs: false, tools: false, vision: true, longContext: false },
    notes: 'V2. Disabled in V1.',
    snapshot: snap('google/gemini-3.1-flash-image', {
      pricing: null,
      pricingUnitNote: 'Priced per generated image / output, not per text token. See OpenRouter.',
      contextLength: null,
      inputModalities: ['text', 'image'],
      outputModalities: ['image', 'text'],
    }),
  },
  {
    id: 'elevenlabs/eleven-v4-turbo',
    displayName: 'Eleven v4 Turbo',
    role: 'Speech / audio',
    executorType: 'audio',
    approved: true,
    enabled: false,
    categories: { audio_generation: 1 },
    reasoningStrength: 0.1,
    strengths: ['Speech generation (team assessment)'],
    routingTier: 'standard',
    capabilities: NO_CAPS,
    notes: 'V2. Disabled in V1.',
    snapshot: snap('elevenlabs/eleven-v4-turbo', {
      pricing: null,
      pricingUnitNote: 'Priced per character of input text. See OpenRouter.',
      contextLength: null,
      inputModalities: ['text'],
      outputModalities: ['audio'],
    }),
  },
  {
    id: 'google/veo-3.1-lite',
    displayName: 'Veo 3.1 Lite',
    role: 'Video generation',
    executorType: 'video',
    approved: true,
    enabled: false,
    categories: { video_generation: 1 },
    reasoningStrength: 0.1,
    strengths: ['Video generation (team assessment)'],
    routingTier: 'standard',
    capabilities: NO_CAPS,
    notes: 'V2. Async job lifecycle. Disabled in V1.',
    snapshot: snap('google/veo-3.1-lite', {
      pricing: null,
      pricingUnitNote: 'Priced per second of generated video. See OpenRouter.',
      contextLength: null,
      inputModalities: ['text', 'image'],
      outputModalities: ['video'],
    }),
  },
];

export function getRegistry(): readonly RegistryModel[] {
  return REGISTRY;
}

export function getModel(id: string): RegistryModel | undefined {
  return REGISTRY.find((m) => m.id === id);
}

export function isApprovedAndEnabled(id: string): boolean {
  const m = getModel(id);
  return m !== undefined && m.approved && m.enabled;
}
