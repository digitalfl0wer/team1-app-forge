import { afterEach, describe, expect, it, vi } from 'vitest';
import { getModelEntries, perTokenToPerMillion, toModelsTable } from './modelCatalog';
import type { CatalogFetch, CatalogStore } from './modelCatalog';
import { getRegistry } from './modelRegistry';
import type { RegistryEntry } from './types';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const now = () => NOW;

const DEEPSEEK = 'deepseek/deepseek-v4.1-flash';
const SONNET = 'anthropic/claude-sonnet-5.5';

const liveItems = [
  {
    id: DEEPSEEK,
    context_length: 1_000_000,
    pricing: { prompt: '0.00000002376', completion: '0.00000072' },
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'], extra: 1 },
    supported_parameters: ['max_tokens', 'tools'],
    top_provider: { max_completion_tokens: 65536 },
    unknown_field: true,
  },
  {
    id: SONNET,
    context_length: 1_000_000,
    pricing: { prompt: '0.000002', completion: '0.00001' },
    architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] },
    supported_parameters: ['max_tokens'],
    top_provider: { max_completion_tokens: 0 },
  },
  {
    id: 'google/gemini-3.1-flash-image',
    context_length: 65536,
    pricing: { prompt: '0.0000005', completion: '0.000003', image: '0.04' },
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['image', 'text'] },
    supported_parameters: [],
  },
  {
    id: 'google/veo-3.1-lite',
    pricing: { prompt: '0', completion: '0' },
    architecture: { input_modalities: ['text'], output_modalities: ['video'] },
  },
  { id: 'evil/not-in-registry', pricing: { prompt: '0', completion: '0' } },
];

const body = (items: unknown[] = liveItems) => JSON.stringify({ data: items });
const ok = (text: string) => ({ ok: true, status: 200, text: async () => text });

function memStore(initial: { payload: string; fetchedAt: string } | null = null) {
  let cur = initial;
  const set = vi.fn(async (payload: string, fetchedAt: string) => {
    cur = { payload, fetchedAt };
  });
  const store: CatalogStore = { get: async () => cur, set };
  return { store, set, current: () => cur };
}

const meta = (r: { entries: RegistryEntry[] }, id: string) => r.entries.find((e) => e.model.id === id)!.metadata!;

afterEach(() => vi.useRealTimers());

describe('perTokenToPerMillion', () => {
  it('converts without float noise', () => {
    expect(perTokenToPerMillion('0.00000002376')).toBe(0.02376);
    expect(perTokenToPerMillion('0.00000072')).toBe(0.72);
    expect(perTokenToPerMillion('0.000002')).toBe(2);
    expect(perTokenToPerMillion('0.00001')).toBe(10);
  });
  it('rejects missing, negative and garbage values', () => {
    expect(perTokenToPerMillion(undefined)).toBeNull();
    expect(perTokenToPerMillion('-1')).toBeNull();
    expect(perTokenToPerMillion('abc')).toBeNull();
  });
});

