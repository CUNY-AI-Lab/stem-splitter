import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteD1 } from '../server/d1.ts';

test('Railway boot adds prompt revisions to an existing settings table', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-d1-'));
  try {
    const db = new SqliteD1(join(directory, 'legacy.sqlite'));
    db.applySchema(`
      CREATE TABLE assistant_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        amendment TEXT NOT NULL DEFAULT '',
        updated_by TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO assistant_settings (id, amendment) VALUES (1, 'keep this');
    `);

    db.applyNodeMigrations();
    db.applyNodeMigrations();

    const columns = await db
      .prepare("PRAGMA table_info('assistant_settings')")
      .all<{ name: string }>();
    assert.equal(columns.results.filter((column) => column.name === 'revision').length, 1);
    const row = await db
      .prepare('SELECT amendment, revision FROM assistant_settings WHERE id = 1')
      .first<{ amendment: string; revision: number }>();
    assert.equal(row?.amendment, 'keep this');
    assert.equal(row?.revision, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Railway boot adds Auto routing metadata without changing legacy job models', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-routing-'));
  try {
    const db = new SqliteD1(join(directory, 'legacy.sqlite'));
    db.applySchema(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        source_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        external_id TEXT,
        stems TEXT,
        error TEXT,
        model TEXT,
        labels TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO jobs (id, filename, source_key, model)
      VALUES ('legacy-job', 'song.wav', 'uploads/legacy/song.wav', 'htdemucs_ft');
    `);

    db.applyNodeMigrations();
    db.applyNodeMigrations();

    const columns = await db.prepare("PRAGMA table_info('jobs')").all<{ name: string }>();
    for (const name of ['routing_request', 'source_type', 'analysis']) {
      assert.equal(columns.results.filter((column) => column.name === name).length, 1, name);
    }
    const row = await db
      .prepare('SELECT model, routing_request, source_type, analysis FROM jobs WHERE id = ?')
      .bind('legacy-job')
      .first<{
        model: string;
        routing_request: string | null;
        source_type: string | null;
        analysis: string | null;
      }>();
    assert.deepEqual({ ...row }, {
      model: 'htdemucs_ft',
      routing_request: null,
      source_type: null,
      analysis: null,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
