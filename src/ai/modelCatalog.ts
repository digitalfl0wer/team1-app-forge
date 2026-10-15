import { fetch as forgeFetch } from '@forge/api';
import { z } from 'zod';
import { MODELS_PRICING_URL, getRegistry, modelPricingUrl } from './modelRegistry';
import { snapshotEntries } from './router';
import type { MetadataSource, ModelMetadata, RegistryEntry, RegistryModel, TokenPricing } from './types';

/**
 * Live model-metadata catalog. Refreshes only the volatile fields of REGISTRY models from
 * OpenRouter's public model list. Unknown ids in the response are ignored, so nothing here can
 * add a model to the allowlist. Public endpoint: no Authorization header, no secrets.
 */

export const MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=all';
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 8000;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export type CatalogStore = {
  get(): Promise<{ payload: string; fetchedAt: string } | null>;
  set(payload: string, fetchedAt: string): Promise<void>;
};

export type CatalogFetchResponse = {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
};

export type CatalogFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<CatalogFetchResponse>;

export type GetModelEntriesOptions = {
  store: CatalogStore;
  fetchImpl?: CatalogFetch;
  now?: () => Date;
  ttlMs?: number;
  forceRefresh?: boolean;
};

export type ModelEntriesResult = {
  entries: RegistryEntry[];
  fetchedAt: string | null;
  source: MetadataSource;
  error?: string;
};

// ---------------------------------------------------------------------------
// Parsing and normalisation
// ---------------------------------------------------------------------------

const priceValue = z.union([z.string(), z.number()]);

const liveModelSchema = z.object({
  id: z.string(),
  context_length: z.number().nullish(),
  pricing: z
    .object({ prompt: priceValue.nullish(), completion: priceValue.nullish() })
    .nullish(),
  architecture: z
    .object({
      input_modalities: z.array(z.string()).nullish(),
      output_modalities: z.array(z.string()).nullish(),
    })
    .nullish(),
  supported_parameters: z.array(z.string()).nullish(),
  top_provider: z.object({ max_completion_tokens: z.number().nullish() }).nullish(),
});
export type LiveModel = z.infer<typeof liveModelSchema>;

const responseSchema = z.object({ data: z.array(z.unknown()) });

/** USD per token (decimal string) to USD per million tokens, without float noise. */
export function perTokenToPerMillion(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(n) || n < 0) return null; // negative = OpenRouter "variable pricing"
  return Number((n * 1_000_000).toPrecision(12));
}

const TEXT_ONLY_OUTPUT = (outputs: string[]) => outputs.length > 0 && outputs.every((o) => o === 'text');

function normalise(
  model: RegistryModel,
  live: LiveModel,
  fetchedAt: string,
  source: MetadataSource,
): ModelMetadata {
  const snap = model.snapshot;
  const inputModalities = live.architecture?.input_modalities ?? snap.inputModalities;
  const outputModalities = live.architecture?.output_modalities ?? snap.outputModalities;

  let pricing: TokenPricing | null = null;
  if (TEXT_ONLY_OUTPUT(outputModalities)) {
    const input = perTokenToPerMillion(live.pricing?.prompt);
    const output = perTokenToPerMillion(live.pricing?.completion);
    if (input !== null && output !== null) {
      pricing = { inputPerMillionUsd: input, outputPerMillionUsd: output };
      // The public list carries no tier data: keep the dated snapshot tier.
      if (snap.pricing?.longPromptTier) pricing.longPromptTier = snap.pricing.longPromptTier;
    } else {
      pricing = snap.pricing;
    }
  }
  // Media models price per image/second/character: never invent per-token prices for them.

  const maxCompletion = live.top_provider?.max_completion_tokens;
  return {
    id: model.id,
    pricing,
    ...(pricing === null && snap.pricingUnitNote ? { pricingUnitNote: snap.pricingUnitNote } : {}),
    contextLength: live.context_length && live.context_length > 0 ? live.context_length : snap.contextLength,
    inputModalities: [...inputModalities],
    outputModalities: [...outputModalities],
    supportedParameters: [...(live.supported_parameters ?? snap.supportedParameters)],
    maxCompletionTokens: maxCompletion && maxCompletion > 0 ? maxCompletion : null,
    fetchedAt,
    source,
  };
}

/** Extract registry-id models from a response body. Throws on a malformed body. */
function parseRegistryModels(body: unknown): LiveModel[] {
  const parsed = responseSchema.parse(body);
  const ids = new Set(getRegistry().map((m) => m.id));
  const out = new Map<string, LiveModel>();
  for (const item of parsed.data) {
    const r = liveModelSchema.safeParse(item);
    if (r.success && ids.has(r.data.id) && !out.has(r.data.id)) out.set(r.data.id, r.data);
  }
  return [...out.values()];
}