describe('getModelEntries live', () => {
  it('normalises prices, context, modalities and parameters', async () => {
    const f = vi.fn<CatalogFetch>(async () => ok(body()));
    const r = await getModelEntries({ store: memStore().store, fetchImpl: f, now });
    expect(r.source).toBe('live');
    expect(r.fetchedAt).toBe(NOW.toISOString());
    expect(r.error).toBeUndefined();
    const d = meta(r, DEEPSEEK);
    expect(d.pricing).toEqual({ inputPerMillionUsd: 0.02376, outputPerMillionUsd: 0.72 });
    expect(d.contextLength).toBe(1_000_000);
    expect(d.inputModalities).toEqual(['text', 'image']);
    expect(d.outputModalities).toEqual(['text']);
    expect(d.supportedParameters).toEqual(['max_tokens', 'tools']);
    expect(d.maxCompletionTokens).toBe(65536);
    expect(d.source).toBe('live');
    const s = meta(r, SONNET);
    expect(s.pricing).toEqual({ inputPerMillionUsd: 2, outputPerMillionUsd: 10 });
    expect(s.maxCompletionTokens).toBeNull();
  });

  it('keeps app-owned fields and ignores unknown ids', async () => {
    const r = await getModelEntries({ store: memStore().store, fetchImpl: async () => ok(body()), now });
    expect(r.entries.map((e) => e.model.id)).toEqual(getRegistry().map((m) => m.id));
    expect(r.entries.find((e) => e.model.id === 'evil/not-in-registry')).toBeUndefined();
    expect(r.entries.find((e) => e.model.id === SONNET)!.model).toBe(getRegistry().find((m) => m.id === SONNET));
  });

  it('falls back to the snapshot per entry for models missing from the response', async () => {
    const r = await getModelEntries({ store: memStore().store, fetchImpl: async () => ok(body()), now });
    const missing = meta(r, 'google/gemini-3.8-flash');
    expect(missing.source).toBe('snapshot');
    expect(missing.pricing?.inputPerMillionUsd).toBe(0.75);
  });

  it('preserves the snapshot long-prompt tier', async () => {
    const items = [{ id: 'openai/gpt-6.1-sol', pricing: { prompt: '0.000002', completion: '0.00001' }, architecture: { output_modalities: ['text'] } }];
    const r = await getModelEntries({ store: memStore().store, fetchImpl: async () => ok(body(items)), now });
    expect(meta(r, 'openai/gpt-6.1-sol').pricing?.longPromptTier?.aboveInputTokens).toBe(272_000);
  });

  it('never invents token prices for media models', async () => {
    const r = await getModelEntries({ store: memStore().store, fetchImpl: async () => ok(body()), now });
    for (const id of ['google/gemini-3.1-flash-image', 'google/veo-3.1-lite']) {
      const m = meta(r, id);
      expect(m.source).toBe('live');
      expect(m.pricing).toBeNull();
      expect(m.pricingUnitNote).toBeTruthy();
    }
  });

  it('sends a plain GET to the all-modalities URL with no Authorization header', async () => {
    const f = vi.fn<CatalogFetch>(async () => ok(body()));
    await getModelEntries({ store: memStore().store, fetchImpl: f, now });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/models?output_modalities=all');
    expect(init?.method).toBe('GET');
    expect(Object.keys(init?.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('stores the filtered payload', async () => {
    const m = memStore();
    await getModelEntries({ store: m.store, fetchImpl: async () => ok(body()), now });
    expect(m.set).toHaveBeenCalledTimes(1);
    expect(m.current()!.payload).not.toContain('evil/not-in-registry');
  });
});

describe('cache policy', () => {
  it('returns a fresh cache without fetching', async () => {
    const m = memStore();
    await getModelEntries({ store: m.store, fetchImpl: async () => ok(body()), now });
    const f = vi.fn<CatalogFetch>(async () => ok(body([])));
    const later = () => new Date(NOW.getTime() + 60_000);
    const r = await getModelEntries({ store: m.store, fetchImpl: f, now: later });
    expect(f).not.toHaveBeenCalled();
    expect(r.source).toBe('cache');
    expect(r.fetchedAt).toBe(NOW.toISOString());
    expect(meta(r, DEEPSEEK).source).toBe('cache');
    expect(meta(r, DEEPSEEK).pricing?.outputPerMillionUsd).toBe(0.72);
  });

  it('refreshes a stale cache', async () => {
    const m = memStore();
    await getModelEntries({ store: m.store, fetchImpl: async () => ok(body()), now });
    const f = vi.fn<CatalogFetch>(async () => ok(body()));
    const later = () => new Date(NOW.getTime() + 25 * 3600_000);
    const r = await getModelEntries({ store: m.store, fetchImpl: f, now: later });
    expect(f).toHaveBeenCalledTimes(1);
    expect(r.source).toBe('live');
    expect(m.set).toHaveBeenCalledTimes(2);
  });

  it('forceRefresh bypasses a fresh cache', async () => {
    const m = memStore();
    await getModelEntries({ store: m.store, fetchImpl: async () => ok(body()), now });
    const f = vi.fn<CatalogFetch>(async () => ok(body()));
    const r = await getModelEntries({ store: m.store, fetchImpl: f, now, forceRefresh: true });
    expect(f).toHaveBeenCalledTimes(1);
    expect(r.source).toBe('live');
  });

  it('falls back to the stale cache on fetch failure, then to the snapshot', async () => {
    const m = memStore();
    await getModelEntries({ store: m.store, fetchImpl: async () => ok(body()), now });
    const later = () => new Date(NOW.getTime() + 48 * 3600_000);
    const fail: CatalogFetch = async () => {
      throw new Error('network down');
    };
    const stale = await getModelEntries({ store: m.store, fetchImpl: fail, now: later });
    expect(stale.source).toBe('cache');
    expect(stale.error).toContain('network down');
    expect(stale.fetchedAt).toBe(NOW.toISOString());
    expect(meta(stale, DEEPSEEK).pricing?.outputPerMillionUsd).toBe(0.72);

    const none = await getModelEntries({ store: memStore().store, fetchImpl: fail, now });
    expect(none.source).toBe('snapshot');
    expect(none.fetchedAt).toBeNull();
    expect(none.error).toContain('network down');
    expect(none.entries).toHaveLength(getRegistry().length);
  });

  it('ignores a corrupt cache', async () => {
    const f = vi.fn<CatalogFetch>(async () => ok(body()));
    const r = await getModelEntries({
      store: memStore({ payload: '{not json', fetchedAt: NOW.toISOString() }).store,
      fetchImpl: f,
      now,
    });
    expect(f).toHaveBeenCalledTimes(1);
    expect(r.source).toBe('live');
    const r2 = await getModelEntries({
      store: memStore({ payload: '{"nope":1}', fetchedAt: NOW.toISOString() }).store,
      fetchImpl: async () => {
        throw new Error('x');
      },
      now,
    });
    expect(r2.source).toBe('snapshot');
  });

  it('tolerates store.set and store.get failures', async () => {
    const store: CatalogStore = {
      get: async () => {
        throw new Error('db read');
      },
      set: async () => {
        throw new Error('db write');
      },
    };
    const r = await getModelEntries({ store, fetchImpl: async () => ok(body()), now });
    expect(r.source).toBe('live');
  });
});

describe('failures never throw', () => {
  it('handles non-200', async () => {
    const r = await getModelEntries({
      store: memStore().store,
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'down' }),
      now,
    });
    expect(r.source).toBe('snapshot');
    expect(r.error).toContain('503');
  });

  it('handles malformed JSON and wrong shapes', async () => {
    for (const text of ['<html>', '[]', '{"data":"x"}']) {
      const r = await getModelEntries({ store: memStore().store, fetchImpl: async () => ok(text), now });
      expect(r.source).toBe('snapshot');
      expect(r.error).toBeTruthy();
    }
  });

  it('rejects absurdly large bodies', async () => {
    const r = await getModelEntries({
      store: memStore().store,
      fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => '999999999' }, text: async () => body() }),
      now,
    });
    expect(r.source).toBe('snapshot');
    expect(r.error).toContain('too large');
  });

  it('times out after 8 seconds', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const hang: CatalogFetch = (_u, init) =>
      new Promise(() => {
        init?.signal?.addEventListener('abort', () => (aborted = true));
      });
    const p = getModelEntries({ store: memStore().store, fetchImpl: hang, now });
    await vi.advanceTimersByTimeAsync(8001);
    const r = await p;
    expect(r.source).toBe('snapshot');
    expect(r.error).toContain('timed out');
    expect(aborted).toBe(true);
  });
});

describe('toModelsTable', () => {
  it('labels live, snapshot and unavailable prices and includes disabled models', async () => {
    const live = await getModelEntries({ store: memStore().store, fetchImpl: async () => ok(body()), now });
    const rows = toModelsTable(live.entries, { fetchedAt: live.fetchedAt, source: live.source });
    expect(rows).toHaveLength(getRegistry().length);
    const byId = (id: string) => rows.find((r) => r.id === id)!;
    expect(byId(DEEPSEEK).priceLabel).toBe('$0.02376 in / $0.72 out per 1M tokens');
    expect(byId(DEEPSEEK).metadataSource).toBe('live');
    expect(byId(DEEPSEEK).pricingUrl).toBe(`https://openrouter.ai/${DEEPSEEK}`);
    expect(byId('google/gemini-3.8-flash').priceLabel).toBe(
      'Last known price (2026-10-15): $0.75 in / $3.75 out per 1M tokens',
    );
    expect(byId('google/veo-3.1-lite').priceLabel).toBe('Price unavailable');
    expect(byId('google/veo-3.1-lite').enabled).toBe(false);
    expect(byId('google/veo-3.1-lite').inputPerMillionUsd).toBeNull();
  });
});
