import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SqliteD1 } from '../server/d1.ts';
import { FsR2Bucket } from '../server/r2.ts';
import { QUERY_ISOLATION_BUDGET_POLICY_VERSION } from '../src/isolation/budget.ts';
import {
  claimInstrumentIsolationIngestion,
  releaseInstrumentIsolationIngestion,
} from '../src/isolation/ingestion.ts';
import { getInstrumentIsolationOutputs } from '../src/isolation/ingestion.ts';
import {
  attachInstrumentIsolationExternalId,
  claimInstrumentIsolation,
  createInstrumentIsolation,
  expireTimedOutInstrumentIsolations,
  failInstrumentIsolation,
  getInstrumentIsolation,
  getInstrumentIsolationBudgetUsage,
  InstrumentIsolationResourceError,
} from '../src/isolation/resource.ts';
import {
  ingestQueryIsolationProviderResult,
  QueryIsolationTerminalIngestionError,
} from '../src/isolation/terminal.ts';
import { QUERY_ISOLATION_SCHEMA_VERSION } from '../src/isolation/types.ts';

const PROVIDER_VERSION = 'f07004438b8f3e6c5b720ba889389007cbf8dbbc9caa124afc24d9bbd2d307b8';
const BUDGET = {
  policyVersion: QUERY_ISOLATION_BUDGET_POLICY_VERSION,
  courseId: 'music-101',
  semesterId: '2026-fall',
  maximumProviderStarts: 10,
} as const;
const OUTPUT_URL = 'https://pbxt.replicate.delivery/result/separated_audio.wav';

function wavBytes(samples = new Int16Array([100, -100, 200, -200])): Uint8Array {
  const dataBytes = samples.byteLength;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 32_000, true);
  view.setUint32(28, 64_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataBytes, true);
  bytes.set(new Uint8Array(samples.buffer), 44);
  return bytes;
}

async function setupIsolation(label: string) {
  const directory = mkdtempSync(join(tmpdir(), `stem-splitter-terminal-${label}-`));
  const db = new SqliteD1(join(directory, 'terminal.sqlite'));
  db.applySchema(readFileSync('schema.sql', 'utf8'));
  const bucket = new FsR2Bucket(join(directory, 'audio'));
  const jobId = `job_${label}`;
  const isolationId = `isolation_${label}`;
  const externalId = `prediction_${label}`;
  const sourceHash = 'a'.repeat(64);
  const coreStems = JSON.stringify([
    { name: 'vocals', key: `stems/${jobId}/vocals.mp3` },
    { name: 'drums', key: `stems/${jobId}/drums.mp3` },
    { name: 'bass', key: `stems/${jobId}/bass.mp3` },
    { name: 'other', key: `stems/${jobId}/other.mp3` },
  ]);
  await db.prepare(
    `INSERT INTO jobs
      (id, filename, source_key, status, stems, model, source_type, source_hash)
     VALUES (?, 'source.wav', ?, 'done', ?, 'htdemucs_ft', 'upload', ?)`
  )
    .bind(jobId, `uploads/${jobId}/source.wav`, coreStems, sourceHash)
    .run();
  const env = { DB: db, AUDIO: bucket } as never;
  const created = await createInstrumentIsolation(env, {
    id: isolationId,
    jobId,
    requestedBy: 'teacher-a',
    sourceHash,
    sourceType: 'upload',
    normalizedTarget: 'saxophone',
    analysisVocabularyVersion: 'classroom-instruments-v1',
    identity: {
      provider: 'replicate',
      model: 'cjwbw/audiosep',
      version: PROVIDER_VERSION,
      contractVersion: 'audiosep-replicate-v1',
    },
    rolloutStage: 'teacher_beta',
    now: new Date('2026-08-10T12:00:00.000Z'),
  });
  await claimInstrumentIsolation(env, isolationId, {
    budget: BUDGET,
    now: new Date('2026-08-10T12:01:00.000Z'),
  });
  await attachInstrumentIsolationExternalId(
    env,
    isolationId,
    externalId,
    new Date('2026-08-10T12:01:01.000Z')
  );
  const snapshotKey = `isolation-inputs/v1/${isolationId}/${sourceHash}`;
  await bucket.put(snapshotKey, new TextEncoder().encode('verified provider input'));
  return {
    directory,
    db,
    bucket,
    env,
    jobId,
    isolationId,
    externalId,
    snapshotKey,
    coreStems,
    record: created.record,
  };
}

