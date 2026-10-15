import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { sql: string; params: unknown[] };
const calls: Call[] = [];
let handler: (call: Call) => unknown;

vi.mock('@forge/sql', () => ({
  sql: {
    prepare: (statement: string) => ({
      bindParams: (...params: unknown[]) => ({
        execute: async () => {
          const call = { sql: statement, params };
          calls.push(call);
          return handler(call);
        },
      }),
    }),
  },
}));

import { sqlCatalogStore, toSqlTimestamp } from './catalogStore';

const missingTable = Object.assign(new Error('Unknown SQL execution error'), {
  context: { debug: { code: 'ER_NO_SUCH_TABLE', errno: 1146, sqlMessage: "Table 'x.ModelCatalogCache' doesn't exist" } },
});

beforeEach(() => {
  calls.length = 0;
  handler = () => ({ rows: [] });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('sqlCatalogStore.get', () => {
  it('returns null for an empty table', async () => {
    expect(await sqlCatalogStore.get()).toBeNull();
    expect(calls[0].params).toEqual(['openrouter']);
    expect(calls[0].sql).toMatch(/FROM ModelCatalogCache WHERE id = \?/);
  });
  it('returns payload and ISO fetchedAt', async () => {
    handler = () => ({ rows: [{ payload: '{"data":[]}', fetched_at: '2026-10-15T01:02:03Z' }] });
    expect(await sqlCatalogStore.get()).toEqual({ payload: '{"data":[]}', fetchedAt: '2026-10-15T01:02:03Z' });
  });
  it('returns null when the table is missing', async () => {
    handler = () => {
      throw missingTable;
    };
    expect(await sqlCatalogStore.get()).toBeNull();
  });
  it('propagates other errors', async () => {
    handler = () => {
      throw new Error('boom');
    };
    await expect(sqlCatalogStore.get()).rejects.toThrow('boom');
  });
});

describe('sqlCatalogStore.set', () => {
  it('upserts the single row with bound params and a MySQL timestamp', async () => {
    handler = () => ({ rows: { affectedRows: 1 } });
    await sqlCatalogStore.set('{"data":[]}', '2026-10-15T01:02:03.456Z');
    expect(calls[0].sql).toMatch(/ON DUPLICATE KEY UPDATE/);
    expect(calls[0].params).toEqual(['openrouter', '{"data":[]}', '2026-10-15 01:02:03']);
  });
  it('swallows failures including a missing table', async () => {
    handler = () => {
      throw missingTable;
    };
    await expect(sqlCatalogStore.set('x', '2026-10-15T00:00:00.000Z')).resolves.toBeUndefined();
    handler = () => {
      throw new Error('boom');
    };
    await expect(sqlCatalogStore.set('x', '2026-10-15T00:00:00.000Z')).resolves.toBeUndefined();
  });
  it('swallows an invalid timestamp', async () => {
    await expect(sqlCatalogStore.set('x', 'not a date')).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe('toSqlTimestamp', () => {
  it('formats UTC', () => {
    expect(toSqlTimestamp('2026-10-15T23:59:59.999Z')).toBe('2026-10-15 23:59:59');
  });
});
