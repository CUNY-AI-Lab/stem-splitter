import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteD1 } from '../server/d1.ts';
import { cacheGuideIfPromptCurrent, getGuide } from '../src/assistant/index.ts';
import {
  hashSystemPromptFingerprint,
  SYSTEM_PROMPT_VERSION,
} from '../src/assistant/prompt.ts';
import {
  createSession,
  getPromptHistoryPage,
  resolveSession,
  setAmendment,
  syncTeachersFromSeed,
} from '../src/teacher/auth.ts';
import { queryIsolationCacheKeyForMaterial } from '../src/isolation/contract.ts';
import { QUERY_ISOLATION_BUDGET_POLICY_VERSION } from '../src/isolation/budget.ts';
import {
  attachInstrumentIsolationExternalId,
  claimInstrumentIsolation,
  createInstrumentIsolation,
  expireTimedOutInstrumentIsolations,
  failInstrumentIsolation,
  getInstrumentIsolationBudgetUsage,
  getInstrumentIsolation,
  InstrumentIsolationResourceError,
  listInstrumentIsolations,
  requeueInstrumentIsolation,
  summarizeInstrumentIsolation,
} from '../src/isolation/resource.ts';
import {
  claimInstrumentIsolationIngestion,
  completeInstrumentIsolationIngestion,
} from '../src/isolation/ingestion.ts';
import type { StoredQueryIsolationOutputV1 } from '../src/isolation/output.ts';
import {
  getLatestInstrumentDiscoveryFeedback,
  InstrumentDiscoveryFeedbackError,
  recordInstrumentDiscoveryFeedback,
  summarizeInstrumentDiscoveryFeedback,
} from '../src/analysis/instrument-feedback.ts';
import { INSTRUMENT_REVIEW_ONTOLOGY_VERSION } from '../src/analysis/instrument-review.ts';

const promptTrace = (changeNote: string) => ({
  changeNote,
  basePromptVersion: SYSTEM_PROMPT_VERSION,
  basePromptHash: 'a'.repeat(64),
  effectivePromptHash: 'b'.repeat(64),
});

const PROMPT_HISTORY_TABLE_SQL = `
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
`;

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

