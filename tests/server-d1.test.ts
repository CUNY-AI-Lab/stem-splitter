import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteD1 } from '../server/d1.ts';
import { cacheGuideIfPromptCurrent, getGuide } from '../src/assistant/index.ts';
import { SYSTEM_PROMPT_VERSION } from '../src/assistant/prompt.ts';
import { setAmendment } from '../src/teacher/auth.ts';

const promptTrace = (changeNote: string) => ({
  changeNote,
  basePromptVersion: SYSTEM_PROMPT_VERSION,
  basePromptHash: 'a'.repeat(64),
  effectivePromptHash: 'b'.repeat(64),
});

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
    const results = await Promise.all([
      setAmendment(env, 'first candidate', 'teacher-a', 0, promptTrace('first')),
      setAmendment(env, 'second candidate', 'teacher-b', 0, promptTrace('second')),
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

test('prompt save rolls back settings and history when cache invalidation fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-prompt-rollback-'));
  try {
    const db = new SqliteD1(join(directory, 'prompt.sqlite'));
    db.applySchema(`
      CREATE TABLE assistant_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        amendment TEXT NOT NULL DEFAULT '',
        updated_by TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        revision INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO assistant_settings (id, amendment) VALUES (1, 'original');
      CREATE TABLE assistant_prompt_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        settings_revision INTEGER NOT NULL UNIQUE,
        amendment TEXT NOT NULL,
        change_note TEXT NOT NULL,
        base_prompt_version TEXT NOT NULL,
        base_prompt_hash TEXT NOT NULL,
        effective_prompt_hash TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const env = { DB: db } as never;

    await assert.rejects(
      setAmendment(env, 'candidate', 'teacher-a', 0, promptTrace('must roll back')),
      /no such table: guides/
    );
    const settings = await db
      .prepare('SELECT amendment, revision FROM assistant_settings WHERE id = 1')
      .first<{ amendment: string; revision: number }>();
    assert.deepEqual({ ...settings }, { amendment: 'original', revision: 0 });
    assert.deepEqual(
      (await db.prepare('SELECT settings_revision FROM assistant_prompt_revisions').all()).results,
      []
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('guide caching rejects an in-flight old prompt and filters old fixed versions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-guide-prompt-'));
  try {
    const db = new SqliteD1(join(directory, 'guide.sqlite'));
    db.applySchema(readFileSync('schema.sql', 'utf8'));
    const env = { DB: db } as never;
    const guide = (text: string) => ({
      jobId: 'job-a',
      text,
      model: 'test-model',
      createdAt: '2026-08-09T12:00:00.000Z',
    });

    assert.equal(await cacheGuideIfPromptCurrent(env, guide('revision zero'), 0), true);
    assert.equal((await getGuide(env, 'job-a'))?.text, 'revision zero');

    await setAmendment(env, 'new class direction', 'teacher-a', 0, promptTrace('revision one'));
    assert.equal(await cacheGuideIfPromptCurrent(env, guide('stale in-flight guide'), 0), false);
    assert.equal(await getGuide(env, 'job-a'), null);

    assert.equal(await cacheGuideIfPromptCurrent(env, guide('revision one'), 1), true);
    assert.equal((await getGuide(env, 'job-a'))?.text, 'revision one');
    const stored = await db
      .prepare('SELECT prompt_version, prompt_revision FROM guides WHERE job_id = ?')
      .bind('job-a')
      .first<{ prompt_version: string; prompt_revision: number }>();
    assert.deepEqual(
      { ...stored },
      { prompt_version: SYSTEM_PROMPT_VERSION, prompt_revision: 1 }
    );

    await db
      .prepare("UPDATE guides SET prompt_version = 'previous-code-version' WHERE job_id = ?")
      .bind('job-a')
      .run();
    assert.equal(await getGuide(env, 'job-a'), null);
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

test('Railway boot marks legacy guide rows for lazy prompt-aware regeneration', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-guide-migration-'));
  try {
    const db = new SqliteD1(join(directory, 'legacy.sqlite'));
    db.applySchema(`
      CREATE TABLE guides (
        job_id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE assistant_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        amendment TEXT NOT NULL DEFAULT '',
        updated_by TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        revision INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO assistant_settings (id, amendment) VALUES (1, '');
      INSERT INTO guides (job_id, text, model) VALUES ('legacy-job', 'old guide', 'old-model');
    `);

    db.applyNodeMigrations();
    db.applyNodeMigrations();

    const columns = await db.prepare("PRAGMA table_info('guides')").all<{ name: string }>();
    assert.equal(columns.results.filter((column) => column.name === 'prompt_version').length, 1);
    assert.equal(columns.results.filter((column) => column.name === 'prompt_revision').length, 1);
    const legacy = await db
      .prepare('SELECT text, prompt_version, prompt_revision FROM guides WHERE job_id = ?')
      .bind('legacy-job')
      .first<{ text: string; prompt_version: string; prompt_revision: number }>();
    assert.deepEqual(
      { ...legacy },
      { text: 'old guide', prompt_version: '', prompt_revision: -1 }
    );
    assert.equal(await getGuide({ DB: db } as never, 'legacy-job'), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('numbered guide-cache migration invalidates legacy rows without deleting them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-guide-migration-sql-'));
  try {
    const db = new SqliteD1(join(directory, 'legacy.sqlite'));
    db.applySchema(`
      CREATE TABLE guides (
        job_id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE assistant_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        amendment TEXT NOT NULL DEFAULT '',
        updated_by TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        revision INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO assistant_settings (id, amendment) VALUES (1, '');
      INSERT INTO guides (job_id, text, model) VALUES ('legacy-job', 'old guide', 'old-model');
    `);

    db.applySchema(readFileSync('migrations/0007-guide-prompt-cache.sql', 'utf8'));

    const legacy = await db
      .prepare('SELECT text, prompt_version, prompt_revision FROM guides WHERE job_id = ?')
      .bind('legacy-job')
      .first<{ text: string; prompt_version: string; prompt_revision: number }>();
    assert.deepEqual(
      { ...legacy },
      { text: 'old guide', prompt_version: '', prompt_revision: -1 }
    );
    assert.equal(await getGuide({ DB: db } as never, 'legacy-job'), null);
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
