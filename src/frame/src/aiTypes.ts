// Types pinned by docs/ai/api-contract.md. The frame cannot import from src/ai, so they are copied here.

export type AiRunStatus =
    | 'classifying'
    | 'awaiting_confirmation'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'stale'
    | 'needs_clarification'
    | 'blocked_by_guard'
    | 'no_eligible_model';

export type MetadataSource = 'live' | 'cache' | 'snapshot';

export type AiCandidate = {
    modelId: string;
    displayName: string;
    routingTier: string;
    score: number;
    estimatedMaxCostUsd: number | null;
    inputPerMillionUsd: number | null;
    outputPerMillionUsd: number | null;
    priceLabel: string;
    contextLength: number | null;
    capabilities: { structuredOutputs: boolean; tools: boolean; vision: boolean; longContext: boolean };
    metadataSource: MetadataSource;
    pricingUrl: string;
    reason: string;
};

export type AiRun = {
    id: string;
    todoId: string;
    status: AiRunStatus;
    contentVersion: number;
    category: string | null;
    recommendedModelId: string | null;
    candidates: AiCandidate[];
    cheaperAlternativeModelId: string | null;
    strongerAlternativeModelId: string | null;
    reason: string | null;
    estimatedInputTokens: number | null;
    outputCapTokens: number | null;
    confirmedModelId: string | null;
    response: string | null;
    usage: { promptTokens: number; completionTokens: number } | null;
    costUsd: number | null;
    errorCode: string | null;
    message: string | null;
    pricingUrls: { general: string; recommendedModel: string | null };
    createdAt: string;
    completedAt: string | null;
};

export type ModelsTableRow = {
    id: string;
    displayName: string;
    role: string;
    executorType: string;
    approved: boolean;
    enabled: boolean;
    strengths: string[];
    inputPerMillionUsd: number | null;
    outputPerMillionUsd: number | null;
    priceLabel: string;
    pricingUnitNote: string | null;
    contextLength: number | null;
    inputModalities: string[];
    outputModalities: string[];
    supportedParameters: string[];
    metadataSource: MetadataSource;
    fetchedAt: string;
    pricingUrl: string;
    generalPricingUrl: string;
};

export type ModelsResult = {
    models: ModelsTableRow[];
    fetchedAt: string | null;
    source: MetadataSource;
    error?: string;
};
