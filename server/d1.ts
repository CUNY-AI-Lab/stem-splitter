// Minimal D1Database shim over node:sqlite, for running the Worker's Hono app
// as a plain Node process (Railway). Implements only the surface src/ uses:
// prepare().bind().first()/run()/all(), batch(), and meta.changes.
//
// This is a prototyping host. Cloudflare D1 stays the production store — nothing
// under src/ knows this file exists.

import { DatabaseSync } from 'node:sqlite';

type Bindable = null | number | bigint | string | Uint8Array;

/** D1 accepts undefined in bind position; node:sqlite does not. */
function coerce(value: unknown): Bindable {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  return String(value);
}

class PreparedStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly values: Bindable[] = []
  ) {}

  /** D1's bind() returns a new statement rather than mutating in place. */
  bind(...values: unknown[]): PreparedStatement {
    return new PreparedStatement(this.db, this.sql, values.map(coerce));
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.values);
    return (row ?? null) as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
    const results = this.db.prepare(this.sql).all(...this.values) as T[];
    return { results, success: true, meta: { changes: 0 } };
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const result = this.db.prepare(this.sql).run(...this.values);
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

export class SqliteD1 {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    // WAL keeps reads from blocking the ingestion writes that run during a webhook.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  prepare(sql: string): PreparedStatement {
    return new PreparedStatement(this.db, sql);
  }

  async batch<T = unknown>(statements: PreparedStatement[]): Promise<T[]> {
    const out: unknown[] = [];
    this.db.exec('BEGIN');
    try {
      for (const statement of statements) out.push(await statement.run());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return out as T[];
  }

  /** Apply the canonical schema. schema.sql is idempotent (CREATE ... IF NOT EXISTS). */
  applySchema(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * Evolve tables on persistent Railway volumes. CREATE TABLE IF NOT EXISTS
   * cannot add columns to a table created by an older release, so additive
   * Node-host changes live here and must remain safe on every boot.
   */
  applyNodeMigrations(): void {
    const settingsColumns = this.db
      .prepare("PRAGMA table_info('assistant_settings')")
      .all() as Array<{ name: string }>;
    if (!settingsColumns.some((column) => column.name === 'revision')) {
      this.db.exec(
        'ALTER TABLE assistant_settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0'
      );
    }
  }
}
