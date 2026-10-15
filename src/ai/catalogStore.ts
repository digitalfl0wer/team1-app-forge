import { sql } from '@forge/sql';
import type { CatalogStore } from './modelCatalog';

const ROW_ID = 'openrouter';

/** Forge wraps MySQL details in error.context.debug; look at both (same idea as todos.ts sqlErrorText). */
function errorText(error: unknown): string {
  const parts: string[] = [error instanceof Error ? error.message : String(error)];
  const debug = (error as { context?: { debug?: Record<string, unknown> } } | null)?.context?.debug;
  if (debug && typeof debug === 'object') {
    for (const key of ['message', 'code', 'errno', 'sqlMessage'] as const) {
      if (debug[key] !== undefined && debug[key] !== null) parts.push(String(debug[key]));
    }
  }
  return parts.join(' ');
}

function isMissingTable(error: unknown): boolean {
  return /doesn't exist|does not exist|no such table|ER_NO_SUCH_TABLE|\b1146\b/i.test(errorText(error));
}

/** ISO-8601 to the 'YYYY-MM-DD HH:MM:SS' (UTC) form MySQL TIMESTAMP columns accept. */
export function toSqlTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error('invalid timestamp');
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

type CacheRow = { payload: string; fetched_at: string | Date };

/**
 * SQL-backed catalog cache (table ModelCatalogCache, migration v007).
 * get(): null when the table is missing; other failures propagate (getModelEntries records them).
 * set(): never throws; a failing cache write must not break a request.
 * Timestamps are stored and read as UTC (Forge SQL sessions run in UTC).
 */
export const sqlCatalogStore: CatalogStore = {
  async get() {
    try {
      const result = await sql
        .prepare<CacheRow>(
          `SELECT payload, DATE_FORMAT(fetched_at, '%Y-%m-%dT%H:%i:%sZ') AS fetched_at FROM ModelCatalogCache WHERE id = ?`,
        )
        .bindParams(ROW_ID)
        .execute();
      const row = result.rows[0];
      if (!row || typeof row.payload !== 'string') return null;
      const fetchedAt = row.fetched_at instanceof Date ? row.fetched_at.toISOString() : String(row.fetched_at);
      return { payload: row.payload, fetchedAt };
    } catch (error) {
      if (isMissingTable(error)) return null;
      throw error;
    }
  },

  async set(payload, fetchedAt) {
    try {
      await sql
        .prepare(
          `INSERT INTO ModelCatalogCache (id, payload, fetched_at) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE payload = VALUES(payload), fetched_at = VALUES(fetched_at)`,
        )
        .bindParams(ROW_ID, payload, toSqlTimestamp(fetchedAt))
        .execute();
    } catch (error) {
      console.error(`[ai] model catalog cache write failed missingTable=${isMissingTable(error)}`);
    }
  },
};
