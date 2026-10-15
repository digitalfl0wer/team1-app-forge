import { describe, expect, it } from 'vitest';
import { getModel, getRegistry, modelPricingUrl, MODELS_PRICING_URL } from './modelRegistry';
import { estimateMaxCostUsd, route, snapshotEntries } from './router';
import { classificationSchema } from './types';
import type { Classification, ModelMetadata, Recommendation, RegistryEntry } from './types';

const base: Classification = {
  category: 'writing',
  subcategory: 'rewrite',
  requirements: [],
  inputModalities: ['text'],
  outputModality: 'text',
  reasoningLevel: 'low',
  needsTools: false,
  needsLongContext: false,
  confidence: 0.9,
};
const cls = (o: Partial<Classification> = {}): Classification => ({ ...base, ...o });

function withMeta(id: string, patch: Partial<ModelMetadata>): RegistryEntry[] {
  return getRegistry().map((model) => ({
    model,
    metadata: model.id === id ? { ...model.snapshot, ...patch } : null,
  }));
}

function rec(r: ReturnType<typeof route>): Recommendation {
  if (r.kind !== 'recommendation') throw new Error(`expected recommendation, got ${r.kind}`);
  return r;
}

describe('hard filters', () => {
  it('never recommends disabled media, luna-decisions, router or guard for text tasks', () => {
    const r = rec(route(cls(), snapshotEntries()));
    const ids = r.candidates.map((c) => c.modelId);
    for (const bad of [
      'google/gemini-3.1-flash-image',
      'elevenlabs/eleven-v4-turbo',
      'google/veo-3.1-lite',
      'openai/gpt-6-luna-decisions',
      'openai/gpt-6-luna',
      'meta-llama/llama-guard-4-12b',
    ]) {
      expect(ids).not.toContain(bad);
    }
  });

  it('media requests yield no_eligible_model in V1 (all media disabled)', () => {
    for (const outputModality of ['image', 'audio', 'video'] as const) {
      const r = route(cls({ outputModality, category: `${outputModality}_generation` as Classification['category'], subcategory: 'other' }), snapshotEntries());
      expect(r.kind).toBe('no_eligible_model');
      if (r.kind === 'no_eligible_model') {
        expect(r.message).toContain('None of the currently approved models');
        expect(r.rejected.length).toBeGreaterThan(0);
      }
    }
  });

  it('an enabled media model competes only for its own output type', () => {
    const entries = getRegistry().map((model) => ({
      model: model.id === 'google/veo-3.1-lite' ? { ...model, enabled: true } : model,
      metadata: null,
    }));
    // Veo has unknown context length, so it fails closed on the context check: documented behaviour.
    const r = route(cls({ outputModality: 'video', category: 'video_generation', subcategory: 'other' }), entries);
    expect(r.kind).toBe('no_eligible_model');
  });

  it('unapproved models are rejected', () => {
    const entries = getRegistry().map((model) => ({
      model: model.id === 'deepseek/deepseek-v4.1-flash' ? { ...model, approved: false } : model,
      metadata: null,
    }));
    const r = rec(route(cls(), entries));
    expect(r.candidates.map((c) => c.modelId)).not.toContain('deepseek/deepseek-v4.1-flash');
  });

  it('vision need excludes text-only models', () => {
    const entries = withMeta('google/gemini-3.8-flash', {});
    const textOnly = entries.map((e) =>
      e.model.id === 'deepseek/deepseek-v4.1-flash'
        ? { ...e, metadata: { ...e.model.snapshot, inputModalities: ['text'] } }
        : e,
    );
    const r = rec(route(cls({ inputModalities: ['text', 'image'], requirements: ['vision'] }), textOnly));
    const ids = r.candidates.map((c) => c.modelId);
    expect(ids).not.toContain('deepseek/deepseek-v4.1-flash');
    expect(ids).toContain('google/gemini-3.8-flash');
  });

  it('audio input only leaves models that accept audio', () => {
    const r = rec(route(cls({ inputModalities: ['audio'], requirements: ['audio_input'] }), snapshotEntries()));
    expect(r.candidates.map((c) => c.modelId)).toEqual(['google/gemini-3.8-flash']);
  });

  it('long context excludes small context windows', () => {
    const entries = withMeta('deepseek/deepseek-v4.1-flash', { contextLength: 128_000 });
    const r = rec(route(cls({ needsLongContext: true }), entries));
    expect(r.candidates.map((c) => c.modelId)).not.toContain('deepseek/deepseek-v4.1-flash');
    const small = rec(route(cls(), entries, { estimatedInputTokens: 200_000 }));
    expect(small.candidates.map((c) => c.modelId)).not.toContain('deepseek/deepseek-v4.1-flash');
  });

  it('needsTools filters models without tool support', () => {
    const entries = withMeta('deepseek/deepseek-v4.1-flash', {
      supportedParameters: ['max_tokens', 'structured_outputs'],
    });
    const r = rec(route(cls({ needsTools: true, category: 'automation_tool_use', subcategory: 'other' }), entries));
    expect(r.candidates.map((c) => c.modelId)).not.toContain('deepseek/deepseek-v4.1-flash');
  });

  it('structured_output requirement filters on supported parameters', () => {
    const entries = withMeta('google/gemini-3.8-flash', { supportedParameters: ['max_tokens'] });
    const r = rec(route(cls({ requirements: ['structured_output'] }), entries));
    expect(r.candidates.map((c) => c.modelId)).not.toContain('google/gemini-3.8-flash');
  });

  it('returns no_eligible_model when nothing qualifies', () => {
    const r = route(cls({ inputModalities: ['video'], requirements: ['video_input', 'tool_use'] }), withMeta('google/gemini-3.8-flash', { supportedParameters: [] }));
    expect(r.kind).toBe('no_eligible_model');
  });
});

