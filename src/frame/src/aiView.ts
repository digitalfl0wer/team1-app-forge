// Pure view logic for the AI panel and Models tab. No DOM, no React, no bridge imports.
import type { AiCandidate, AiRun, AiRunStatus } from './aiTypes';

export const ALL_CATEGORIES = [
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

/** V1 runs text models only: the media-generation categories are listed but not selectable. */
export const SELECTABLE_CATEGORIES: readonly string[] = [
    'coding',
    'research',
    'writing',
    'data',
    'reasoning_planning',
    'summarization',
    'general',
    'multimodal',
    'automation_tool_use',
];

const CATEGORY_LABELS: Record<string, string> = {
    coding: 'Coding',
    research: 'Research',
    writing: 'Writing',
    data: 'Data',
    reasoning_planning: 'Reasoning and planning',
    summarization: 'Summarization',
    multimodal: 'Multimodal',
    image_generation: 'Image generation',
    audio_generation: 'Audio generation',
    video_generation: 'Video generation',
    automation_tool_use: 'Automation and tool use',
    general: 'General',
};

export function categoryLabel(category: string | null): string {
    if (!category) return 'Unknown';
    return CATEGORY_LABELS[category] ?? category.replace(/_/g, ' ');
}

export function isSelectableCategory(category: string): boolean {
    return SELECTABLE_CATEGORIES.indexOf(category) !== -1;
}

export const GENERAL_PRICING_URL = 'https://openrouter.ai/models';

/** Only https://openrouter.ai/... links are ever opened. */
export function isSafeOpenRouterUrl(url: unknown): url is string {
    if (typeof url !== 'string' || url.length > 300) return false;
    if (!/^https:\/\/openrouter\.ai\/[A-Za-z0-9._~\-/]*$/.test(url)) return false;
    return !url.includes('..');
}

export function formatUsd(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return 'Unknown';
    if (value === 0) return '$0.00';
    if (value < 0.0001) return '< $0.0001';
    if (value < 0.01) return `$${value.toFixed(4)}`;
    return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

export function formatTokens(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return 'Unknown';
    return Math.round(value).toLocaleString('en-US');
}

export function formatContext(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return 'Unknown';
    if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(2)}M tokens`;
    if (value >= 1000) return `${Math.round(value / 1000)}K tokens`;
    return `${Math.round(value)} tokens`;
}

export function maxCostLabel(candidate: Pick<AiCandidate, 'estimatedMaxCostUsd'>): string {
    return candidate.estimatedMaxCostUsd === null
        ? 'Estimated max cost unavailable'
        : `Estimated max cost ${formatUsd(candidate.estimatedMaxCostUsd)}`;
}

/** True when the shown price is a snapshot or missing, so pricing links must be shown. */
export function needsPriceLinks(candidate: Pick<AiCandidate, 'priceLabel' | 'metadataSource' | 'estimatedMaxCostUsd'>): boolean {
    return (
        candidate.metadataSource === 'snapshot' ||
        candidate.estimatedMaxCostUsd === null ||
        /^(last known|price unavailable)/i.test(candidate.priceLabel)
    );
}

export function capabilityList(c: AiCandidate['capabilities']): string[] {
    const out: string[] = [];
    if (c.structuredOutputs) out.push('Structured outputs');
    if (c.tools) out.push('Tools');
    if (c.vision) out.push('Vision');
    if (c.longContext) out.push('Long context');
    return out;
}

const STATUS_LABELS: Record<AiRunStatus, string> = {
    classifying: 'Classifying',
    awaiting_confirmation: 'Waiting for your confirmation',
    running: 'Running',
    succeeded: 'Succeeded',
    failed: 'Failed',
    stale: 'Out of date',
    needs_clarification: 'Needs your input',
    blocked_by_guard: 'Blocked',
    no_eligible_model: 'No model available',
};

export function runStatusLabel(status: string): string {
    return (STATUS_LABELS as Record<string, string>)[status] ?? 'Unknown';
}

const FALLBACK_MESSAGES: Partial<Record<AiRunStatus, string>> = {
    blocked_by_guard: 'This task was not sent to a model because it looks unsafe.',
    no_eligible_model: 'No approved model can handle this task right now.',
    failed: 'The AI run failed.',
    stale: 'The task changed after this run started, so the run was discarded.',
};

/** User-safe message for a run that ended without an answer. */
export function runMessage(run: Pick<AiRun, 'status' | 'message'>): string {
    const own = run.message?.trim();
    return own || FALLBACK_MESSAGES[run.status] || '';
}

export type RunActions = {
    canRetry: boolean;
    canConfirm: boolean;
    canChooseCategory: boolean;
    showResponse: boolean;
    busy: boolean;
};

export function runActions(status: string): RunActions {
    return {
        canRetry:
            status === 'blocked_by_guard' ||
            status === 'no_eligible_model' ||
            status === 'failed' ||
            status === 'stale' ||
            status === 'succeeded',
        canConfirm: status === 'awaiting_confirmation',
        canChooseCategory: status === 'needs_clarification',
        showResponse: status === 'succeeded',
        busy: status === 'classifying' || status === 'running',
    };
}

/** The answer was produced for different task text than the Todo has now. */
export function isStaleContent(run: Pick<AiRun, 'contentVersion'>, todo: { content_version: number }): boolean {
    return run.contentVersion !== todo.content_version;
}

export type CandidateTag = 'recommended' | 'cheaper' | 'stronger' | 'other';

export type LabelledCandidate = { candidate: AiCandidate; tag: CandidateTag };

export function tagLabel(tag: CandidateTag): string {
    switch (tag) {
        case 'recommended':
            return 'Recommended';
        case 'cheaper':
            return 'Cheaper option';
        case 'stronger':
            return 'Stronger option';
        default:
            return 'Alternative';
    }
}

/** Recommended first, then cheaper, stronger, and the rest in the backend's ranking order. */
export function orderCandidates(
    run: Pick<AiRun, 'candidates' | 'recommendedModelId' | 'cheaperAlternativeModelId' | 'strongerAlternativeModelId'>
): LabelledCandidate[] {
    const tagOf = (id: string): CandidateTag =>
        id === run.recommendedModelId
            ? 'recommended'
            : id === run.cheaperAlternativeModelId
              ? 'cheaper'
              : id === run.strongerAlternativeModelId
                ? 'stronger'
                : 'other';
    const rank: Record<CandidateTag, number> = { recommended: 0, cheaper: 1, stronger: 2, other: 3 };
    return run.candidates
        .map((candidate, index) => ({ candidate, tag: tagOf(candidate.modelId), index }))
        .sort((a, b) => rank[a.tag] - rank[b.tag] || a.index - b.index)
        .map(({ candidate, tag }) => ({ candidate, tag }));
}

export function modelName(run: Pick<AiRun, 'candidates' | 'confirmedModelId' | 'recommendedModelId'>): string {
    const id = run.confirmedModelId ?? run.recommendedModelId;
    if (!id) return 'No model';
    return run.candidates.find((c) => c.modelId === id)?.displayName ?? id;
}

export function historySummary(run: AiRun): string {
    const parts = [modelName(run), runStatusLabel(run.status)];
    if (run.status === 'succeeded') parts.push(formatUsd(run.costUsd));
    return parts.join(' - ');
}

export function formatRunTime(value: string | null): string {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function sourceLabel(source: string): string {
    return source === 'live'
        ? 'Live from OpenRouter'
        : source === 'cache'
          ? 'Cached OpenRouter data'
          : 'Built-in snapshot (not live)';
}

export function listOrDash(values: string[]): string {
    return values.length ? values.join(', ') : '-';
}
