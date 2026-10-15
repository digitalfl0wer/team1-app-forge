import { MODELS_PRICING_URL, getRegistry, modelPricingUrl } from './modelRegistry';
import { ROUTING_CONFIG as CFG } from './routingConfig';
import type {
  Candidate,
  Classification,
  ExecutorType,
  ModelMetadata,
  RegistryEntry,
  RegistryModel,
  RouteOptions,
  RouteResult,
  TokenPricing,
} from './types';

/** Pair every registry model with its committed snapshot (metadata = null means "use snapshot"). */
export function snapshotEntries(): RegistryEntry[] {
  return getRegistry().map((model) => ({ model, metadata: null }));
}

/** Stage 1: the output type decides which executor type may compete. Executor types map 1:1. */
export function requiredExecutorType(c: Classification): ExecutorType {
  return c.outputModality;
}

/** Model-side modality names differ from the classifier's ('document' is 'file'). */
const MODALITY_TO_PROVIDER: Record<string, string> = { document: 'file' };

function requiredInputModalities(c: Classification): string[] {
  const out = new Set<string>(c.inputModalities.map((m) => MODALITY_TO_PROVIDER[m] ?? m));
  if (c.requirements.includes('vision')) out.add('image');
  if (c.requirements.includes('document_understanding')) out.add('file');
  if (c.requirements.includes('audio_input')) out.add('audio');
  if (c.requirements.includes('video_input')) out.add('video');
  return [...out].sort();
}

/** Estimated worst-case cost. Applies the long-prompt tier when input tokens exceed its threshold. */
export function estimateMaxCostUsd(pricing: TokenPricing, inputTokens: number, outputCapTokens: number): number {
  const tier = pricing.longPromptTier;
  const rates = tier && inputTokens > tier.aboveInputTokens ? tier : pricing;
  return (inputTokens * rates.inputPerMillionUsd + outputCapTokens * rates.outputPerMillionUsd) / 1_000_000;
}

type Eligible = {
  model: RegistryModel;
  meta: ModelMetadata;
  cost: number | null;
  outputCap: number;
};