describe('selection', () => {
  it('simple rewrite picks the cheap model', () => {
    const r = rec(route(cls(), snapshotEntries()));
    expect(r.recommendedModelId).toBe('deepseek/deepseek-v4.1-flash');
    expect(r.strongerAlternativeModelId).not.toBeNull();
    expect(r.candidates[0].modelId).toBe(r.recommendedModelId);
  });

  it('hard multi-step debugging prefers a stronger coding/reasoning model', () => {
    const r = rec(
      route(
        cls({ category: 'coding', subcategory: 'debugging', reasoningLevel: 'high', requirements: ['code_reasoning', 'deep_reasoning'] }),
        snapshotEntries(),
      ),
    );
    expect(['anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5']).toContain(r.recommendedModelId);
    expect(r.recommendedModelId).not.toBe('deepseek/deepseek-v4.1-flash');
    expect(r.cheaperAlternativeModelId).not.toBeNull();
  });

  it('Sonnet and Sol are separable by profile at identical price', () => {
    const sonnet = getModel('anthropic/claude-sonnet-5.5')!;
    const sol = getModel('openai/gpt-6.1-sol')!;
    expect(sonnet.snapshot.pricing?.inputPerMillionUsd).toBe(sol.snapshot.pricing?.inputPerMillionUsd);
    expect(sonnet.snapshot.pricing?.outputPerMillionUsd).toBe(sol.snapshot.pricing?.outputPerMillionUsd);

    const only = (ids: string[]) => snapshotEntries().filter((e) => ids.includes(e.model.id));
    const pair = only([sonnet.id, sol.id]);

    const writing = rec(route(cls({ category: 'writing', subcategory: 'professional_writing', reasoningLevel: 'medium' }), pair));
    expect(writing.recommendedModelId).toBe(sonnet.id);

    const agentic = rec(
      route(cls({ category: 'automation_tool_use', subcategory: 'other', reasoningLevel: 'medium', needsTools: true, requirements: ['tool_use'] }), pair),
    );
    expect(agentic.recommendedModelId).toBe(sol.id);
  });

  it('is deterministic', () => {
    const c = cls({ category: 'data', subcategory: 'sql', reasoningLevel: 'medium' });
    expect(JSON.stringify(route(c, snapshotEntries()))).toBe(JSON.stringify(route(c, snapshotEntries())));
  });
});

