// Defensive parsing of AI resolver payloads. Pure: returns null on a bad shape.
import type { AiCandidate, AiRun, AiRunStatus, MetadataSource, ModelsResult, ModelsTableRow } from './aiTypes';

const RUN_STATUSES: readonly string[] = [
    'classifying',
    'awaiting_confirmation',
    'running',
    'succeeded',
    'failed',
    'stale',
    'needs_clarification',
    'blocked_by_guard',
    'no_eligible_model',
];

const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): string | null => (str(v) ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(str) : []);
const source = (v: unknown): MetadataSource => (v === 'live' || v === 'cache' ? v : 'snapshot');

export function parseCandidate(v: unknown): AiCandidate | null {
    if (!isObject(v) || !str(v.modelId) || !str(v.displayName)) return null;
    const caps = isObject(v.capabilities) ? v.capabilities : {};
    return {
        modelId: v.modelId,
        displayName: v.displayName,
        routingTier: strOrNull(v.routingTier) ?? '',
        score: numOrNull(v.score) ?? 0,
        estimatedMaxCostUsd: numOrNull(v.estimatedMaxCostUsd),
        inputPerMillionUsd: numOrNull(v.inputPerMillionUsd),
        outputPerMillionUsd: numOrNull(v.outputPerMillionUsd),
        priceLabel: strOrNull(v.priceLabel) ?? 'Price unavailable',
        contextLength: numOrNull(v.contextLength),
        capabilities: {
            structuredOutputs: caps.structuredOutputs === true,
            tools: caps.tools === true,
            vision: caps.vision === true,
            longContext: caps.longContext === true,
        },
        metadataSource: source(v.metadataSource),
        pricingUrl: strOrNull(v.pricingUrl) ?? '',
        reason: strOrNull(v.reason) ?? '',
    };
}

export function parseRun(v: unknown): AiRun | null {
    if (!isObject(v) || !str(v.id) || !str(v.todoId) || !str(v.status) || !RUN_STATUSES.includes(v.status)) {
        return null;
    }
    const usage = isObject(v.usage) ? v.usage : null;
    const urls = isObject(v.pricingUrls) ? v.pricingUrls : {};
    return {
        id: v.id,
        todoId: v.todoId,
        status: v.status as AiRunStatus,
        contentVersion: numOrNull(v.contentVersion) ?? 0,
        category: strOrNull(v.category),
        recommendedModelId: strOrNull(v.recommendedModelId),
        candidates: Array.isArray(v.candidates)
            ? v.candidates.flatMap((c) => {
                  const parsed = parseCandidate(c);
                  return parsed ? [parsed] : [];
              })
            : [],
        cheaperAlternativeModelId: strOrNull(v.cheaperAlternativeModelId),
        strongerAlternativeModelId: strOrNull(v.strongerAlternativeModelId),
        reason: strOrNull(v.reason),
        estimatedInputTokens: numOrNull(v.estimatedInputTokens),
        outputCapTokens: numOrNull(v.outputCapTokens),
        confirmedModelId: strOrNull(v.confirmedModelId),
        response: strOrNull(v.response),
        usage:
            usage && numOrNull(usage.promptTokens) !== null && numOrNull(usage.completionTokens) !== null
                ? {
                      promptTokens: usage.promptTokens as number,
                      completionTokens: usage.completionTokens as number,
                  }
                : null,
        costUsd: numOrNull(v.costUsd),
        errorCode: strOrNull(v.errorCode),
        message: strOrNull(v.message),
        pricingUrls: {
            general: strOrNull(urls.general) ?? 'https://openrouter.ai/models',
            recommendedModel: strOrNull(urls.recommendedModel),
        },
        createdAt: strOrNull(v.createdAt) ?? '',
        completedAt: strOrNull(v.completedAt),
    };
}

export function parseRuns(v: unknown): AiRun[] | null {
    if (!Array.isArray(v)) return null;
    return v.flatMap((r) => {
        const run = parseRun(r);
        return run ? [run] : [];
    });
}

export function parseModelRow(v: unknown): ModelsTableRow | null {
    if (!isObject(v) || !str(v.id) || !str(v.displayName)) return null;
    return {
        id: v.id,
        displayName: v.displayName,
        role: strOrNull(v.role) ?? '',
        executorType: strOrNull(v.executorType) ?? '',
        approved: v.approved === true,
        enabled: v.enabled === true,
        strengths: strings(v.strengths),
        inputPerMillionUsd: numOrNull(v.inputPerMillionUsd),
        outputPerMillionUsd: numOrNull(v.outputPerMillionUsd),
        priceLabel: strOrNull(v.priceLabel) ?? 'Price unavailable',
        pricingUnitNote: strOrNull(v.pricingUnitNote),
        contextLength: numOrNull(v.contextLength),
        inputModalities: strings(v.inputModalities),
        outputModalities: strings(v.outputModalities),
        supportedParameters: strings(v.supportedParameters),
        metadataSource: source(v.metadataSource),
        fetchedAt: strOrNull(v.fetchedAt) ?? '',
        pricingUrl: strOrNull(v.pricingUrl) ?? '',
        generalPricingUrl: strOrNull(v.generalPricingUrl) ?? 'https://openrouter.ai/models',
    };
}

export function parseModels(data: Record<string, unknown>): ModelsResult | null {
    if (!Array.isArray(data.models)) return null;
    const models = data.models.flatMap((m) => {
        const row = parseModelRow(m);
        return row ? [row] : [];
    });
    return {
        models,
        fetchedAt: strOrNull(data.fetchedAt),
        source: source(data.source),
        ...(str(data.error) ? { error: data.error } : {}),
    };
}