test('one terminal observer hydrates exact output while a concurrent observer is rejected', async () => {
  const fixture = await setupIsolation('concurrent');
  try {
    let fetchCalls = 0;
    let announceFetch = () => {};
    let releaseFetch = () => {};
    const fetchStarted = new Promise<void>((resolve) => {
      announceFetch = resolve;
    });
    const fetchRelease = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchImpl = (async () => {
      fetchCalls += 1;
      announceFetch();
      await fetchRelease;
      return new Response(wavBytes(), { headers: { 'Content-Type': 'audio/wav' } });
    }) as typeof fetch;
    const result = {
      schemaVersion: QUERY_ISOLATION_SCHEMA_VERSION,
      status: 'succeeded' as const,
      targetUrl: OUTPUT_URL,
    };
    const first = ingestQueryIsolationProviderResult(
      fixture.env,
      fixture.isolationId,
      fixture.externalId,
      result,
      { fetchImpl, now: new Date('2026-08-10T12:02:00.000Z') }
    );
    await fetchStarted;
    await assert.rejects(
      ingestQueryIsolationProviderResult(
        fixture.env,
        fixture.isolationId,
        fixture.externalId,
        result,
        { fetchImpl, now: new Date('2026-08-10T12:02:01.000Z') }
      ),
      (error: unknown) =>
        error instanceof InstrumentIsolationResourceError && error.code === 'ingestion_busy'
    );
    releaseFetch();
    const outcome = await first;
    assert.equal(outcome.ingested, true);
    assert.equal(outcome.record.status, 'succeeded');
    assert.equal(outcome.record.targetKey, `isolations/${fixture.isolationId}/target.wav`);
    assert.equal(outcome.sourceCleanupPending, false);
    assert.equal(fetchCalls, 1);
    assert.equal(await fixture.bucket.head(fixture.snapshotKey), null);
    assert.ok(await fixture.bucket.head(outcome.record.targetKey!));
    const outputs = await getInstrumentIsolationOutputs(fixture.env, fixture.isolationId);
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].storageKey, outcome.record.targetKey);
    assert.equal(outputs[0].bytes, wavBytes().byteLength);
    assert.equal(
      (await fixture.db.prepare(
        'SELECT isolation_id FROM instrument_isolation_ingestion_leases'
      ).all()).results.length,
      0
    );
    const core = await fixture.db.prepare(
      'SELECT status, stems, model FROM jobs WHERE id = ?'
    )
      .bind(fixture.jobId)
      .first<{ status: string; stems: string; model: string }>();
    assert.deepEqual({ ...core }, {
      status: 'done',
      stems: fixture.coreStems,
      model: 'htdemucs_ft',
    });

    const replay = await ingestQueryIsolationProviderResult(
      fixture.env,
      fixture.isolationId,
      fixture.externalId,
      result,
      {
        fetchImpl: (async () => {
          throw new Error('terminal replay must not fetch');
        }) as typeof fetch,
      }
    );
    assert.equal(replay.ingested, false);
    assert.equal(replay.record.status, 'succeeded');
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('transient output failure releases ingestion without spending another provider start', async () => {
  const fixture = await setupIsolation('transient');
  try {
    let calls = 0;
    await assert.rejects(
      ingestQueryIsolationProviderResult(
        fixture.env,
        fixture.isolationId,
        fixture.externalId,
        {
          schemaVersion: QUERY_ISOLATION_SCHEMA_VERSION,
          status: 'succeeded',
          targetUrl: OUTPUT_URL,
        },
        {
          fetchImpl: (async () => {
            calls += 1;
            return new Response(null, { status: 503 });
          }) as typeof fetch,
          now: new Date('2026-08-10T12:02:00.000Z'),
        }
      ),
      (error: unknown) =>
        error instanceof QueryIsolationTerminalIngestionError && error.retryable
    );
    assert.equal(calls, 3);
    assert.equal((await getInstrumentIsolation(fixture.env, fixture.isolationId))?.status, 'processing');
    const released = await fixture.db.prepare(
      `SELECT attempts, lease_id, lease_expires_at
       FROM instrument_isolation_ingestion_leases WHERE isolation_id = ?`
    )
      .bind(fixture.isolationId)
      .first<{ attempts: number; lease_id: string | null; lease_expires_at: string | null }>();
    assert.deepEqual({ ...released }, { attempts: 1, lease_id: null, lease_expires_at: null });
    assert.ok(await fixture.bucket.head(fixture.snapshotKey));
    assert.deepEqual(await getInstrumentIsolationBudgetUsage(fixture.env, BUDGET), {
      ...BUDGET,
      reservedProviderStarts: 1,
      remainingProviderStarts: 9,
    });

    const recovered = await ingestQueryIsolationProviderResult(
      fixture.env,
      fixture.isolationId,
      fixture.externalId,
      {
        schemaVersion: QUERY_ISOLATION_SCHEMA_VERSION,
        status: 'succeeded',
        targetUrl: OUTPUT_URL,
      },
      {
        fetchImpl: (async () =>
          new Response(wavBytes(), { headers: { 'Content-Type': 'audio/wav' } })) as typeof fetch,
        now: new Date('2026-08-10T12:03:00.000Z'),
      }
    );
    assert.equal(recovered.record.status, 'succeeded');
    assert.deepEqual(await getInstrumentIsolationBudgetUsage(fixture.env, BUDGET), {
      ...BUDGET,
      reservedProviderStarts: 1,
      remainingProviderStarts: 9,
    });
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('database finalization failure rolls back metadata, removes output, and releases the lease', async () => {
  const fixture = await setupIsolation('db-rollback');
  try {
    fixture.db.applySchema(`
      CREATE TRIGGER reject_isolation_completion
      BEFORE UPDATE ON instrument_isolations
      WHEN NEW.id = '${fixture.isolationId}' AND NEW.status = 'succeeded'
      BEGIN
        SELECT RAISE(ABORT, 'private database failure detail');
      END;
    `);
    await assert.rejects(
      ingestQueryIsolationProviderResult(
        fixture.env,
        fixture.isolationId,
        fixture.externalId,
        {
          schemaVersion: QUERY_ISOLATION_SCHEMA_VERSION,
          status: 'succeeded',
          targetUrl: OUTPUT_URL,
        },
        {
          fetchImpl: (async () =>
            new Response(wavBytes(), { headers: { 'Content-Type': 'audio/wav' } })) as typeof fetch,
          now: new Date('2026-08-10T12:02:00.000Z'),
        }
      ),
      (error: unknown) =>
        error instanceof QueryIsolationTerminalIngestionError &&
        error.retryable &&
        !error.message.includes('private database failure detail')
    );
    assert.equal((await getInstrumentIsolation(fixture.env, fixture.isolationId))?.status, 'processing');
    assert.equal((await getInstrumentIsolationOutputs(fixture.env, fixture.isolationId)).length, 0);
    assert.equal(
      await fixture.bucket.head(`isolations/${fixture.isolationId}/target.wav`),
      null
    );
    const released = await fixture.db.prepare(
      `SELECT lease_id, lease_expires_at
       FROM instrument_isolation_ingestion_leases WHERE isolation_id = ?`
    )
      .bind(fixture.isolationId)
      .first<{ lease_id: string | null; lease_expires_at: string | null }>();
    assert.deepEqual({ ...released }, { lease_id: null, lease_expires_at: null });
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('invalid terminal audio fails locally, removes the input snapshot, and preserves core stems', async () => {
  const fixture = await setupIsolation('invalid');
  try {
    const outcome = await ingestQueryIsolationProviderResult(
      fixture.env,
      fixture.isolationId,
      fixture.externalId,
      {
        schemaVersion: QUERY_ISOLATION_SCHEMA_VERSION,
        status: 'succeeded',
        targetUrl: OUTPUT_URL,
      },
      {
        fetchImpl: (async () =>
          new Response(new TextEncoder().encode('<html>not wav</html>'), {
            headers: { 'Content-Type': 'audio/wav' },
          })) as typeof fetch,
        now: new Date('2026-08-10T12:02:00.000Z'),
      }
    );
    assert.equal(outcome.record.status, 'failed');
    assert.deepEqual(outcome.record.failure, {
      code: 'output_ingestion_failed',
      retryable: false,
    });
    assert.equal(await fixture.bucket.head(fixture.snapshotKey), null);
    assert.equal(
      (await fixture.bucket.list({ prefix: `isolations/${fixture.isolationId}/` })).objects.length,
      0
    );
    const core = await fixture.db.prepare('SELECT stems FROM jobs WHERE id = ?')
      .bind(fixture.jobId)
      .first<{ stems: string }>();
    assert.equal(core?.stems, fixture.coreStems);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('terminal replay retries a failed source-snapshot cleanup without refetching output', async () => {
  const fixture = await setupIsolation('cleanup-replay');
  try {
    const originalDelete = fixture.bucket.delete.bind(fixture.bucket);
    let cleanupAttempts = 0;
    fixture.bucket.delete = async (key: string | string[]) => {
      if (key === fixture.snapshotKey && cleanupAttempts++ === 0) {
        throw new Error('simulated cleanup outage');
      }
      return originalDelete(key);
    };
    const result = {
      schemaVersion: QUERY_ISOLATION_SCHEMA_VERSION,
      status: 'succeeded' as const,
      targetUrl: OUTPUT_URL,
    };
    const first = await ingestQueryIsolationProviderResult(
      fixture.env,
      fixture.isolationId,
      fixture.externalId,
      result,
      {
        fetchImpl: (async () =>
          new Response(wavBytes(), { headers: { 'Content-Type': 'audio/wav' } })) as typeof fetch,
      }
    );
    assert.equal(first.record.status, 'succeeded');
    assert.equal(first.sourceCleanupPending, true);
    assert.ok(await fixture.bucket.head(fixture.snapshotKey));

    const replay = await ingestQueryIsolationProviderResult(
      fixture.env,
      fixture.isolationId,
      fixture.externalId,
      result,
      {
        fetchImpl: (async () => {
          throw new Error('terminal replay must not fetch output');
        }) as typeof fetch,
      }
    );
    assert.equal(replay.ingested, false);
    assert.equal(replay.sourceCleanupPending, false);
    assert.equal(await fixture.bucket.head(fixture.snapshotKey), null);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('provider identity mismatch fails before output fetch or storage', async () => {
  const fixture = await setupIsolation('identity-mismatch');
  try {
    let fetchCalls = 0;
    await assert.rejects(
      ingestQueryIsolationProviderResult(
        fixture.env,
        fixture.isolationId,
        'prediction_other',
        {
          schemaVersion: QUERY_ISOLATION_SCHEMA_VERSION,
          status: 'succeeded',
          targetUrl: OUTPUT_URL,
        },
        {
          fetchImpl: (async () => {
            fetchCalls += 1;
            return new Response(wavBytes());
          }) as typeof fetch,
        }
      ),
      (error: unknown) =>
        error instanceof InstrumentIsolationResourceError &&
        error.code === 'provider_identity_mismatch'
    );
    assert.equal(fetchCalls, 0);
    assert.equal(
      (await fixture.bucket.list({ prefix: `isolations/${fixture.isolationId}/` })).objects.length,
      0
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('terminal result validation rejects empty fields that are present in non-success states', async () => {
  const fixture = await setupIsolation('terminal-shape');
  try {
    for (const result of [
      {
        schemaVersion: QUERY_ISOLATION_SCHEMA_VERSION,
        status: 'processing',
        targetUrl: '',
      },
      {
        schemaVersion: QUERY_ISOLATION_SCHEMA_VERSION,
        status: 'failed',
        targetUrl: '',
        failure: { code: 'provider_failed', retryable: true },
      },
      {
        schemaVersion: QUERY_ISOLATION_SCHEMA_VERSION,
        status: 'failed',
        failure: { code: 'output_ingestion_failed', retryable: false },
      },
    ]) {
      await assert.rejects(
        ingestQueryIsolationProviderResult(
          fixture.env,
          fixture.isolationId,
          fixture.externalId,
          result as never
        ),
        (error: unknown) =>
          error instanceof InstrumentIsolationResourceError && error.code === 'invalid_request'
      );
    }
    assert.equal((await getInstrumentIsolation(fixture.env, fixture.isolationId))?.status, 'processing');
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('an active ingestion lease blocks generic failure and timeout transitions', async () => {
  const fixture = await setupIsolation('transition-race');
  try {
    const lease = await claimInstrumentIsolationIngestion(
      fixture.env,
      fixture.isolationId,
      fixture.externalId,
      { leaseId: 'lease_active', now: new Date('2026-08-10T12:15:59.000Z') }
    );
    await assert.rejects(
      failInstrumentIsolation(
        fixture.env,
        fixture.isolationId,
        { code: 'provider_failed', retryable: true },
        new Date('2026-08-10T12:16:00.000Z')
      ),
      (error: unknown) =>
        error instanceof InstrumentIsolationResourceError && error.code === 'invalid_transition'
    );
    assert.equal(
      await expireTimedOutInstrumentIsolations(
        fixture.env,
        new Date('2026-08-10T12:16:00.001Z')
      ),
      0
    );
    assert.equal((await getInstrumentIsolation(fixture.env, fixture.isolationId))?.status, 'processing');
    await releaseInstrumentIsolationIngestion(
      fixture.env,
      lease,
      new Date('2026-08-10T12:16:01.000Z')
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('ingestion leases are exclusive, reclaimable, and bounded to three attempts', async () => {
  const fixture = await setupIsolation('lease');
  try {
    const first = await claimInstrumentIsolationIngestion(
      fixture.env,
      fixture.isolationId,
      fixture.externalId,
      { leaseId: 'lease_one', now: new Date('2026-08-10T12:02:00.000Z') }
    );
    assert.equal(first.attempts, 1);
    await assert.rejects(
      claimInstrumentIsolationIngestion(
        fixture.env,
        fixture.isolationId,
        fixture.externalId,
        { leaseId: 'lease_blocked', now: new Date('2026-08-10T12:02:01.000Z') }
      ),
      (error: unknown) =>
        error instanceof InstrumentIsolationResourceError && error.code === 'ingestion_busy'
    );

    const second = await claimInstrumentIsolationIngestion(
      fixture.env,
      fixture.isolationId,
      fixture.externalId,
      { leaseId: 'lease_two', now: new Date('2026-08-10T12:07:00.001Z') }
    );
    assert.equal(second.attempts, 2);
    await releaseInstrumentIsolationIngestion(
      fixture.env,
      second,
      new Date('2026-08-10T12:07:01.000Z')
    );
    const third = await claimInstrumentIsolationIngestion(
      fixture.env,
      fixture.isolationId,
      fixture.externalId,
      { leaseId: 'lease_three', now: new Date('2026-08-10T12:07:02.000Z') }
    );
    assert.equal(third.attempts, 3);
    await releaseInstrumentIsolationIngestion(
      fixture.env,
      third,
      new Date('2026-08-10T12:07:03.000Z')
    );
    let fetchCalls = 0;
    const exhausted = await ingestQueryIsolationProviderResult(
      fixture.env,
      fixture.isolationId,
      fixture.externalId,
      {
        schemaVersion: QUERY_ISOLATION_SCHEMA_VERSION,
        status: 'succeeded',
        targetUrl: OUTPUT_URL,
      },
      {
        now: new Date('2026-08-10T12:07:04.000Z'),
        fetchImpl: (async () => {
          fetchCalls += 1;
          return new Response(wavBytes());
        }) as typeof fetch,
      }
    );
    assert.equal(fetchCalls, 0);
    assert.equal(exhausted.record.status, 'failed');
    assert.deepEqual(exhausted.record.failure, {
      code: 'output_ingestion_failed',
      retryable: false,
    });
    assert.equal(exhausted.sourceCleanupPending, false);
    assert.equal(await fixture.bucket.head(fixture.snapshotKey), null);
    assert.equal(
      (await fixture.db.prepare(
        'SELECT isolation_id FROM instrument_isolation_ingestion_leases'
      ).all()).results.length,
      0
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