test('candidate instrument feedback is revisioned, source-bound, and never training eligible', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-instrument-feedback-'));
  try {
    const db = new SqliteD1(join(directory, 'feedback.sqlite'));
    db.applySchema(readFileSync('schema.sql', 'utf8'));
    const rawAnalysis = JSON.stringify({ exact: 'stored-analysis-v1' });
    const sourceSha256 = '1'.repeat(64);
    await db.prepare(
      `INSERT INTO jobs
        (id, filename, source_key, status, model, routing_request, source_type, source_hash, analysis)
       VALUES ('feedback-job', 'review.wav', 'uploads/review/source.wav', 'done',
               'htdemucs_6s', 'auto', 'upload', ?, ?)`
    ).bind(sourceSha256, rawAnalysis).run();
    const env = { DB: db } as never;
    const target = {
      jobId: 'feedback-job',
      reviewer: 'teacher-a',
      rawAnalysis,
      analysisSha256: createHash('sha256').update(rawAnalysis).digest('hex'),
      sourceSha256,
      classifierVersion: 'candidate-classifier-v1',
      vocabularyVersion: 'classroom-instruments-v1',
      vocabularySha256: '3'.repeat(64),
      detectedInstrumentIds: ['saxophone'],
    } as const;

    const first = await recordInstrumentDiscoveryFeedback(env, {
      ...target,
      id: 'feedback_revision_1',
      expectedRevision: 0,
      genreFamily: 'jazz',
      observations: [
        { instrumentId: 'saxophone', verdict: 'confirmed' },
        { instrumentId: 'trumpet', verdict: 'missed' },
      ],
      now: new Date('2026-08-10T12:00:00.000Z'),
    });
    assert.equal(first.changed, true);
    assert.equal(first.record.revision, 1);
    assert.equal(first.record.reviewer, 'teacher-a');
    assert.equal(first.record.sourceSha256, sourceSha256);
    assert.equal(first.record.reviewOntologyVersion, INSTRUMENT_REVIEW_ONTOLOGY_VERSION);
    assert.equal(first.record.deidentified, false);
    assert.equal(first.record.trainingEligible, false);

    const unchanged = await recordInstrumentDiscoveryFeedback(env, {
      ...target,
      expectedRevision: 1,
      genreFamily: 'jazz',
      observations: [
        { instrumentId: 'trumpet', verdict: 'missed' },
        { instrumentId: 'saxophone', verdict: 'confirmed' },
      ],
    });
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.record.id, first.record.id);

    const second = await recordInstrumentDiscoveryFeedback(env, {
      ...target,
      id: 'feedback_revision_2',
      expectedRevision: 1,
      genreFamily: 'folk-traditional',
      observations: [
        { instrumentId: 'saxophone', verdict: 'absent' },
        { instrumentId: 'trumpet', verdict: 'missed' },
      ],
      now: new Date('2026-08-10T12:01:00.000Z'),
    });
    assert.equal(second.record.revision, 2);
    assert.deepEqual(summarizeInstrumentDiscoveryFeedback(second.record), {
      schemaVersion: '1',
      revision: 2,
      genreFamily: 'folk-traditional',
      observations: [
        { instrumentId: 'saxophone', verdict: 'absent' },
        { instrumentId: 'trumpet', verdict: 'missed' },
      ],
      evidenceStatus: 'unreviewed-candidate',
      deidentified: false,
      trainingEligible: false,
      createdAt: '2026-08-10T12:01:00.000Z',
    });
    await assert.rejects(
      recordInstrumentDiscoveryFeedback(env, {
        ...target,
        expectedRevision: 1,
        genreFamily: 'rock',
        observations: [{ instrumentId: 'saxophone', verdict: 'confirmed' }],
      }),
      (error) =>
        error instanceof InstrumentDiscoveryFeedbackError && error.code === 'conflict'
    );
    await assert.rejects(
      recordInstrumentDiscoveryFeedback(env, {
        ...target,
        analysisSha256: '2'.repeat(64),
        expectedRevision: 0,
        genreFamily: 'rock',
        observations: [{ instrumentId: 'saxophone', verdict: 'confirmed' }],
      }),
      (error) =>
        error instanceof InstrumentDiscoveryFeedbackError &&
        error.code === 'invalid_request' &&
        /fingerprint/.test(error.message)
    );
    await assert.rejects(
      recordInstrumentDiscoveryFeedback(env, {
        ...target,
        rawAnalysis: '{"changed":true}',
        analysisSha256: createHash('sha256').update('{"changed":true}').digest('hex'),
        expectedRevision: 0,
        genreFamily: 'rock',
        observations: [{ instrumentId: 'saxophone', verdict: 'confirmed' }],
      }),
      (error) =>
        error instanceof InstrumentDiscoveryFeedbackError && error.code === 'analysis_changed'
    );
    await assert.rejects(
      db.prepare(
        "UPDATE instrument_discovery_feedback SET genre_family = 'rock' WHERE id = 'feedback_revision_2'"
      ).run(),
      /revisions are immutable/
    );
    const stored = await db.prepare(
      `SELECT reviewer, source_sha256, deidentified, training_eligible
       FROM instrument_discovery_feedback WHERE id = 'feedback_revision_2'`
    ).first<{
      reviewer: string;
      source_sha256: string;
      deidentified: number;
      training_eligible: number;
    }>();
    assert.deepEqual({ ...stored }, {
      reviewer: 'teacher-a',
      source_sha256: sourceSha256,
      deidentified: 0,
      training_eligible: 0,
    });
    assert.equal(
      (await getLatestInstrumentDiscoveryFeedback(env, target))?.id,
      'feedback_revision_2'
    );

    await db.prepare("DELETE FROM jobs WHERE id = 'feedback-job'").run();
    assert.equal(
      (await db.prepare('SELECT id FROM instrument_discovery_feedback').all()).results.length,
      0,
      'feedback retention must follow deletion of its source job'
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Railway boot and numbered migration both add immutable feedback storage idempotently', async () => {
  for (const migration of ['node', 'numbered'] as const) {
    const directory = mkdtempSync(join(tmpdir(), `stem-splitter-feedback-${migration}-`));
    try {
      const db = new SqliteD1(join(directory, 'feedback.sqlite'));
      db.applySchema('CREATE TABLE jobs (id TEXT PRIMARY KEY);');
      if (migration === 'node') {
        db.applyNodeMigrations();
        db.applyNodeMigrations();
      } else {
        const sql = readFileSync('migrations/0014-instrument-discovery-feedback.sql', 'utf8');
        db.applySchema(sql);
        db.applySchema(sql);
      }
      const columns = await db.prepare("PRAGMA table_info('instrument_discovery_feedback')")
        .all<{ name: string }>();
      assert.deepEqual(
        columns.results.map(({ name }) => name),
        [
          'id', 'schema_version', 'job_id', 'reviewer', 'revision', 'analysis_sha256',
          'source_sha256', 'classifier_version', 'vocabulary_version', 'vocabulary_sha256',
          'review_ontology_version', 'genre_family', 'observations', 'evidence_status',
          'deidentified', 'training_eligible', 'created_at',
        ]
      );
      const triggers = await db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'instrument_discovery_feedback_%' ORDER BY name"
      ).all<{ name: string }>();
      assert.deepEqual(triggers.results.map(({ name }) => name), [
        'instrument_discovery_feedback_no_replace',
        'instrument_discovery_feedback_no_update',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('concurrent candidate feedback submissions create exactly one next revision', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-feedback-race-'));
  try {
    const db = new SqliteD1(join(directory, 'feedback.sqlite'));
    db.applySchema(readFileSync('schema.sql', 'utf8'));
    const rawAnalysis = JSON.stringify({ exact: 'race-analysis-v1' });
    const sourceSha256 = '4'.repeat(64);
    await db.prepare(
      `INSERT INTO jobs
        (id, filename, source_key, status, model, routing_request, source_type, source_hash, analysis)
       VALUES ('feedback-race', 'race.wav', 'uploads/race/source.wav', 'done',
               'htdemucs_ft', 'auto', 'upload', ?, ?)`
    ).bind(sourceSha256, rawAnalysis).run();
    const target = {
      jobId: 'feedback-race',
      reviewer: 'teacher-a',
      rawAnalysis,
      analysisSha256: createHash('sha256').update(rawAnalysis).digest('hex'),
      sourceSha256,
      classifierVersion: 'candidate-classifier-v1',
      vocabularyVersion: 'classroom-instruments-v1',
      vocabularySha256: '5'.repeat(64),
      detectedInstrumentIds: ['saxophone'],
      expectedRevision: 0,
      observations: [{ instrumentId: 'saxophone', verdict: 'confirmed' as const }],
    };
    const results = await Promise.allSettled([
      recordInstrumentDiscoveryFeedback({ DB: db } as never, {
        ...target,
        id: 'feedback_race_a',
        genreFamily: 'jazz',
      }),
      recordInstrumentDiscoveryFeedback({ DB: db } as never, {
        ...target,
        id: 'feedback_race_b',
        genreFamily: 'rock',
      }),
    ]);
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    const rejected = results.find(({ status }) => status === 'rejected');
    assert.equal(rejected?.status, 'rejected');
    assert.ok(
      rejected.status === 'rejected' &&
        rejected.reason instanceof InstrumentDiscoveryFeedbackError &&
        rejected.reason.code === 'conflict'
    );
    const rows = await db.prepare(
      'SELECT revision FROM instrument_discovery_feedback WHERE job_id = ?'
    ).bind('feedback-race').all<{ revision: number }>();
    assert.deepEqual(rows.results.map(({ revision }) => ({ revision })), [{ revision: 1 }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('teacher sessions expire by parsed SQLite time, not timestamp text ordering', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-session-expiry-'));
  try {
    const db = new SqliteD1(join(directory, 'sessions.sqlite'));
    db.applySchema(readFileSync('schema.sql', 'utf8'));
    await db.prepare(
      `INSERT INTO teachers (username, display_name, salt, password_hash, iterations)
       VALUES ('teacher', 'Teacher', ?, ?, 210000)`
    ).bind('a'.repeat(32), 'b'.repeat(64)).run();
    const env = { DB: db } as never;

    const expiredToken = await createSession(env, 'teacher');
    await db.prepare(
      "UPDATE teacher_sessions SET expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"
    ).run();
    assert.equal(await resolveSession(env, expiredToken), null);

    const activeToken = await createSession(env, 'teacher');
    assert.deepEqual(await resolveSession(env, activeToken), {
      username: 'teacher',
      displayName: 'Teacher',
    });
    const sessions = await db.prepare('SELECT token_hash FROM teacher_sessions').all();
    assert.equal(sessions.results.length, 1);
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

test('a winning prompt response stays bound to its own revision after a later save', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-prompt-readback-race-'));
  try {
    const db = new SqliteD1(join(directory, 'prompt.sqlite'));
    db.applySchema(readFileSync('schema.sql', 'utf8'));
    const directEnv = { DB: db } as never;
    let injectedLaterSave = false;
    const interleavingEnv = {
      DB: {
        prepare: (sql: string) => db.prepare(sql),
        batch: async (statements: Parameters<typeof db.batch>[0]) => {
          const results = await db.batch(statements);
          if (!injectedLaterSave) {
            injectedLaterSave = true;
            await setAmendment(
              directEnv,
              'second teacher amendment',
              'teacher-b',
              1,
              promptTrace('second save')
            );
          }
          return results;
        },
      },
    } as never;

    const first = await setAmendment(
      interleavingEnv,
      'first teacher amendment',
      'teacher-a',
      0,
      promptTrace('first save')
    );
    assert.equal(first.record.amendment, 'first teacher amendment');
    assert.equal(first.record.updatedBy, 'teacher-a');
    assert.equal(first.record.revision, 1);
    assert.equal(first.revision?.settingsRevision, 1);

    const current = await db.prepare(
      'SELECT amendment, revision FROM assistant_settings WHERE id = 1'
    ).first<{ amendment: string; revision: number }>();
    assert.deepEqual(current ? { ...current } : current, {
      amendment: 'second teacher amendment',
      revision: 2,
    });
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

test('prompt save rolls back rather than reusing a conflicting history revision', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-prompt-history-drift-'));
  try {
    const db = new SqliteD1(join(directory, 'prompt.sqlite'));
    db.applySchema(readFileSync('schema.sql', 'utf8'));
    await db.batch([
      db.prepare(
        `INSERT INTO assistant_prompt_revisions
          (settings_revision, amendment, change_note, base_prompt_version, base_prompt_hash,
           effective_prompt_hash, updated_by)
         VALUES (1, 'unrelated history', 'pre-existing drift', 'old', ?, ?, 'teacher-b')`
      ).bind('c'.repeat(64), 'd'.repeat(64)),
      db.prepare(
        "INSERT INTO guides (job_id, text, model) VALUES ('job-a', 'current guide', 'model')"
      ),
    ]);
    const env = { DB: db } as never;

    await assert.rejects(
      setAmendment(env, 'candidate', 'teacher-a', 0, promptTrace('must not reuse history')),
      /assistant prompt history is append-only/
    );
    const settings = await db
      .prepare('SELECT amendment, revision FROM assistant_settings WHERE id = 1')
      .first<{ amendment: string; revision: number }>();
    assert.deepEqual({ ...settings }, { amendment: '', revision: 0 });
    const history = await db
      .prepare('SELECT amendment, updated_by FROM assistant_prompt_revisions')
      .all<{ amendment: string; updated_by: string }>();
    assert.deepEqual(history.results.map((row) => ({ ...row })), [
      { amendment: 'unrelated history', updated_by: 'teacher-b' },
    ]);
    assert.equal((await db.prepare('SELECT job_id FROM guides').all()).results.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fresh prompt history cannot be updated, deleted, or replaced', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-prompt-immutable-'));
  try {
    const db = new SqliteD1(join(directory, 'prompt.sqlite'));
    db.applySchema(readFileSync('schema.sql', 'utf8'));
    const env = { DB: db } as never;
    await setAmendment(env, 'original amendment', 'teacher-a', 0, promptTrace('original'));

    await assert.rejects(
      db.prepare(
        `INSERT INTO assistant_prompt_revisions
           (settings_revision, amendment, change_note, base_prompt_version,
            base_prompt_hash, effective_prompt_hash, updated_by)
         VALUES (2, 'candidate', 'invalid trace', 'next', 'not-a-hash', ?, 'teacher-b')`
      ).bind('d'.repeat(64)).run(),
      /assistant prompt history row is invalid/
    );
    await assert.rejects(
      db.prepare("UPDATE assistant_prompt_revisions SET amendment = 'rewritten'").run(),
      /assistant prompt history is append-only/
    );
    await assert.rejects(
      db.prepare('DELETE FROM assistant_prompt_revisions').run(),
      /assistant prompt history is append-only/
    );
    await assert.rejects(
      db
        .prepare(
          `INSERT OR REPLACE INTO assistant_prompt_revisions
             (settings_revision, amendment, change_note, base_prompt_version,
              base_prompt_hash, effective_prompt_hash, updated_by)
           VALUES (1, 'rewritten', 'replace', 'other', ?, ?, 'teacher-b')`
        )
        .bind('c'.repeat(64), 'd'.repeat(64))
        .run(),
      /assistant prompt history is append-only/
    );

    const history = await db
      .prepare('SELECT settings_revision, amendment, updated_by FROM assistant_prompt_revisions')
      .all<{ settings_revision: number; amendment: string; updated_by: string }>();
    assert.deepEqual(history.results.map((row) => ({ ...row })), [
      { settings_revision: 1, amendment: 'original amendment', updated_by: 'teacher-a' },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Railway boot and numbered migration both make legacy prompt history immutable', async () => {
  for (const migration of ['railway', 'numbered'] as const) {
    const directory = mkdtempSync(join(tmpdir(), `stem-splitter-prompt-${migration}-`));
    try {
      const db = new SqliteD1(join(directory, 'prompt.sqlite'));
      db.applySchema(`${PROMPT_HISTORY_TABLE_SQL}
        INSERT INTO assistant_prompt_revisions
          (settings_revision, amendment, change_note, base_prompt_version,
           base_prompt_hash, effective_prompt_hash, updated_by)
        VALUES (1, 'legacy amendment', 'legacy', 'legacy', '${'a'.repeat(64)}',
                '${'b'.repeat(64)}', 'teacher-a');
      `);

      if (migration === 'railway') {
        db.applyNodeMigrations();
        db.applyNodeMigrations();
      } else {
        const sql = readFileSync('migrations/0013-prompt-history-immutable.sql', 'utf8');
        db.applySchema(sql);
        db.applySchema(sql);
      }

      await assert.rejects(
        db.prepare(
          `INSERT INTO assistant_prompt_revisions
             (settings_revision, amendment, change_note, base_prompt_version,
              base_prompt_hash, effective_prompt_hash, updated_by)
           VALUES (2, 'candidate', '', 'next', ?, ?, 'teacher-b')`
        ).bind('c'.repeat(64), 'd'.repeat(64)).run(),
        /assistant prompt history row is invalid/
      );
      await assert.rejects(
        db.prepare("UPDATE assistant_prompt_revisions SET amendment = 'rewritten'").run(),
        /assistant prompt history is append-only/
      );
      await assert.rejects(
        db.prepare('DELETE FROM assistant_prompt_revisions').run(),
        /assistant prompt history is append-only/
      );
      await assert.rejects(
        db
          .prepare(
            `INSERT OR REPLACE INTO assistant_prompt_revisions
               (settings_revision, amendment, change_note, base_prompt_version,
                base_prompt_hash, effective_prompt_hash, updated_by)
             VALUES (1, 'rewritten', 'replace', 'other', ?, ?, 'teacher-b')`
          )
          .bind('c'.repeat(64), 'd'.repeat(64))
          .run(),
        /assistant prompt history is append-only/
      );
      assert.equal(
        (
          await db
            .prepare(
              'SELECT id FROM assistant_prompt_revisions WHERE amendment = ? AND updated_by = ?'
            )
            .bind('legacy amendment', 'teacher-a')
            .all()
        ).results.length,
        1
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('prompt history pages expose every immutable revision without overlap', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-prompt-pages-'));
  try {
    const db = new SqliteD1(join(directory, 'prompt.sqlite'));
    db.applySchema(readFileSync('schema.sql', 'utf8'));
    const env = { DB: db } as never;
    for (let revision = 1; revision <= 43; revision += 1) {
      const result = await setAmendment(
        env,
        `amendment ${revision}`,
        'teacher-a',
        revision - 1,
        promptTrace(`revision ${revision}`)
      );
      assert.equal(result.changed, true);
      assert.equal(result.revision?.settingsRevision, revision);
    }

    const newest = await getPromptHistoryPage(env);
    assert.equal(newest.revisions.length, 40);
    assert.equal(newest.hasMore, true);
    assert.deepEqual(
      [newest.revisions[0]?.settingsRevision, newest.revisions.at(-1)?.settingsRevision],
      [43, 4]
    );
    assert.equal(newest.nextBeforeId, newest.revisions.at(-1)?.id);

    const earlier = await getPromptHistoryPage(env, newest.nextBeforeId!);
    assert.equal(earlier.hasMore, false);
    assert.equal(earlier.nextBeforeId, null);
    assert.deepEqual(
      earlier.revisions.map((revision) => revision.settingsRevision),
      [3, 2, 1]
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a malformed teacher display name leaves the authoritative seed unchanged', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-teacher-seed-'));
  try {
    const db = new SqliteD1(join(directory, 'teacher.sqlite'));
    db.applySchema(readFileSync('schema.sql', 'utf8'));
    const record = {
      username: 'instructor',
      name: 'Original Teacher',
      salt: 'a'.repeat(32),
      hash: 'b'.repeat(64),
      iterations: 210_000,
    };
    const env = { DB: db, TEACHER_SEED: JSON.stringify([record]) };
    await syncTeachersFromSeed(env as never);

    env.TEACHER_SEED = JSON.stringify([
      { ...record, name: 'Uncommitted Rename' },
      {
        ...record,
        username: 'second-teacher',
        name: 42,
      },
    ]);
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      await syncTeachersFromSeed(env as never);
    } finally {
      console.error = originalConsoleError;
    }

    const teachers = await db
      .prepare('SELECT username, display_name FROM teachers ORDER BY username')
      .all<{ username: string; display_name: string }>();
    assert.deepEqual(teachers.results.map((row) => ({ ...row })), [
      { username: 'instructor', display_name: 'Original Teacher' },
    ]);
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

    const revisionZeroHash = await hashSystemPromptFingerprint();
    assert.equal(
      await cacheGuideIfPromptCurrent(env, guide('revision zero'), 0, revisionZeroHash),
      true
    );
    assert.equal((await getGuide(env, 'job-a'))?.text, 'revision zero');

    await setAmendment(env, 'new class direction', 'teacher-a', 0, promptTrace('revision one'));
    assert.equal(
      await cacheGuideIfPromptCurrent(env, guide('stale in-flight guide'), 0, revisionZeroHash),
      false
    );
    assert.equal(await getGuide(env, 'job-a'), null);

    const revisionOneHash = await hashSystemPromptFingerprint('new class direction');
    assert.equal(
      await cacheGuideIfPromptCurrent(env, guide('revision one'), 1, revisionOneHash),
      true
    );
    assert.equal((await getGuide(env, 'job-a'))?.text, 'revision one');
    const stored = await db
      .prepare('SELECT prompt_version, prompt_revision, prompt_hash FROM guides WHERE job_id = ?')
      .bind('job-a')
      .first<{ prompt_version: string; prompt_revision: number; prompt_hash: string }>();
    assert.deepEqual(
      { ...stored },
      {
        prompt_version: SYSTEM_PROMPT_VERSION,
        prompt_revision: 1,
        prompt_hash: revisionOneHash,
      }
    );

    await db
      .prepare('UPDATE guides SET prompt_hash = ? WHERE job_id = ?')
      .bind(revisionZeroHash, 'job-a')
      .run();
    assert.equal(await getGuide(env, 'job-a'), null);
    await db
      .prepare('UPDATE guides SET prompt_hash = ? WHERE job_id = ?')
      .bind(revisionOneHash, 'job-a')
      .run();
    await assert.rejects(
      db
        .prepare('UPDATE guides SET prompt_hash = ? WHERE job_id = ?')
        .bind('not-a-sha256', 'job-a')
        .run(),
      /CHECK constraint failed/
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
    assert.equal(columns.results.filter((column) => column.name === 'prompt_hash').length, 1);
    const legacy = await db
      .prepare('SELECT text, prompt_version, prompt_revision, prompt_hash FROM guides WHERE job_id = ?')
      .bind('legacy-job')
      .first<{
        text: string;
        prompt_version: string;
        prompt_revision: number;
        prompt_hash: string;
      }>();
    assert.deepEqual(
      { ...legacy },
      { text: 'old guide', prompt_version: '', prompt_revision: -1, prompt_hash: '' }
    );
    assert.equal(await getGuide({ DB: db } as never, 'legacy-job'), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('numbered guide-cache migrations invalidate legacy rows without deleting them', async () => {
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
    db.applySchema(readFileSync('migrations/0012-guide-prompt-hash.sql', 'utf8'));

    const legacy = await db
      .prepare('SELECT text, prompt_version, prompt_revision, prompt_hash FROM guides WHERE job_id = ?')
      .bind('legacy-job')
      .first<{
        text: string;
        prompt_version: string;
        prompt_revision: number;
        prompt_hash: string;
      }>();
    assert.deepEqual(
      { ...legacy },
      { text: 'old guide', prompt_version: '', prompt_revision: -1, prompt_hash: '' }
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
    for (const name of ['routing_request', 'source_type', 'source_hash', 'analysis']) {
      assert.equal(columns.results.filter((column) => column.name === name).length, 1, name);
    }
    const row = await db
      .prepare('SELECT model, routing_request, source_type, source_hash, analysis FROM jobs WHERE id = ?')
      .bind('legacy-job')
      .first<{
        model: string;
        routing_request: string | null;
        source_type: string | null;
        source_hash: string | null;
        analysis: string | null;
      }>();
    assert.deepEqual({ ...row }, {
      model: 'htdemucs_ft',
      routing_request: null,
      source_type: null,
      source_hash: null,
      analysis: null,
    });
    await db.prepare('UPDATE jobs SET source_hash = ? WHERE id = ?')
      .bind('a'.repeat(64), 'legacy-job')
      .run();
    await assert.rejects(
      db.prepare('UPDATE jobs SET source_hash = ? WHERE id = ?')
        .bind('b'.repeat(64), 'legacy-job')
        .run(),
      /jobs\.source_hash is immutable once set/
    );
    await assert.rejects(
      db.prepare('UPDATE jobs SET source_key = ? WHERE id = ?')
        .bind('uploads/rebound/song.wav', 'legacy-job')
        .run(),
      /jobs source locator is immutable once source_hash is set/
    );
    await assert.rejects(
      db.prepare('UPDATE jobs SET source_type = ? WHERE id = ?')
        .bind('upload', 'legacy-job')
        .run(),
      /jobs source locator is immutable once source_hash is set/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('numbered source-hash migrations preserve legacy jobs and make fingerprints write-once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-source-hash-migration-'));
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
        routing_request TEXT,
        source_type TEXT,
        analysis TEXT,
        labels TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO jobs (id, filename, source_key, status, model)
      VALUES ('legacy-job', 'song.wav', 'uploads/legacy/song.wav', 'done', 'htdemucs_ft');
    `);
    db.applySchema(readFileSync('migrations/0009-job-source-hash.sql', 'utf8'));
    db.applySchema(readFileSync('migrations/0011-job-source-hash-immutable.sql', 'utf8'));
    db.applySchema(readFileSync('migrations/0011-job-source-hash-immutable.sql', 'utf8'));

    const legacy = await db.prepare('SELECT source_hash FROM jobs WHERE id = ?')
      .bind('legacy-job')
      .first<{ source_hash: string | null }>();
    assert.equal(legacy?.source_hash, null);
    await db.prepare('UPDATE jobs SET source_hash = ? WHERE id = ?')
      .bind('a'.repeat(64), 'legacy-job')
      .run();
    assert.equal(
      (await db.prepare('SELECT source_hash FROM jobs WHERE id = ?')
        .bind('legacy-job')
        .first<{ source_hash: string }>())?.source_hash,
      'a'.repeat(64)
    );
    await db.prepare('UPDATE jobs SET source_hash = ? WHERE id = ?')
      .bind('a'.repeat(64), 'legacy-job')
      .run();
    await assert.rejects(
      db.prepare('UPDATE jobs SET source_hash = ? WHERE id = ?')
        .bind('b'.repeat(64), 'legacy-job')
        .run(),
      /jobs\.source_hash is immutable once set/
    );
    await assert.rejects(
      db.prepare('UPDATE jobs SET source_hash = NULL WHERE id = ?')
        .bind('legacy-job')
        .run(),
      /jobs\.source_hash is immutable once set/
    );
    await db.prepare('UPDATE jobs SET source_key = source_key, source_type = source_type WHERE id = ?')
      .bind('legacy-job')
      .run();
    await assert.rejects(
      db.prepare('UPDATE jobs SET source_key = ? WHERE id = ?')
        .bind('uploads/rebound/song.wav', 'legacy-job')
        .run(),
      /jobs source locator is immutable once source_hash is set/
    );
    await assert.rejects(
      db.prepare('UPDATE jobs SET source_type = ? WHERE id = ?')
        .bind('archive', 'legacy-job')
        .run(),
      /jobs source locator is immutable once source_hash is set/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const isolationIdentity = {
  provider: 'replicate',
  model: 'cjwbw/audiosep',
  version: 'f07004438b8f3e6c5b720ba889389007cbf8dbbc9caa124afc24d9bbd2d307b8',
  contractVersion: 'audiosep-replicate-v1',
};

const isolationBudget = {
  policyVersion: QUERY_ISOLATION_BUDGET_POLICY_VERSION,
  courseId: 'music-101',
  semesterId: '2026-fall',
  maximumProviderStarts: 20,
} as const;

function isolationClaimOptions(now?: Date) {
  return { budget: isolationBudget, now };
}

function storedIsolationOutput(
  isolationId: string,
  kind: 'target' | 'residual',
  createdAt = '2026-08-10T12:20:30.000Z'
): StoredQueryIsolationOutputV1 {
  return {
    isolationId,
    kind,
    storageKey: `isolations/${isolationId}/${kind}.wav`,
    sha256: (kind === 'target' ? 'c' : 'd').repeat(64),
    bytes: 48,
    contentType: 'audio/wav',
    createdAt,
    retainedUntil: new Date(
      Date.parse(createdAt) + 30 * 24 * 60 * 60 * 1000
    ).toISOString(),
  };
}

function isolationInput(id: string, target: string, hashCharacter = 'a') {
  return {
    id,
    jobId: 'job-a',
    requestedBy: 'teacher-a',
    sourceHash: hashCharacter.repeat(64),
    sourceType: 'upload' as const,
    normalizedTarget: target,
    analysisVocabularyVersion: 'classroom-instruments-v1',
    identity: isolationIdentity,
    rolloutStage: 'teacher_beta' as const,
    now: new Date('2026-08-10T12:00:00.000Z'),
  };
}

test('isolation lifecycle is bounded and cannot mutate a completed core split', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-isolation-resource-'));
  try {
    const db = new SqliteD1(join(directory, 'resource.sqlite'));
    db.applySchema(readFileSync('schema.sql', 'utf8'));
    const coreStems = JSON.stringify([
      { name: 'vocals', key: 'stems/job-a/vocals.mp3' },
      { name: 'drums', key: 'stems/job-a/drums.mp3' },
      { name: 'bass', key: 'stems/job-a/bass.mp3' },
      { name: 'other', key: 'stems/job-a/other.mp3' },
    ]);
    await db.prepare(
      `INSERT INTO jobs
        (id, filename, source_key, status, stems, model, source_type, source_hash)
       VALUES ('job-a', 'source.wav', 'uploads/job-a/source.wav', 'done', ?,
         'htdemucs_ft', 'upload', ?)`
    ).bind(coreStems, 'a'.repeat(64)).run();
    await db.batch([
      db.prepare(
        `INSERT INTO jobs
          (id, filename, source_key, status, model, source_type, source_hash)
         VALUES ('job-pending', 'pending.wav', 'uploads/pending/source.wav',
           'processing', 'htdemucs_ft', 'upload', '${'a'.repeat(64)}')`
      ),
      db.prepare(
        `INSERT INTO jobs
          (id, filename, source_key, status, model, source_type, source_hash)
         VALUES ('job-archive', 'archive.wav', 'uploads/archive/source.wav',
           'done', 'htdemucs_ft', 'archive', '${'a'.repeat(64)}')`
      ),
      db.prepare(
        `INSERT INTO jobs
          (id, filename, source_key, status, model, source_type, source_hash)
         VALUES ('job-shadow', 'shadow.wav', 'uploads/shadow/source.wav',
           'done', 'htdemucs_ft', 'upload', '${'a'.repeat(64)}')`
      ),
      db.prepare(
        `INSERT INTO jobs (id, filename, source_key, status, model, source_type)
         VALUES ('job-unhashed', 'unhashed.wav', 'uploads/unhashed/source.wav',
           'done', 'htdemucs_ft', 'upload')`
      ),
    ]);
    const env = { DB: db } as never;

    await assert.rejects(
      createInstrumentIsolation(env, {
        ...isolationInput('isolation_pending', 'saxophone'),
        jobId: 'job-pending',
      }),
      (error: unknown) =>
        error instanceof InstrumentIsolationResourceError && error.code === 'core_split_incomplete'
    );
    await assert.rejects(
      createInstrumentIsolation(env, {
        ...isolationInput('isolation_wrong_source', 'saxophone'),
        jobId: 'job-archive',
      }),
      (error: unknown) =>
        error instanceof InstrumentIsolationResourceError && error.code === 'source_type_mismatch'
    );
    await assert.rejects(
      createInstrumentIsolation(env, {
        ...isolationInput('isolation_missing_job', 'saxophone'),
        jobId: 'job-missing',
      }),
      (error: unknown) =>
        error instanceof InstrumentIsolationResourceError && error.code === 'job_not_found'
    );
    await assert.rejects(
      createInstrumentIsolation(env, {
        ...isolationInput('isolation_unhashed', 'saxophone'),
        jobId: 'job-unhashed',
      }),
      (error: unknown) =>
        error instanceof InstrumentIsolationResourceError &&
        error.code === 'source_identity_mismatch'
    );
    await assert.rejects(
      createInstrumentIsolation(
        env,
        isolationInput('isolation_wrong_hash', 'saxophone', 'b')
      ),
      (error: unknown) =>
        error instanceof InstrumentIsolationResourceError &&
        error.code === 'source_identity_mismatch'
    );

    const shadow = await createInstrumentIsolation(env, {
      ...isolationInput('isolation_shadow', 'bass clarinet'),
      jobId: 'job-shadow',
      rolloutStage: undefined,
    });
    assert.equal(shadow.record.rolloutStage, 'shadow');
    assert.equal(summarizeInstrumentIsolation(shadow.record).status, 'shadowed');
    await assert.rejects(
      claimInstrumentIsolation(env, shadow.record.id, isolationClaimOptions()),
      (error: unknown) =>
        error instanceof InstrumentIsolationResourceError && error.code === 'invalid_transition'
    );
    assert.equal((await getInstrumentIsolation(env, shadow.record.id))?.attempts, 0);
    assert.equal(
      (
        await db.prepare(
          'SELECT COUNT(*) AS count FROM instrument_isolation_budget_reservations'
        ).first<{ count: number }>()
      )?.count,
      0,
      'shadow demand must never reserve paid-provider budget'
    );

    const first = await createInstrumentIsolation(env, isolationInput('isolation_one', 'saxophone'));
    assert.equal(first.created, true);
    assert.equal(first.record.status, 'queued');
    assert.match(first.record.cacheKey, /^query-isolation\/v1\/[0-9a-f]{64}$/);

    const duplicate = await createInstrumentIsolation(
      env,
      isolationInput('isolation_duplicate_transport', 'saxophone')
    );
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.record.id, 'isolation_one');

    const second = await createInstrumentIsolation(env, isolationInput('isolation_two', 'trumpet'));
    assert.equal(second.created, true);
    await assert.rejects(
      createInstrumentIsolation(env, isolationInput('isolation_three', 'violin')),
      (error: unknown) =>
        error instanceof InstrumentIsolationResourceError && error.code === 'maximum_reached'
    );

    const claimed = await claimInstrumentIsolation(
      env,
      first.record.id,
      isolationClaimOptions(new Date('2026-08-10T12:01:00.000Z'))
    );
    assert.equal(claimed.status, 'processing');
    assert.equal(claimed.attempts, 1);
    assert.equal(claimed.deadlineAt, '2026-08-10T12:16:00.000Z');
    await attachInstrumentIsolationExternalId(
      env,
      first.record.id,
      'prediction_1',
      new Date('2026-08-10T12:01:01.000Z')
    );
    await assert.rejects(
      claimInstrumentIsolation(env, second.record.id, isolationClaimOptions()),
      (error: unknown) =>
        error instanceof InstrumentIsolationResourceError && error.code === 'invalid_transition'
    );

    const failed = await failInstrumentIsolation(
      env,
      first.record.id,
      { code: 'provider_failed', retryable: true },
      new Date('2026-08-10T12:02:00.000Z')
    );
    assert.deepEqual(failed.failure, { code: 'provider_failed', retryable: true });
    const coreAfterFailure = await db.prepare(
      'SELECT status, stems, model FROM jobs WHERE id = ?'
    ).bind('job-a').first<{ status: string; stems: string; model: string }>();
    assert.deepEqual(
      { ...coreAfterFailure },
      { status: 'done', stems: coreStems, model: 'htdemucs_ft' }
    );

    await requeueInstrumentIsolation(
      env,
      first.record.id,
      new Date('2026-08-10T12:03:00.000Z')
    );
    await claimInstrumentIsolation(
      env,
      first.record.id,
      isolationClaimOptions(new Date('2026-08-10T12:04:00.000Z'))
    );
    assert.equal(
      await expireTimedOutInstrumentIsolations(
        env,
        new Date('2026-08-10T12:19:00.001Z')
      ),
      1
    );
    await assert.rejects(
      requeueInstrumentIsolation(env, first.record.id),
      (error: unknown) =>
        error instanceof InstrumentIsolationResourceError && error.code === 'invalid_transition'
    );

    await claimInstrumentIsolation(
      env,
      second.record.id,
      isolationClaimOptions(new Date('2026-08-10T12:20:00.000Z'))
    );
    await attachInstrumentIsolationExternalId(
      env,
      second.record.id,
      'prediction_2',
      new Date('2026-08-10T12:20:01.000Z')
    );
    const ingestionLease = await claimInstrumentIsolationIngestion(
      env,
      second.record.id,
      'prediction_2',
      {
        leaseId: 'ingestion_2',
        now: new Date('2026-08-10T12:20:02.000Z'),
      }
    );
    await assert.rejects(
      completeInstrumentIsolationIngestion(
        env,
        ingestionLease,
        {
          target: {
            ...storedIsolationOutput(second.record.id, 'target'),
            storageKey: 'stems/job-a/other.mp3',
          },
        },
        new Date('2026-08-10T12:20:30.000Z')
      ),
      (error: unknown) =>
        /Invalid stored isolation output identity/.test(String(error))
    );
    const completed = await completeInstrumentIsolationIngestion(
      env,
      ingestionLease,
      { target: storedIsolationOutput(second.record.id, 'target') },
      new Date('2026-08-10T12:21:00.000Z')
    );
    const summary = summarizeInstrumentIsolation(completed);
    assert.equal(summary.kind, 'optional_instrument_isolation');
    assert.deepEqual(summary.output, { targetAvailable: true, residualAvailable: false });
    assert.deepEqual(await getInstrumentIsolationBudgetUsage(env, isolationBudget), {
      ...isolationBudget,
      reservedProviderStarts: 3,
      remainingProviderStarts: 17,
    });
    assert.equal(summary.limitations.length, 2);
    assert.deepEqual(
      (await listInstrumentIsolations(env, 'job-a')).map((record) => record.id).sort(),
      ['isolation_one', 'isolation_two']
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an idempotent isolation read fails closed on job or cache-material drift', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-isolation-legacy-mismatch-'));
  try {
    const db = new SqliteD1(join(directory, 'legacy-mismatch.sqlite'));
    db.applySchema(readFileSync('schema.sql', 'utf8'));
    await db.prepare(
      `INSERT INTO jobs
        (id, filename, source_key, status, model, source_type, source_hash)
       VALUES ('job-a', 'source.wav', 'uploads/job-a/source.wav', 'done',
         'htdemucs_ft', 'upload', '${'a'.repeat(64)}')`
    ).run();
    const mismatched = isolationInput('legacy-mismatch', 'saxophone', 'b');
    const cacheKey = await queryIsolationCacheKeyForMaterial(mismatched, isolationIdentity);
    await db.prepare(
      `INSERT INTO instrument_isolations
        (id, job_id, requested_by, source_hash, source_type, normalized_target,
         analysis_vocabulary_version, provider, provider_model, provider_version,
         provider_contract_version, cache_key, rollout_stage, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      mismatched.id,
      mismatched.jobId,
      mismatched.requestedBy,
      mismatched.sourceHash,
      mismatched.sourceType,
      mismatched.normalizedTarget,
      mismatched.analysisVocabularyVersion,
      isolationIdentity.provider,
      isolationIdentity.model,
      isolationIdentity.version,
      isolationIdentity.contractVersion,
      cacheKey,
      mismatched.rolloutStage,
      'queued'
    ).run();

    await assert.rejects(
      createInstrumentIsolation({ DB: db } as never, mismatched),
      (error: unknown) =>
        error instanceof InstrumentIsolationResourceError &&
        error.code === 'source_identity_mismatch'
    );

    await db.prepare(
      `INSERT INTO jobs
        (id, filename, source_key, status, model, source_type, source_hash)
       VALUES ('job-b', 'source.wav', 'uploads/job-b/source.wav', 'done',
         'htdemucs_ft', 'upload', '${'a'.repeat(64)}')`
    ).run();
    const expected = {
      ...isolationInput('legacy-cache-drift', 'trumpet'),
      jobId: 'job-b',
    };
    const expectedCacheKey = await queryIsolationCacheKeyForMaterial(expected, isolationIdentity);
    await db.prepare(
      `INSERT INTO instrument_isolations
        (id, job_id, requested_by, source_hash, source_type, normalized_target,
         analysis_vocabulary_version, provider, provider_model, provider_version,
         provider_contract_version, cache_key, rollout_stage, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      expected.id,
      expected.jobId,
      expected.requestedBy,
      'b'.repeat(64),
      expected.sourceType,
      expected.normalizedTarget,
      expected.analysisVocabularyVersion,
      isolationIdentity.provider,
      isolationIdentity.model,
      isolationIdentity.version,
      isolationIdentity.contractVersion,
      expectedCacheKey,
      expected.rolloutStage,
      'queued'
    ).run();
    await assert.rejects(
      createInstrumentIsolation({ DB: db } as never, expected),
      (error: unknown) =>
        error instanceof InstrumentIsolationResourceError &&
        error.code === 'cache_identity_mismatch'
    );
    await db.prepare(
      `UPDATE instrument_isolations
       SET source_hash = ?, rollout_stage = 'shadow'
       WHERE id = ?`
    ).bind(expected.sourceHash, expected.id).run();
    await assert.rejects(
      createInstrumentIsolation({ DB: db } as never, expected),
      (error: unknown) =>
        error instanceof InstrumentIsolationResourceError &&
        error.code === 'cache_identity_mismatch'
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('course-semester isolation budget reservations are atomic and fail closed on drift', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-isolation-budget-'));
  try {
    const db = new SqliteD1(join(directory, 'budget.sqlite'));
    db.applySchema(readFileSync('schema.sql', 'utf8'));
    for (const id of ['job-a', 'job-b']) {
      await db.prepare(
        `INSERT INTO jobs
          (id, filename, source_key, status, model, source_type, source_hash)
         VALUES (?, 'source.wav', ?, 'done', 'htdemucs_ft', 'upload', ?)`
      )
        .bind(id, `uploads/${id}/source.wav`, 'a'.repeat(64))
        .run();
    }
    const env = { DB: db } as never;
    const first = await createInstrumentIsolation(
      env,
      isolationInput('budget_one', 'saxophone')
    );
    const second = await createInstrumentIsolation(env, {
      ...isolationInput('budget_two', 'trumpet'),
      jobId: 'job-b',
    });
    await assert.rejects(
      claimInstrumentIsolation(env, first.record.id, undefined as never),
      (error: unknown) =>
        error instanceof InstrumentIsolationResourceError &&
        error.code === 'invalid_request' &&
        /budget is required/.test(error.message)
    );
    assert.equal((await getInstrumentIsolation(env, first.record.id))?.attempts, 0);
    const oneStartBudget = { ...isolationBudget, maximumProviderStarts: 1 };
    const contenders = await Promise.allSettled([
      claimInstrumentIsolation(env, first.record.id, {
        budget: oneStartBudget,
        now: new Date('2026-08-10T13:00:00.000Z'),
      }),
      claimInstrumentIsolation(env, second.record.id, {
        budget: oneStartBudget,
        now: new Date('2026-08-10T13:00:00.000Z'),
      }),
    ]);
    assert.equal(contenders.filter(({ status }) => status === 'fulfilled').length, 1);
    const rejected = contenders.find(({ status }) => status === 'rejected');
    assert.ok(
      rejected?.status === 'rejected' &&
        rejected.reason instanceof InstrumentIsolationResourceError &&
        rejected.reason.code === 'budget_exhausted'
    );
    assert.deepEqual(await getInstrumentIsolationBudgetUsage(env, oneStartBudget), {
      ...oneStartBudget,
      reservedProviderStarts: 1,
      remainingProviderStarts: 0,
    });
    const reservations = await db.prepare(
      `SELECT isolation_id, attempt_number, job_id, cache_key, requested_by,
         course_id, semester_id
       FROM instrument_isolation_budget_reservations`
    ).all<{
      isolation_id: string;
      attempt_number: number;
      job_id: string;
      cache_key: string;
      requested_by: string;
      course_id: string;
      semester_id: string;
    }>();
    assert.equal(reservations.results.length, 1);
    assert.equal(reservations.results[0].attempt_number, 1);
    assert.match(reservations.results[0].cache_key, /^query-isolation\/v1\/[0-9a-f]{64}$/);
    assert.equal(reservations.results[0].requested_by, 'teacher-a');
    assert.equal(reservations.results[0].course_id, 'music-101');
    assert.equal(reservations.results[0].semester_id, '2026-fall');
    await assert.rejects(
      db.prepare(
        'UPDATE instrument_isolation_budget_reservations SET maximum_provider_starts = 2'
      ).run(),
      /budget reservations are immutable/
    );
    await assert.rejects(
      db.prepare('DELETE FROM instrument_isolation_budget_reservations').run(),
      /budget reservations are immutable/
    );

    const queuedId = contenders[0].status === 'rejected' ? first.record.id : second.record.id;
    assert.equal((await getInstrumentIsolation(env, queuedId))?.attempts, 0);
    await db.prepare('DELETE FROM jobs WHERE id = ?')
      .bind(reservations.results[0].job_id)
      .run();
    assert.deepEqual(await getInstrumentIsolationBudgetUsage(env, oneStartBudget), {
      ...oneStartBudget,
      reservedProviderStarts: 1,
      remainingProviderStarts: 0,
    });
    await assert.rejects(
      claimInstrumentIsolation(env, queuedId, {
        budget: { ...oneStartBudget, maximumProviderStarts: 2 },
      }),
      (error: unknown) =>
        error instanceof InstrumentIsolationResourceError &&
        error.code === 'budget_policy_mismatch'
    );

    const nextSemester = { ...oneStartBudget, semesterId: '2027-spring' };
    const nextClaim = await claimInstrumentIsolation(env, queuedId, {
      budget: nextSemester,
      now: new Date('2027-01-10T13:00:00.000Z'),
    });
    assert.equal(nextClaim.status, 'processing');
    assert.deepEqual(await getInstrumentIsolationBudgetUsage(env, nextSemester), {
      ...nextSemester,
      reservedProviderStarts: 1,
      remainingProviderStarts: 0,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('concurrent isolation creation cannot exceed the per-track maximum', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-isolation-limit-'));
  try {
    const db = new SqliteD1(join(directory, 'limit.sqlite'));
    db.applySchema(readFileSync('schema.sql', 'utf8'));
    await db.prepare(
      `INSERT INTO jobs
        (id, filename, source_key, status, model, source_type, source_hash)
       VALUES ('job-a', 'source.wav', 'uploads/job-a/source.wav', 'done',
         'htdemucs_ft', 'upload', '${'a'.repeat(64)}')`
    ).run();
    const env = { DB: db } as never;
    await createInstrumentIsolation(env, isolationInput('isolation_one', 'saxophone'));

    const contenders = await Promise.allSettled([
      createInstrumentIsolation(env, isolationInput('isolation_two', 'trumpet')),
      createInstrumentIsolation(env, isolationInput('isolation_three', 'violin')),
    ]);
    assert.equal(contenders.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(contenders.filter((result) => result.status === 'rejected').length, 1);
    assert.equal((await listInstrumentIsolations(env, 'job-a')).length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Railway boot and numbered migration both add isolation storage idempotently', async () => {
  for (const migration of ['node', 'numbered'] as const) {
    const directory = mkdtempSync(join(tmpdir(), `stem-splitter-isolation-${migration}-`));
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
        INSERT INTO jobs (id, filename, source_key, status, model)
        VALUES ('legacy-job', 'song.wav', 'uploads/legacy/song.wav', 'done', 'htdemucs_ft');
      `);
      if (migration === 'node') {
        db.applyNodeMigrations();
        db.applyNodeMigrations();
      } else {
        const createSql = readFileSync('migrations/0008-instrument-isolations.sql', 'utf8');
        db.applySchema(createSql);
        db.applySchema(createSql);
        await db.prepare(
          `INSERT INTO instrument_isolations
            (id, job_id, requested_by, source_hash, source_type, normalized_target,
             provider, provider_model, provider_version, provider_contract_version, cache_key)
           VALUES ('legacy-isolation', 'legacy-job', 'legacy-teacher', ?, 'upload',
             'saxophone', 'replicate', 'cjwbw/audiosep', ?,
             'audiosep-replicate-v1', ?)`
        )
          .bind(
            'a'.repeat(64),
            isolationIdentity.version,
            `query-isolation/v1/${'b'.repeat(64)}`
          )
          .run();
        db.applySchema(readFileSync('migrations/0010-isolation-rollout-stage.sql', 'utf8'));
        const budgetSql = readFileSync(
          'migrations/0015-instrument-isolation-budget.sql',
          'utf8'
        );
        db.applySchema(budgetSql);
        db.applySchema(budgetSql);
        const ingestionSql = readFileSync(
          'migrations/0016-instrument-isolation-output-ingestion.sql',
          'utf8'
        );
        db.applySchema(ingestionSql);
        db.applySchema(ingestionSql);
      }

      const columns = await db.prepare("PRAGMA table_info('instrument_isolations')")
        .all<{ name: string; dflt_value: string | null }>();
      for (const name of [
        'job_id',
        'source_hash',
        'normalized_target',
        'provider_version',
        'cache_key',
        'rollout_stage',
        'status',
        'attempts',
        'deadline_at',
      ]) {
        assert.equal(columns.results.filter((column) => column.name === name).length, 1, name);
      }
      assert.equal(
        columns.results.find((column) => column.name === 'rollout_stage')?.dflt_value,
        "'shadow'"
      );
      if (migration === 'numbered') {
        assert.equal(
          (
            await db.prepare(
              "SELECT rollout_stage FROM instrument_isolations WHERE id = 'legacy-isolation'"
            ).first<{ rollout_stage: string }>()
          )?.rollout_stage,
          'shadow'
        );
      }
      const indexes = await db.prepare("PRAGMA index_list('instrument_isolations')")
        .all<{ name: string }>();
      assert.ok(
        indexes.results.some(
          (index) => index.name === 'idx_instrument_isolations_one_processing_per_job'
        )
      );
      const budgetTable = await db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'instrument_isolation_budget_reservations'"
      ).first<{ name: string }>();
      assert.equal(budgetTable?.name, 'instrument_isolation_budget_reservations');
      const budgetIndexes = await db.prepare(
        "PRAGMA index_list('instrument_isolation_budget_reservations')"
      ).all<{ name: string }>();
      assert.ok(
        budgetIndexes.results.some(
          (index) => index.name === 'idx_instrument_isolation_budget_scope'
        )
      );
      const budgetTriggers = await db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'instrument_isolation_budget_reservations_%' ORDER BY name"
      ).all<{ name: string }>();
      assert.deepEqual(budgetTriggers.results.map(({ name }) => name), [
        'instrument_isolation_budget_reservations_no_delete',
        'instrument_isolation_budget_reservations_no_update',
      ]);
      const ingestionTable = await db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'instrument_isolation_ingestion_leases'"
      ).first<{ name: string }>();
      assert.equal(ingestionTable?.name, 'instrument_isolation_ingestion_leases');
      const ingestionIndexes = await db.prepare(
        "PRAGMA index_list('instrument_isolation_ingestion_leases')"
      ).all<{ name: string }>();
      assert.ok(
        ingestionIndexes.results.some(
          (index) => index.name === 'idx_instrument_isolation_ingestion_deadline'
        )
      );
      const outputTable = await db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'instrument_isolation_outputs'"
      ).first<{ name: string }>();
      assert.equal(outputTable?.name, 'instrument_isolation_outputs');
      const outputIndexes = await db.prepare(
        "PRAGMA index_list('instrument_isolation_outputs')"
      ).all<{ name: string }>();
      assert.ok(
        outputIndexes.results.some(
          (index) => index.name === 'idx_instrument_isolation_outputs_retention'
        )
      );
      const outputTriggers = await db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'instrument_isolation_outputs_%' ORDER BY name"
      ).all<{ name: string }>();
      assert.deepEqual(outputTriggers.results.map(({ name }) => name), [
        'instrument_isolation_outputs_no_replace',
        'instrument_isolation_outputs_no_update',
      ]);
      await db.prepare(
        `INSERT INTO instrument_isolations
          (id, job_id, requested_by, source_hash, source_type, normalized_target,
           provider, provider_model, provider_version, provider_contract_version, cache_key)
         VALUES ('migration-output', 'legacy-job', 'teacher-a', ?, 'upload',
           'saxophone', 'replicate', 'cjwbw/audiosep', ?,
           'audiosep-replicate-v1', ?)`
      )
        .bind(
          'a'.repeat(64),
          isolationIdentity.version,
          `query-isolation/v1/${'e'.repeat(64)}`
        )
        .run();
      await db.prepare(
        `INSERT INTO instrument_isolation_outputs
          (isolation_id, kind, storage_key, sha256, bytes, content_type,
           retained_until, created_at)
         VALUES ('migration-output', 'target',
           'isolations/migration-output/target.wav', ?, 48, 'audio/wav',
           '2026-09-09T12:00:00.000Z', '2026-08-10T12:00:00.000Z')`
      ).bind('f'.repeat(64)).run();
      await assert.rejects(
        db.prepare(
          `UPDATE instrument_isolation_outputs SET bytes = 50
           WHERE isolation_id = 'migration-output'`
        ).run(),
        /instrument isolation output identity is immutable/
      );
      await assert.rejects(
        db.prepare(
          `INSERT OR REPLACE INTO instrument_isolation_outputs
            (isolation_id, kind, storage_key, sha256, bytes, content_type,
             retained_until, created_at)
           VALUES ('migration-output', 'target',
             'isolations/migration-output/target.wav', ?, 48, 'audio/wav',
             '2026-09-09T12:00:00.000Z', '2026-08-10T12:00:00.000Z')`
        ).bind('f'.repeat(64)).run(),
        /instrument isolation output identity is immutable/
      );
      await db.prepare("DELETE FROM instrument_isolations WHERE id = 'migration-output'").run();
      assert.equal(
        (
          await db.prepare(
            "SELECT COUNT(*) AS count FROM instrument_isolation_outputs WHERE isolation_id = 'migration-output'"
          ).first<{ count: number }>()
        )?.count,
        0
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
