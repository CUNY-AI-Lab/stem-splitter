import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteD1 } from '../server/d1.ts';
import { setAmendment } from '../src/teacher/auth.ts';

test('Railway and CI use one exact Node runtime for the active SQLite host', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    engines?: { node?: string };
  };
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.equal(packageJson.engines?.node, '22.23.1');
  assert.equal(process.versions.node, '22.23.1');
  assert.match(workflow, /node-version: "22\.23\.1"/);
});

test('Railway D1 batches cannot interleave transactions on one connection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-batch-'));
  try {
    const db = new SqliteD1(join(directory, 'batch.sqlite'));
    db.applySchema('CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');

    await Promise.all([
      db.batch([
        db.prepare('INSERT INTO entries(value) VALUES (?)').bind('a1'),
        db.prepare('INSERT INTO entries(value) VALUES (?)').bind('a2'),
      ]),
      db.batch([
        db.prepare('INSERT INTO entries(value) VALUES (?)').bind('b1'),
        db.prepare('INSERT INTO entries(value) VALUES (?)').bind('b2'),
      ]),
    ]);

    const rows = await db
      .prepare('SELECT value FROM entries ORDER BY value')
      .all<{ value: string }>();
    assert.deepEqual(rows.results.map((row) => row.value), ['a1', 'a2', 'b1', 'b2']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a losing prompt compare-and-swap cannot invalidate regenerated guides', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-guide-cas-'));
  try {
    const db = new SqliteD1(join(directory, 'guide-cas.sqlite'));
    db.applySchema(`
      CREATE TABLE settings (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE guides (id INTEGER PRIMARY KEY);
      INSERT INTO settings (id, revision) VALUES (1, 1);
      INSERT INTO guides (id) VALUES (1);
    `);

    const losing = await db.batch<{ meta: { changes: number } }>([
      db.prepare('UPDATE settings SET revision = revision + 1 WHERE id = 1 AND revision = 0'),
      db.prepare('DELETE FROM guides WHERE changes() = 1'),
    ]);
    assert.equal(losing[0].meta.changes, 0);
    assert.equal(losing[1].meta.changes, 0);
    assert.equal((await db.prepare('SELECT id FROM guides').all()).results.length, 1);

    const winning = await db.batch<{ meta: { changes: number } }>([
      db.prepare('UPDATE settings SET revision = revision + 1 WHERE id = 1 AND revision = 1'),
      db.prepare('DELETE FROM guides WHERE changes() = 1'),
    ]);
    assert.equal(winning[0].meta.changes, 1);
    assert.equal(winning[1].meta.changes, 1);
    assert.deepEqual((await db.prepare('SELECT id FROM guides').all()).results, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('concurrent prompt saves atomically join history and guide invalidation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-prompt-batch-'));
  try {
    const db = new SqliteD1(join(directory, 'prompt.sqlite'));
    db.applySchema(readFileSync('schema.sql', 'utf8'));
    await db.batch([
      db.prepare("INSERT INTO guides (job_id, text, model) VALUES ('job-a', 'old a', 'model')"),
      db.prepare("INSERT INTO guides (job_id, text, model) VALUES ('job-b', 'old b', 'model')"),
    ]);
    const env = { DB: db } as never;
    const trace = (changeNote: string) => ({
      changeNote,
      basePromptVersion: 'test-base-v1',
      basePromptHash: 'a'.repeat(64),
      effectivePromptHash: 'b'.repeat(64),
    });

    const results = await Promise.all([
      setAmendment(env, 'first candidate', 'teacher-a', 0, trace('first')),
      setAmendment(env, 'second candidate', 'teacher-b', 0, trace('second')),
    ]);
    const winner = results.find((result) => result.changed);
    const loser = results.find((result) => result.conflict);
    assert.ok(winner);
    assert.ok(loser);
    assert.equal(winner.guidesCleared, 2);
    assert.equal(winner.revision?.settingsRevision, 1);
    assert.equal(loser.guidesCleared, 0);

    const settings = await db
      .prepare('SELECT amendment, revision FROM assistant_settings WHERE id = 1')
      .first<{ amendment: string; revision: number }>();
    assert.equal(settings?.revision, 1);
    assert.equal(settings?.amendment, winner.record.amendment);
    const history = await db
      .prepare('SELECT settings_revision, amendment FROM assistant_prompt_revisions')
      .all<{ settings_revision: number; amendment: string }>();
    assert.deepEqual(history.results.map((row) => ({ ...row })), [
      { settings_revision: 1, amendment: winner.record.amendment },
    ]);
    const guides = await db.prepare('SELECT job_id FROM guides').all();
    assert.deepEqual(guides.results, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
