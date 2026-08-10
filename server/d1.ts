// Minimal D1Database shim over node:sqlite, for running the Worker's Hono app
// as a plain Node process (Railway). Implements only the surface src/ uses:
// prepare().bind().first()/run()/all(), batch(), and meta.changes.
//
// Railway is the active host until the finished product migrates to Cloudflare;
// nothing under src/ knows this adapter exists.

import { DatabaseSync } from 'node:sqlite';
import { JOB_SOURCE_IDENTITY_IMMUTABILITY_SQL } from '../src/analysis/schema.ts';
import { INSTRUMENT_ISOLATIONS_SCHEMA_SQL } from '../src/isolation/schema.ts';
import { PROMPT_HISTORY_IMMUTABILITY_SQL } from '../src/teacher/schema.ts';

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

  runSync(): { success: true; meta: { changes: number; last_row_id: number } } {
    const result = this.db.prepare(this.sql).run(...this.values);
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    return this.runSync();
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
    // DatabaseSync is synchronous. Awaiting each already-completed statement
    // lets another request issue BEGIN on this same connection mid-batch,
    // violating the atomic D1 batch contract.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of statements) out.push(statement.runSync());
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
    if (settingsColumns.length && !settingsColumns.some((column) => column.name === 'revision')) {
      this.db.exec(
        'ALTER TABLE assistant_settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0'
      );
    }

    const promptHistoryColumns = this.db
      .prepare("PRAGMA table_info('assistant_prompt_revisions')")
      .all() as Array<{ name: string }>;
    if (promptHistoryColumns.length) {
      this.db.exec(PROMPT_HISTORY_IMMUTABILITY_SQL);
    }

    const guideColumns = this.db
      .prepare("PRAGMA table_info('guides')")
      .all() as Array<{ name: string }>;
    if (guideColumns.length) {
      if (!guideColumns.some((column) => column.name === 'prompt_version')) {
        this.db.exec(
          "ALTER TABLE guides ADD COLUMN prompt_version TEXT NOT NULL DEFAULT ''"
        );
      }
      if (!guideColumns.some((column) => column.name === 'prompt_revision')) {
        this.db.exec(
          'ALTER TABLE guides ADD COLUMN prompt_revision INTEGER NOT NULL DEFAULT -1'
        );
      }
      if (!guideColumns.some((column) => column.name === 'prompt_hash')) {
        this.db.exec(
          `ALTER TABLE guides ADD COLUMN prompt_hash TEXT NOT NULL DEFAULT ''
           CHECK (prompt_hash = '' OR (
             length(prompt_hash) = 64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'
           ))`
        );
      }
    }

    const jobColumns = this.db
      .prepare("PRAGMA table_info('jobs')")
      .all() as Array<{ name: string }>;
    if (jobColumns.length) {
      for (const column of ['routing_request', 'source_type', 'analysis']) {
        if (!jobColumns.some((candidate) => candidate.name === column)) {
          this.db.exec(`ALTER TABLE jobs ADD COLUMN ${column} TEXT`);
        }
      }
      if (!jobColumns.some((candidate) => candidate.name === 'source_hash')) {
        this.db.exec(
          `ALTER TABLE jobs ADD COLUMN source_hash TEXT
           CHECK (source_hash IS NULL OR (
             length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'
           ))`
        );
      }
      this.db.exec(JOB_SOURCE_IDENTITY_IMMUTABILITY_SQL);
    }

    // New tables cannot be recovered by ALTER-column checks alone on an old
    // persistent volume. Keep this exact additive resource safe on every boot.
    this.db.exec(INSTRUMENT_ISOLATIONS_SCHEMA_SQL);
    const isolationColumns = this.db
      .prepare("PRAGMA table_info('instrument_isolations')")
      .all() as Array<{ name: string }>;
    if (
      isolationColumns.length &&
      !isolationColumns.some((column) => column.name === 'rollout_stage')
    ) {
      this.db.exec(
        "ALTER TABLE instrument_isolations ADD COLUMN rollout_stage TEXT NOT NULL DEFAULT 'shadow' CHECK (rollout_stage IN ('shadow', 'teacher_beta'))"
      );
    }
  }
}
