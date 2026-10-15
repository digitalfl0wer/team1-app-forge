import type { ReasoningLevel, RoutingTier } from './types';

/** Every routing weight and threshold lives here. Tune in one place. */
export const ROUTING_CONFIG = {
  /** Below this the run ends as needs_clarification. Never escalate to compensate. */
  confidenceThreshold: 0.6,
  /** V1 worker max_completion_tokens. */
  workerOutputCapTokens: 2500,
  /** Used when the caller does not pass an input token estimate. */
  defaultEstimatedInputTokens: 1000,
  /** needsLongContext requires at least this context window. */
  longContextMinTokens: 200_000,

  weights: {
    categoryFit: 3,
    reasoningFit: 2,
    /** Applies only when the task needs tools (agentic profile). */
    toolUseFit: 1.5,
    /** Applies only when the task has non-text input. */
    multimodalFit: 1,
    /** Applies only when the task needs long context. */
    longContextFit: 1,
    price: 1,
  },

  /** Category fit used when a model has no profile for the category. */
  defaultCategoryFit: 0.3,
  /** Price score is neutral when the cost is unknown. */
  unknownPriceScore: 0.5,
  /** Price score reaches 0 when cost is this many times the cheapest eligible cost. */
  priceSpanRatio: 50,
  /** Candidates within this score distance of the best are "close"; cheapest of them wins. */
  closenessBand: 0.08,
  /** Reasoning fit drops this much per unit of strength shortfall. */
  reasoningShortfallPenalty: 2,
  /** Context size (tokens) that earns the full long-context fit score. */
  longContextFullScoreTokens: 1_000_000,
  /** Cheaper alternative must score at least this fraction of the best score. */
  cheaperAlternativeMinScoreRatio: 0.75,

  reasoningLevelValue: { low: 0.3, medium: 0.6, high: 0.9 } satisfies Record<ReasoningLevel, number>,
  tierRank: { budget: 1, standard: 2, premium: 3, flagship: 4 } satisfies Record<RoutingTier, number>,
} as const;
