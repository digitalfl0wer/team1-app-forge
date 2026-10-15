import { describe, expect, it } from 'vitest';
import { parseModels, parseRun, parseRuns } from './aiParse';

const baseRun = {
    id: 'r1',
    todoId: 't1',
    status: 'awaiting_confirmation',
    contentVersion: 2,
    candidates: [{ modelId: 'a/b', displayName: 'AB', capabilities: { tools: true }, estimatedMaxCostUsd: 0.5 }, 'junk'],
    usage: { promptTokens: 1, completionTokens: 2 },
};

describe('parseRun', () => {
    it('fills defaults and drops bad candidates', () => {
        const run = parseRun(baseRun);
        expect(run?.candidates).toHaveLength(1);
        expect(run?.candidates[0].capabilities.tools).toBe(true);
        expect(run?.candidates[0].priceLabel).toBe('Price unavailable');
        expect(run?.usage?.completionTokens).toBe(2);
        expect(run?.pricingUrls.general).toBe('https://openrouter.ai/models');
    });
    it('rejects bad shapes', () => {
        expect(parseRun(null)).toBeNull();
        expect(parseRun({ ...baseRun, status: 'nope' })).toBeNull();
        expect(parseRun({ ...baseRun, id: 5 })).toBeNull();
        expect(parseRuns({})).toBeNull();
        expect(parseRuns([baseRun, 3])).toHaveLength(1);
    });
});

describe('parseModels', () => {
    it('parses rows and source', () => {
        const res = parseModels({ models: [{ id: 'x', displayName: 'X', enabled: true }, {}], fetchedAt: null, source: 'live' });
        expect(res?.models).toHaveLength(1);
        expect(res?.source).toBe('live');
        expect(parseModels({})).toBeNull();
    });
});