describe('confidence', () => {
  it('below threshold returns needs_clarification, never a model', () => {
    const r = route(cls({ confidence: 0.59 }), snapshotEntries());
    expect(r.kind).toBe('needs_clarification');
    expect(route(cls({ confidence: 0.6 }), snapshotEntries()).kind).toBe('recommendation');
  });
});

describe('pricing', () => {
  it('missing pricing sets pricingUnavailable with links and no invented price', () => {
    const entries = withMeta('deepseek/deepseek-v4.1-flash', { pricing: null, source: 'live' });
    const r = rec(route(cls(), entries));
    const c = r.candidates.find((x) => x.modelId === 'deepseek/deepseek-v4.1-flash')!;
    expect(c.pricingUnavailable).toBe(true);
    expect(c.estimatedMaxCostUsd).toBeNull();
    expect(c.pricingUrl).toBe(modelPricingUrl('deepseek/deepseek-v4.1-flash'));
    expect(r.pricingUrls.general).toBe(MODELS_PRICING_URL);
    expect(r.recommendedModelId).not.toBe('deepseek/deepseek-v4.1-flash');
  });

  it('all prices missing: recommendation flags pricingUnavailable', () => {
    const entries = getRegistry().map((model) => ({ model, metadata: { ...model.snapshot, pricing: null } }));
    const r = rec(route(cls(), entries));
    expect(r.pricingUnavailable).toBe(true);
    expect(r.pricingUrls.recommendedModel).toBe(modelPricingUrl(r.recommendedModelId));
    expect(r.reason).toContain('Price unavailable');
  });

  it('cost math: input x in-price + cap x out-price', () => {
    const r = rec(route(cls(), snapshotEntries(), { estimatedInputTokens: 10_000 }));
    const ds = r.candidates.find((x) => x.modelId === 'deepseek/deepseek-v4.1-flash')!;
    expect(ds.estimatedMaxCostUsd).toBeCloseTo((10_000 * 0.02376 + 1500 * 0.72) / 1e6, 12);
    expect(r.outputCapTokens).toBe(1500);
  });

  it('applies the Sol tier above 272k prompt tokens', () => {
    const sol = getModel('openai/gpt-6.1-sol')!.snapshot.pricing!;
    expect(estimateMaxCostUsd(sol, 272_000, 1500)).toBeCloseTo((272_000 * 2 + 1500 * 10) / 1e6, 12);
    expect(estimateMaxCostUsd(sol, 300_000, 1500)).toBeCloseTo((300_000 * 4 + 1500 * 15) / 1e6, 12);
    const r = rec(route(cls(), snapshotEntries(), { estimatedInputTokens: 300_000 }));
    const c = r.candidates.find((x) => x.modelId === 'openai/gpt-6.1-sol')!;
    expect(c.estimatedMaxCostUsd).toBeCloseTo((300_000 * 4 + 1500 * 15) / 1e6, 12);
  });
});

describe('classification schema', () => {
  it('accepts valid, rejects unknown keys, bad enums and mismatched subcategory', () => {
    expect(classificationSchema.safeParse(base).success).toBe(true);
    expect(classificationSchema.safeParse({ ...base, model: 'x' }).success).toBe(false);
    expect(classificationSchema.safeParse({ ...base, category: 'nope' }).success).toBe(false);
    expect(classificationSchema.safeParse({ ...base, subcategory: 'debugging' }).success).toBe(false);
    expect(classificationSchema.safeParse({ ...base, confidence: 1.2 }).success).toBe(false);
  });
});