function buildEntries(live: LiveModel[], fetchedAt: string, source: MetadataSource): RegistryEntry[] {
  const byId = new Map(live.map((l) => [l.id, l]));
  return snapshotEntries().map(({ model }) => {
    const l = byId.get(model.id);
    return { model, metadata: l ? normalise(model, l, fetchedAt, source) : model.snapshot };
  });
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** Egress-proxied fetch. @forge/api loads fine in plain Node, so the script and tests can import this module. */
const defaultFetch: CatalogFetch = async (url, init) =>
  (await forgeFetch(url, init as never)) as unknown as CatalogFetchResponse;

async function fetchLive(fetchImpl: CatalogFetch): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`OpenRouter model list timed out after ${FETCH_TIMEOUT_MS} ms`));
    }, FETCH_TIMEOUT_MS);
  });
  const work = (async () => {
    const res = await fetchImpl(MODELS_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`OpenRouter model list returned HTTP ${res.status}`);
    const declared = Number(res.headers?.get('content-length') ?? 0);
    if (declared > MAX_BODY_BYTES) throw new Error('OpenRouter model list body too large');
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) throw new Error('OpenRouter model list body too large');
    return text;
  })();
  work.catch(() => undefined); // avoid unhandled rejection if the timeout wins the race
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type CachedPayload = { live: LiveModel[]; fetchedAt: string };

function readCache(raw: { payload: string; fetchedAt: string } | null): CachedPayload | null {
  if (!raw || typeof raw.payload !== 'string' || typeof raw.fetchedAt !== 'string') return null;
  try {
    return { live: parseRegistryModels(JSON.parse(raw.payload)), fetchedAt: raw.fetchedAt };
  } catch {
    return null; // corrupt cache is ignored
  }
}

export async function getModelEntries(opts: GetModelEntriesOptions): Promise<ModelEntriesResult> {
  try {
    const { store, fetchImpl = defaultFetch, now = () => new Date(), ttlMs = DEFAULT_TTL_MS, forceRefresh = false } =
      opts;

    let cached: CachedPayload | null = null;
    let cacheError: string | undefined;
    try {
      cached = readCache(await store.get());
    } catch (e) {
      cacheError = `cache read failed: ${msg(e)}`;
    }

    if (cached && !forceRefresh) {
      const age = now().getTime() - new Date(cached.fetchedAt).getTime();
      if (Number.isFinite(age) && age >= 0 && age < ttlMs) {
        return {
          entries: buildEntries(cached.live, cached.fetchedAt, 'cache'),
          fetchedAt: cached.fetchedAt,
          source: 'cache',
        };
      }
    }

    try {
      const text = await fetchLive(fetchImpl);
      const live = parseRegistryModels(JSON.parse(text));
      const fetchedAt = now().toISOString();
      try {
        await store.set(JSON.stringify({ data: live }), fetchedAt);
      } catch {
        // a failing cache write must not fail the call
      }
      return { entries: buildEntries(live, fetchedAt, 'live'), fetchedAt, source: 'live' };
    } catch (e) {
      const error = msg(e);
      if (cached) {
        return {
          entries: buildEntries(cached.live, cached.fetchedAt, 'cache'),
          fetchedAt: cached.fetchedAt,
          source: 'cache',
          error,
        };
      }
      return { entries: snapshotEntries(), fetchedAt: null, source: 'snapshot', error: cacheError ?? error };
    }
  } catch (e) {
    return { entries: snapshotEntries(), fetchedAt: null, source: 'snapshot', error: msg(e) };
  }
}

// ---------------------------------------------------------------------------
// UI table
// ---------------------------------------------------------------------------

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

export function toModelsTable(
  entries: RegistryEntry[],
  opts: { fetchedAt: string | null; source: MetadataSource },
): ModelsTableRow[] {
  return entries.map(({ model, metadata }) => {
    const meta = metadata ?? model.snapshot;
    const p = meta.pricing;
    let priceLabel = 'Price unavailable';
    if (p) {
      const rates = `$${p.inputPerMillionUsd} in / $${p.outputPerMillionUsd} out per 1M tokens`;
      priceLabel =
        meta.source === 'snapshot' ? `Last known price (${(meta.fetchedAt || opts.fetchedAt || '').slice(0, 10)}): ${rates}` : rates;
    }
    return {
      id: model.id,
      displayName: model.displayName,
      role: model.role,
      executorType: model.executorType,
      approved: model.approved,
      enabled: model.enabled,
      strengths: [...model.strengths],
      inputPerMillionUsd: p?.inputPerMillionUsd ?? null,
      outputPerMillionUsd: p?.outputPerMillionUsd ?? null,
      priceLabel,
      pricingUnitNote: meta.pricingUnitNote ?? null,
      contextLength: meta.contextLength,
      inputModalities: meta.inputModalities,
      outputModalities: meta.outputModalities,
      supportedParameters: meta.supportedParameters,
      metadataSource: meta.source,
      fetchedAt: meta.fetchedAt,
      pricingUrl: modelPricingUrl(model.id),
      generalPricingUrl: MODELS_PRICING_URL,
    };
  });
}
