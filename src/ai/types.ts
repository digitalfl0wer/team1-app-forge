import { z } from 'zod';

// ---------------------------------------------------------------------------
// Classification (output of the classifier, input to the deterministic router)
// ---------------------------------------------------------------------------

export const CATEGORIES = [
  'coding',
  'research',
  'writing',
  'data',
  'reasoning_planning',
  'summarization',
  'multimodal',
  'image_generation',
  'audio_generation',
  'video_generation',
  'automation_tool_use',
  'general',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Subcategory enum per category. Every category also accepts 'other'. */
export const SUBCATEGORIES: Record<Category, readonly string[]> = {
  coding: ['debugging', 'testing', 'implementation', 'code_review', 'refactoring', 'architecture', 'other'],
  writing: ['rewrite', 'professional_writing', 'creative_writing', 'editing', 'other'],
  data: ['analysis', 'extraction', 'transformation', 'sql', 'visualization', 'other'],
  research: ['synthesis', 'comparison', 'discovery', 'verification', 'other'],
  reasoning_planning: ['other'],
  summarization: ['other'],
  multimodal: ['other'],
  image_generation: ['other'],
  audio_generation: ['other'],
  video_generation: ['other'],
  automation_tool_use: ['other'],
  general: ['other'],
};

/** Flat union of all subcategory values, for a strict JSON schema enum. */
export const ALL_SUBCATEGORIES = Array.from(
  new Set(Object.values(SUBCATEGORIES).flat()),
) as [string, ...string[]];

export const REQUIREMENTS = [
  'code_reasoning',
  'deep_reasoning',
  'structured_output',
  'tool_use',
  'long_context',
  'vision',
  'document_understanding',
  'audio_input',
  'video_input',
  'image_generation',
  'audio_generation',
  'video_generation',
  'fast_response',
  'low_cost',
] as const;
export type Requirement = (typeof REQUIREMENTS)[number];

export const INPUT_MODALITIES = ['text', 'image', 'document', 'audio', 'video'] as const;
export type InputModality = (typeof INPUT_MODALITIES)[number];

export const OUTPUT_MODALITIES = ['text', 'image', 'audio', 'video'] as const;
export type OutputModality = (typeof OUTPUT_MODALITIES)[number];

export const REASONING_LEVELS = ['low', 'medium', 'high'] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/**
 * Strict schema: enums only, unknown keys rejected, no model IDs, no free text.
 * The subcategory must belong to the chosen category.
 */
export const classificationSchema = z
  .object({
    category: z.enum(CATEGORIES),
    subcategory: z.enum(ALL_SUBCATEGORIES),
    requirements: z.array(z.enum(REQUIREMENTS)).max(REQUIREMENTS.length),
    inputModalities: z.array(z.enum(INPUT_MODALITIES)).min(1).max(INPUT_MODALITIES.length),
    outputModality: z.enum(OUTPUT_MODALITIES),
    reasoningLevel: z.enum(REASONING_LEVELS),
    needsTools: z.boolean(),
    needsLongContext: z.boolean(),
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .refine((c) => SUBCATEGORIES[c.category].includes(c.subcategory), {
    message: 'subcategory does not belong to category',
    path: ['subcategory'],
  });

export type Classification = z.infer<typeof classificationSchema>;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type ExecutorType = 'router' | 'guard' | 'text' | 'image' | 'audio' | 'video';

export type RoutingTier = 'budget' | 'standard' | 'premium' | 'flagship';

export type ModelCapabilities = {
  structuredOutputs: boolean;
  tools: boolean;
  vision: boolean;
  longContext: boolean;
};

export type MetadataSource = 'live' | 'cache' | 'snapshot';

/** Price above a prompt-size threshold replaces the base rates (e.g. gpt-6.1-sol above 272k). */
export type PriceTier = {
  aboveInputTokens: number;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
};

export type TokenPricing = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  longPromptTier?: PriceTier;
};

/** Volatile provider metadata. Never hand-edit prices elsewhere: the snapshot is only a fallback. */
export type ModelMetadata = {
  id: string;
  /** null when pricing is missing or not expressible per token (media models). */
  pricing: TokenPricing | null;
  /** Unit-specific note for models not priced per token (per character, per second). */
  pricingUnitNote?: string;
  /** null when unknown. */
  contextLength: number | null;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  maxCompletionTokens: number | null;
  fetchedAt: string;
  source: MetadataSource;
};

export type RegistryModel = {
  id: string;
  displayName: string;
  role: string;
  executorType: ExecutorType;
  approved: boolean;
  enabled: boolean;
  /** Category fit 0..1. Team assessment, not a benchmark. */
  categories: Partial<Record<Category, number>>;
  /** Reasoning strength 0..1. Team assessment, not a benchmark. */
  reasoningStrength: number;
  /** Team assessment, not a benchmark. Label as such in the UI. */
  strengths: string[];
  routingTier: RoutingTier;
  capabilities: ModelCapabilities;
  notes?: string;
  /** Committed fallback for volatile fields (dated). */
  snapshot: ModelMetadata;
};

/** Registry model paired with the metadata the router should use (null = use snapshot). */
export type RegistryEntry = {
  model: RegistryModel;
  metadata: ModelMetadata | null;
};

// ---------------------------------------------------------------------------
// Router output
// ---------------------------------------------------------------------------

export type Candidate = {
  modelId: string;
  displayName: string;
  routingTier: RoutingTier;
  /** Normalised 0..1 weighted score. */
  score: number;
  /** null when pricingUnavailable. */
  estimatedMaxCostUsd: number | null;
  pricingUnavailable: boolean;
  inputPerMillionUsd: number | null;
  outputPerMillionUsd: number | null;
  contextLength: number | null;
  capabilities: ModelCapabilities;
  metadataSource: MetadataSource;
  pricingUrl: string;
  reason: string;
};

export type PricingUrls = {
  general: string;
  recommendedModel: string;
};

export type Recommendation = {
  kind: 'recommendation';
  recommendedModelId: string;
  reason: string;
  detectedCategory: Category;
  /** Ranked: recommended first, then by score descending. */
  candidates: Candidate[];
  cheaperAlternativeModelId: string | null;
  strongerAlternativeModelId: string | null;
  estimatedInputTokens: number;
  outputCapTokens: number;
  pricingUnavailable: boolean;
  pricingUrls: PricingUrls;
};

export type RejectedModel = { modelId: string; reasons: string[] };

export type RoutingFailure = {
  kind: 'no_eligible_model';
  message: string;
  detectedCategory: Category;
  rejected: RejectedModel[];
  pricingUrls: { general: string };
};

/** Distinct from failure: the UI asks the user to pick a category. Never escalate. */
export type NeedsClarification = {
  kind: 'needs_clarification';
  message: string;
  confidence: number;
  threshold: number;
  detectedCategory: Category;
};

export type RouteResult = Recommendation | RoutingFailure | NeedsClarification;

export type RouteOptions = {
  estimatedInputTokens?: number;
  outputCapTokens?: number;
  confidenceThreshold?: number;
};
