import { describe, expect, it, vi } from 'vitest';

vi.mock('@forge/sql', () => {
  const runner = {
    names: [] as string[],
    enqueue(name: string) {
      this.names.push(name);
      return this;
    },
    run: vi.fn(async () => []),
    list: vi.fn(async () => []),
  };
  return { migrationRunner: runner };
});

import { MIGRATIONS, runSchemaMigration } from './migration';

describe('migrations', () => {
  it('keeps v001 first and uses unique ordered names, one statement each', () => {
    expect(MIGRATIONS[0][0]).toBe('v001_create_todos_table');
    const names = MIGRATIONS.map(([n]) => n);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(names);
    for (const [, statement] of MIGRATIONS) expect(statement.trim().split(';').filter(Boolean)).toHaveLength(1);
  });
  it('adds the four contract columns', () => {
    const all = MIGRATIONS.map(([, s]) => s).join('\n');
    for (const col of ['notes', 'ai_state', 'content_version', 'updated_at']) {
      expect(all).toMatch(new RegExp(`ALTER TABLE Todos ADD COLUMN ${col} `));
    }
  });
  it('runSchemaMigration returns 200', async () => {
    expect((await runSchemaMigration()).statusCode).toBe(200);
  });
});
