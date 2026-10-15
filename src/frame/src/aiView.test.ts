import { describe, expect, it } from 'vitest';
import {
    ALL_CATEGORIES,
    SELECTABLE_CATEGORIES,
    formatContext,
    formatTokens,
    formatUsd,
    isSafeOpenRouterUrl,
    isStaleContent,
    isSelectableCategory,
    needsPriceLinks,
    orderCandidates,
    runActions,
    runMessage,
    runStatusLabel,
    modelName,
} from './aiView';
import type { AiCandidate } from './aiTypes';

const cand = (id: string, over: Partial<AiCandidate> = {}): AiCandidate => ({
    modelId: id,
    displayName: id.toUpperCase(),
    routingTier: 'balanced',
    score: 1,
    estimatedMaxCostUsd: 0.01,
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 2,
    priceLabel: '$1 in / $2 out per 1M tokens',
    contextLength: 1000,
    capabilities: { structuredOutputs: false, tools: false, vision: false, longContext: false },
    metadataSource: 'live',
    pricingUrl: `https://openrouter.ai/${id}`,
    reason: 'r',
    ...over,
});

describe('formatting', () => {
    it('formats USD', () => {
        expect(formatUsd(null)).toBe('Unknown');
        expect(formatUsd(NaN)).toBe('Unknown');
        expect(formatUsd(0)).toBe('$0.00');
        expect(formatUsd(0.00001)).toBe('< $0.0001');
        expect(formatUsd(0.0042)).toBe('$0.0042');
        expect(formatUsd(0.1234)).toBe('$0.123');
        expect(formatUsd(12.5)).toBe('$12.50');
    });
    it('formats tokens and context', () => {
        expect(formatTokens(1234567)).toBe('1,234,567');
        expect(formatTokens(null)).toBe('Unknown');
        expect(formatContext(200000)).toBe('200K tokens');
        expect(formatContext(1000000)).toBe('1M tokens');
        expect(formatContext(null)).toBe('Unknown');
    });
});

describe('status', () => {
    it('labels and messages', () => {
        expect(runStatusLabel('failed')).toBe('Failed');
        expect(runStatusLabel('weird')).toBe('Unknown');
        expect(runMessage({ status: 'failed', message: ' Boom ' })).toBe('Boom');
        expect(runMessage({ status: 'failed', message: null })).not.toBe('');
    });
    it('actions per status', () => {
        expect(runActions('awaiting_confirmation').canConfirm).toBe(true);
        expect(runActions('needs_clarification').canChooseCategory).toBe(true);
        expect(runActions('running').busy).toBe(true);
        expect(runActions('running').canRetry).toBe(false);
        expect(runActions('stale').canRetry).toBe(true);
        expect(runActions('succeeded').showResponse).toBe(true);
        expect(runActions('awaiting_confirmation').canRetry).toBe(false);
    });
    it('stale content', () => {
        expect(isStaleContent({ contentVersion: 1 }, { content_version: 2 })).toBe(true);
        expect(isStaleContent({ contentVersion: 2 }, { content_version: 2 })).toBe(false);
    });
});

describe('categories', () => {
    it('selectable subset of all', () => {
        expect(ALL_CATEGORIES).toHaveLength(12);
        SELECTABLE_CATEGORIES.forEach((c) => expect(ALL_CATEGORIES).toContain(c));
        expect(isSelectableCategory('image_generation')).toBe(false);
        expect(isSelectableCategory('coding')).toBe(true);
    });
});

describe('candidates', () => {
    const run = {
        candidates: [cand('a'), cand('b'), cand('c'), cand('d')],
        recommendedModelId: 'c',
        cheaperAlternativeModelId: 'd',
        strongerAlternativeModelId: 'b',
        confirmedModelId: null,
    };
    it('orders recommended, cheaper, stronger, other', () => {
        expect(orderCandidates(run).map((x) => `${x.candidate.modelId}:${x.tag}`)).toEqual([
            'c:recommended',
            'd:cheaper',
            'b:stronger',
            'a:other',
        ]);
    });
    it('names the model', () => {
        expect(modelName(run)).toBe('C');
        expect(modelName({ ...run, candidates: [], confirmedModelId: 'x/y' })).toBe('x/y');
    });
    it('detects when price links are needed', () => {
        expect(needsPriceLinks(cand('a'))).toBe(false);
        expect(needsPriceLinks(cand('a', { metadataSource: 'snapshot' }))).toBe(true);
        expect(needsPriceLinks(cand('a', { estimatedMaxCostUsd: null, priceLabel: 'Price unavailable' }))).toBe(true);
    });
});

describe('isSafeOpenRouterUrl', () => {
    it('allows only https openrouter.ai', () => {
        expect(isSafeOpenRouterUrl('https://openrouter.ai/models')).toBe(true);
        expect(isSafeOpenRouterUrl('https://openrouter.ai/anthropic/claude-sonnet-5.5')).toBe(true);
        expect(isSafeOpenRouterUrl('http://openrouter.ai/models')).toBe(false);
        expect(isSafeOpenRouterUrl('https://openrouter.ai.evil.com/x')).toBe(false);
        expect(isSafeOpenRouterUrl('https://evil.com/https://openrouter.ai/')).toBe(false);
        expect(isSafeOpenRouterUrl('https://openrouter.ai@evil.com/')).toBe(false);
        expect(isSafeOpenRouterUrl('javascript:alert(1)')).toBe(false);
        expect(isSafeOpenRouterUrl('https://openrouter.ai/../x')).toBe(false);
        expect(isSafeOpenRouterUrl(null)).toBe(false);
    });
});
