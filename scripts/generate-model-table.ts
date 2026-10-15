/**
 * Writes docs/ai/model-table.md from live OpenRouter metadata (public endpoint, no key).
 * Run with: npm run models:table
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { getModelEntries, toModelsTable } from '../src/ai/modelCatalog';
import type { CatalogFetch } from '../src/ai/modelCatalog';

const cell = (s: string): string => s.replace(/\|/g, '\\|');
const list = (a: string[]): string => (a.length ? a.join(', ') : '-');

async function main(): Promise<void> {
  const result = await getModelEntries({
    store: { get: async () => null, set: async () => undefined },
    fetchImpl: globalThis.fetch as unknown as CatalogFetch,
    forceRefresh: true,
  });
  const rows = toModelsTable(result.entries, { fetchedAt: result.fetchedAt, source: result.source });

  const lines = [
    '# Model table',
    '',
    `Generated: ${result.fetchedAt ?? new Date().toISOString()}`,
    `Source: ${result.source}${result.error ? ` (fallback; error: ${result.error})` : ''}`,
    '',
    'Prices change. This table is a point-in-time copy of OpenRouter metadata; check https://openrouter.ai/models before relying on it. Strengths are the team assessment, not benchmarks.',
    '',
    '| Model | Role | Executor | Enabled | Price | Context | Input | Output | Parameters | Source |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) =>
      [
        `[${cell(r.displayName)}](${r.pricingUrl}) (\`${r.id}\`)`,
        cell(r.role),
        r.executorType,
        r.enabled ? 'yes' : 'no (disabled)',
        cell(r.pricingUnitNote && r.inputPerMillionUsd === null ? `${r.priceLabel}. ${r.pricingUnitNote}` : r.priceLabel),
        r.contextLength === null ? '-' : r.contextLength.toLocaleString('en-US'),
        list(r.inputModalities),
        list(r.outputModalities),
        cell(list(r.supportedParameters)),
        r.metadataSource,
      ].join(' | ').replace(/^/, '| ').concat(' |'),
    ),
    '',
  ];

  const out = resolve(process.cwd(), 'docs/ai/model-table.md');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join('\n'));
  console.log(`Wrote ${out} (source: ${result.source}${result.error ? `, error: ${result.error}` : ''})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