function rejectionReasons(
  c: Classification,
  model: RegistryModel,
  meta: ModelMetadata,
  inputTokens: number,
  outputCap: number,
): string[] {
  const reasons: string[] = [];
  if (!model.approved) reasons.push('not approved');
  if (!model.enabled) reasons.push('disabled');
  if (model.executorType === 'router' || model.executorType === 'guard') {
    reasons.push(`${model.executorType} models never compete as workers`);
  } else if (model.executorType !== requiredExecutorType(c)) {
    reasons.push(`wrong executor type (${model.executorType}, need ${requiredExecutorType(c)})`);
  }
  if (!meta.outputModalities.includes(c.outputModality)) {
    reasons.push(`output modality ${c.outputModality} unsupported`);
  }
  for (const m of requiredInputModalities(c)) {
    if (!meta.inputModalities.includes(m)) reasons.push(`input modality ${m} unsupported`);
  }
  if ((c.requirements.includes('vision') || c.inputModalities.includes('image')) && !model.capabilities.vision) {
    reasons.push('vision capability missing');
  }

  const needsLong = c.needsLongContext || c.requirements.includes('long_context');
  const minContext = needsLong ? CFG.longContextMinTokens : 0;
  if (meta.contextLength === null) {
    reasons.push('context length unknown');
  } else if (meta.contextLength < Math.max(minContext, inputTokens + outputCap)) {
    reasons.push(`context window too small (${meta.contextLength})`);
  }
  if (needsLong && !model.capabilities.longContext) reasons.push('long-context capability missing');

  if (c.needsTools || c.requirements.includes('tool_use')) {
    if (!model.capabilities.tools || !meta.supportedParameters.includes('tools')) reasons.push('tool support missing');
  }
  if (c.requirements.includes('structured_output')) {
    if (!model.capabilities.structuredOutputs || !meta.supportedParameters.includes('structured_outputs')) {
      reasons.push('structured-output support missing');
    }
  }
  return reasons;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

type ScoredPart = { weight: number; value: number };

function scoreModel(c: Classification, e: Eligible, minCost: number | null): number {
  const { model, meta, cost } = e;
  const parts: ScoredPart[] = [];
  const catFit = (cat: keyof RegistryModel['categories']) => model.categories[cat] ?? CFG.defaultCategoryFit;

  parts.push({ weight: CFG.weights.categoryFit, value: catFit(c.category) });

  const needed = CFG.reasoningLevelValue[c.reasoningLevel];
  const shortfall = Math.max(0, needed - model.reasoningStrength);
  parts.push({ weight: CFG.weights.reasoningFit, value: clamp01(1 - shortfall * CFG.reasoningShortfallPenalty) });

  if (c.needsTools || c.requirements.includes('tool_use')) {
    parts.push({ weight: CFG.weights.toolUseFit, value: catFit('automation_tool_use') });
  }
  if (c.inputModalities.some((m) => m !== 'text')) {
    parts.push({ weight: CFG.weights.multimodalFit, value: catFit('multimodal') });
  }
  if (c.needsLongContext || c.requirements.includes('long_context')) {
    parts.push({
      weight: CFG.weights.longContextFit,
      value: clamp01((meta.contextLength ?? 0) / CFG.longContextFullScoreTokens),
    });
  }
  let priceValue: number = CFG.unknownPriceScore;
  if (cost !== null && minCost !== null && minCost > 0) {
    priceValue = clamp01(1 - Math.log(Math.max(cost, minCost) / minCost) / Math.log(CFG.priceSpanRatio));
  } else if (cost !== null && minCost === cost) {
    priceValue = 1;
  }
  parts.push({ weight: CFG.weights.price, value: priceValue });

  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const total = parts.reduce((s, p) => s + p.weight * p.value, 0);
  return Math.round((total / totalWeight) * 1e6) / 1e6;
}

function formatUsd(n: number): string {
  return `$${n < 0.01 ? n.toPrecision(2) : n.toFixed(4)}`;
}

function candidateReason(c: Classification, e: Eligible, score: number): string {
  const fit = e.model.categories[c.category] ?? CFG.defaultCategoryFit;
  const cost =
    e.cost === null ? 'price unavailable' : `estimated max cost ${formatUsd(e.cost)}`;
  return `${c.category} fit ${fit.toFixed(2)}, reasoning strength ${e.model.reasoningStrength.toFixed(2)} for ${c.reasoningLevel} need, ${cost}, score ${score.toFixed(3)}`;
}

export function route(
  classification: Classification,
  entries: readonly RegistryEntry[],
  options: RouteOptions = {},
): RouteResult {
  const threshold = options.confidenceThreshold ?? CFG.confidenceThreshold;
  if (classification.confidence < threshold) {
    return {
      kind: 'needs_clarification',
      message: 'The task is ambiguous. Please pick a category so routing can continue.',
      confidence: classification.confidence,
      threshold,
      detectedCategory: classification.category,
    };
  }

  const inputTokens = options.estimatedInputTokens ?? CFG.defaultEstimatedInputTokens;
  const capSetting = options.outputCapTokens ?? CFG.workerOutputCapTokens;

  const rejected: { modelId: string; reasons: string[] }[] = [];
  const eligible: Eligible[] = [];
  for (const { model, metadata } of entries) {
    const meta = metadata ?? model.snapshot;
    const outputCap = meta.maxCompletionTokens === null ? capSetting : Math.min(capSetting, meta.maxCompletionTokens);
    const reasons = rejectionReasons(classification, model, meta, inputTokens, outputCap);
    if (reasons.length > 0) {
      rejected.push({ modelId: model.id, reasons });
      continue;
    }
    const cost = meta.pricing ? estimateMaxCostUsd(meta.pricing, inputTokens, outputCap) : null;
    eligible.push({ model, meta, cost, outputCap });
  }

  if (eligible.length === 0) {
    return {
      kind: 'no_eligible_model',
      message: 'None of the currently approved models support everything this task requires.',
      detectedCategory: classification.category,
      rejected,
      pricingUrls: { general: MODELS_PRICING_URL },
    };
  }

  const costs = eligible.map((e) => e.cost).filter((x): x is number => x !== null);
  const minCost = costs.length > 0 ? Math.min(...costs) : null;

  const scored = eligible.map((e) => ({ e, score: scoreModel(classification, e, minCost) }));
  // Deterministic ordering: score desc, then id.
  scored.sort((a, b) => b.score - a.score || a.e.model.id.localeCompare(b.e.model.id));
  const best = scored[0].score;

  // Closeness band: cheapest among near-best. Unknown cost sorts after known cost.
  const band = scored.filter((s) => best - s.score <= CFG.closenessBand + 1e-9);
  const byCost = [...band].sort((a, b) => {
    const ca = a.e.cost ?? Number.POSITIVE_INFINITY;
    const cb = b.e.cost ?? Number.POSITIVE_INFINITY;
    return ca - cb || b.score - a.score || a.e.model.id.localeCompare(b.e.model.id);
  });
  const pick = byCost[0];

  const rank = (s: (typeof scored)[number]) => CFG.tierRank[s.e.model.routingTier];
  const pickCost = pick.e.cost;

  const cheaper = scored
    .filter(
      (s) =>
        s !== pick &&
        s.e.cost !== null &&
        pickCost !== null &&
        s.e.cost < pickCost &&
        s.score >= best * CFG.cheaperAlternativeMinScoreRatio,
    )
    .sort((a, b) => (a.e.cost as number) - (b.e.cost as number) || b.score - a.score)[0];

  const stronger = scored
    .filter((s) => rank(s) > rank(pick))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.e.cost ?? Number.POSITIVE_INFINITY) - (b.e.cost ?? Number.POSITIVE_INFINITY) ||
        b.score - a.score,
    )[0];

  const toCandidate = (s: (typeof scored)[number]): Candidate => ({
    modelId: s.e.model.id,
    displayName: s.e.model.displayName,
    routingTier: s.e.model.routingTier,
    score: s.score,
    estimatedMaxCostUsd: s.e.cost,
    pricingUnavailable: s.e.cost === null,
    inputPerMillionUsd: s.e.meta.pricing?.inputPerMillionUsd ?? null,
    outputPerMillionUsd: s.e.meta.pricing?.outputPerMillionUsd ?? null,
    contextLength: s.e.meta.contextLength,
    capabilities: s.e.model.capabilities,
    metadataSource: s.e.meta.source,
    pricingUrl: modelPricingUrl(s.e.model.id),
    reason: candidateReason(classification, s.e, s.score),
  });

  const ranked = [pick, ...scored.filter((s) => s !== pick)].map(toCandidate);
  const recommended = ranked[0];

  const parts = [
    `${recommended.displayName} fits ${classification.category}/${classification.subcategory} work at ${classification.reasoningLevel} reasoning (score ${recommended.score.toFixed(3)}, best ${best.toFixed(3)}).`,
  ];
  if (band.length > 1) {
    parts.push(`It was the least expensive of ${band.length} models within ${CFG.closenessBand} of the top score.`);
  }
  parts.push(
    recommended.estimatedMaxCostUsd === null
      ? 'Price unavailable: check OpenRouter before confirming.'
      : `Estimated max cost ${formatUsd(recommended.estimatedMaxCostUsd)} (${inputTokens} input tokens, up to ${pick.e.outputCap} output tokens); actual cost depends on usage.`,
  );

  return {
    kind: 'recommendation',
    recommendedModelId: recommended.modelId,
    reason: parts.join(' '),
    detectedCategory: classification.category,
    candidates: ranked,
    cheaperAlternativeModelId: cheaper ? cheaper.e.model.id : null,
    strongerAlternativeModelId: stronger ? stronger.e.model.id : null,
    estimatedInputTokens: inputTokens,
    outputCapTokens: pick.e.outputCap,
    pricingUnavailable: recommended.pricingUnavailable,
    pricingUrls: { general: MODELS_PRICING_URL, recommendedModel: modelPricingUrl(recommended.modelId) },
  };
}
