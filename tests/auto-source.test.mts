import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FsR2Bucket } from '../server/r2.ts';
import {
  AuthoritativeAutoSourceError,
  discardAuthoritativeAutoSource,
  prepareAuthoritativeAutoSource,
} from '../src/analysis/source.ts';
import {
  AUDIO_ANALYSIS_SOURCE_SCOPE_VERSION,
  scopedAudioAnalysisSourceFromLocalPath,
} from '../src/analysis/source-scope.ts';
import type { Env } from '../src/env.ts';
import {
  isLocalSourceDownloadKey,
  presignAnalysisDownload,
} from '../src/r2.ts';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SOURCE_KEY = 'uploads/authoritative-auto/source.wav';
const ORIGINAL = new TextEncoder().encode('original browser upload');
const REPLACEMENT = new TextEncoder().encode('replacement browser upload');

function testEnv(bucket: FsR2Bucket): Env {
  return {
    AUDIO: bucket,
    LOCAL_HOSTING: 'true',
    PUBLIC_BASE_URL: 'https://stem-splitter.test',
    WEBHOOK_SECRET: 'authoritative-auto-source-test-secret',
  } as unknown as Env;
}

async function storedBytes(bucket: FsR2Bucket, key: string): Promise<Uint8Array | null> {
  const object = await bucket.get(key);
  return object
    ? new Uint8Array(await new Response(object.body).arrayBuffer())
    : null;
}

async function withBucket(
  run: (bucket: FsR2Bucket, env: Env) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'stem-splitter-auto-source-'));
  try {
    const bucket = new FsR2Bucket(directory);
    await run(bucket, testEnv(bucket));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('authoritative Auto snapshots one upload for both analysis and separation', async () => {
  await withBucket(async (bucket, env) => {
    await bucket.put(SOURCE_KEY, ORIGINAL, {
      httpMetadata: { contentType: 'audio/wav' },
    });
    const prepared = await prepareAuthoritativeAutoSource(env, {
      jobId: 'auto_job_1',
      sourceKey: SOURCE_KEY,
    });

    assert.equal(prepared.snapshotKey, 'auto-inputs/v1/auto_job_1');
    assert.equal(prepared.bytes, ORIGINAL.byteLength);
    assert.equal(isLocalSourceDownloadKey(prepared.snapshotKey), true);
    assert.equal(prepared.snapshotKey.startsWith('uploads/'), false);
    assert.deepEqual(await storedBytes(bucket, prepared.snapshotKey), ORIGINAL);

    const analysisUrl = new URL(await presignAnalysisDownload(env, prepared.snapshotKey));
    assert.deepEqual(scopedAudioAnalysisSourceFromLocalPath(analysisUrl.pathname), {
      key: prepared.snapshotKey,
      scope: 'authoritative_auto_snapshot',
    });
    assert.equal(AUDIO_ANALYSIS_SOURCE_SCOPE_VERSION, 'analysis-source-scope-v2');

    await bucket.put(SOURCE_KEY, REPLACEMENT, {
      httpMetadata: { contentType: 'audio/wav' },
    });
    assert.deepEqual(await storedBytes(bucket, SOURCE_KEY), REPLACEMENT);
    assert.deepEqual(
      await storedBytes(bucket, prepared.snapshotKey),
      ORIGINAL,
      'a later browser PUT cannot replace the app-owned snapshot'
    );

    await bucket.put(SOURCE_KEY, ORIGINAL);
    assert.deepEqual(
      await storedBytes(bucket, prepared.snapshotKey),
      ORIGINAL,
      'a byte-identical retry also leaves the snapshot unchanged'
    );
  });
});

test('analysis signing rejects outputs and query-isolation snapshots', async () => {
  await withBucket(async (_bucket, env) => {
    for (const key of [
      'stems/job_1/vocals.mp3',
      `isolation-inputs/v1/isolation_1/${'1'.repeat(64)}`,
      'isolations/isolation_1/target.wav',
      'uploads/too/many/source.wav',
    ]) {
      await assert.rejects(presignAnalysisDownload(env, key), /Invalid analysis source key/);
    }
  });
});

test('analysis source paths preserve canonical filenames without accepting encoded path tricks', () => {
  assert.deepEqual(
    scopedAudioAnalysisSourceFromLocalPath(
      '/api/local-sources/uploads/source_1/My%20Song.wav'
    ),
    {
      key: 'uploads/source_1/My Song.wav',
      scope: 'stored_source',
    }
  );

  for (const pathname of [
    '/api/local-sources/uploads/source_1/%73ource.wav',
    '/api/local-sources/uploads/source_1/source%2Fname.wav',
    '/api/local-sources/uploads/source_1/%ZZ.wav',
    '/api/local-sources/uploads/source_1/source.wav/extra',
  ]) {
    assert.equal(scopedAudioAnalysisSourceFromLocalPath(pathname), null);
  }
});

test('a replacement before snapshotting becomes one frozen, internally consistent version', async () => {
  await withBucket(async (bucket, env) => {
    await bucket.put(SOURCE_KEY, ORIGINAL);
    await bucket.put(SOURCE_KEY, REPLACEMENT);

    const prepared = await prepareAuthoritativeAutoSource(env, {
      jobId: 'auto_job_before_analysis',
      sourceKey: SOURCE_KEY,
    });
    assert.equal(prepared.bytes, REPLACEMENT.byteLength);
    assert.deepEqual(await storedBytes(bucket, prepared.snapshotKey), REPLACEMENT);
  });
});

test('a concurrent Railway PUT cannot splice two upload versions into the snapshot', async () => {
  await withBucket(async (bucket, env) => {
    await bucket.put(SOURCE_KEY, ORIGINAL);

    let firstChunkWritten = () => {};
    const firstChunk = new Promise<void>((resolve) => {
      firstChunkWritten = resolve;
    });
    let releaseWrite = () => {};
    const released = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let stage = 0;
    const concurrentBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (stage === 0) {
          stage = 1;
          controller.enqueue(REPLACEMENT.slice(0, 5));
          firstChunkWritten();
          return;
        }
        if (stage === 1) {
          stage = 2;
          await released;
          controller.enqueue(REPLACEMENT.slice(5));
          controller.close();
        }
      },
    });

    const replacementPut = bucket.put(SOURCE_KEY, concurrentBody);
    await firstChunk;
    const prepared = await prepareAuthoritativeAutoSource(env, {
      jobId: 'auto_job_concurrent_put',
      sourceKey: SOURCE_KEY,
    });
    releaseWrite();
    await replacementPut;

    assert.deepEqual(
      await storedBytes(bucket, prepared.snapshotKey),
      ORIGINAL,
      'the prior complete object remains visible until a streamed PUT commits'
    );
    assert.deepEqual(await storedBytes(bucket, SOURCE_KEY), REPLACEMENT);
  });
});

test('snapshot collision, retention expiry, and cleanup fail closed', async () => {
  await withBucket(async (bucket, env) => {
    await bucket.put(SOURCE_KEY, ORIGINAL);
    const prepared = await prepareAuthoritativeAutoSource(env, {
      jobId: 'auto_job_collision',
      sourceKey: SOURCE_KEY,
    });
    await assert.rejects(
      prepareAuthoritativeAutoSource(env, {
        jobId: 'auto_job_collision',
        sourceKey: SOURCE_KEY,
      }),
      (error) =>
        error instanceof AuthoritativeAutoSourceError &&
        error.code === 'snapshot_conflict'
    );

    await assert.rejects(
      discardAuthoritativeAutoSource(env, SOURCE_KEY),
      (error) =>
        error instanceof AuthoritativeAutoSourceError &&
        error.code === 'invalid_request'
    );
    await discardAuthoritativeAutoSource(env, prepared.snapshotKey);
    assert.equal(await bucket.head(prepared.snapshotKey), null);
    assert.deepEqual(await storedBytes(bucket, SOURCE_KEY), ORIGINAL);

    const stored = await bucket.head(SOURCE_KEY);
    assert.ok(stored);
    await assert.rejects(
      prepareAuthoritativeAutoSource(env, {
        jobId: 'auto_job_expired',
        sourceKey: SOURCE_KEY,
        nowMs: stored.uploaded.getTime() + RETENTION_MS + 1,
      }),
      (error) =>
        error instanceof AuthoritativeAutoSourceError &&
        error.code === 'source_unavailable'
    );
    assert.equal(await bucket.head(SOURCE_KEY), null);
  });
});

test('snapshot copy streams the full 100 MiB boundary without an app buffer', async () => {
  const chunkBytes = 1024 * 1024;
  const chunkCount = 100;
  const totalBytes = chunkBytes * chunkCount;
  let sourcePulls = 0;
  let storedBytes = 0;
  let committed = false;
  const sourceBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sourcePulls === chunkCount) {
        controller.close();
        return;
      }
      sourcePulls += 1;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
  });
  const env = {
    AUDIO: {
      async get(key: string) {
        assert.equal(key, SOURCE_KEY);
        return {
          size: totalBytes,
          uploaded: new Date(),
          httpMetadata: { contentType: 'audio/wav' },
          body: sourceBody,
        };
      },
      async head(key: string) {
        if (key === SOURCE_KEY) return null;
        return committed ? { size: storedBytes } : null;
      },
      async put(key: string, body: unknown) {
        assert.equal(key, 'auto-inputs/v1/auto_job_streaming');
        assert.ok(body instanceof ReadableStream, 'snapshot storage receives a stream');
        const reader = body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          storedBytes += value.byteLength;
        }
        committed = true;
        return { size: storedBytes };
      },
      async delete() {
        committed = false;
      },
    },
    LOCAL_HOSTING: 'false',
  } as unknown as Env;

  const prepared = await prepareAuthoritativeAutoSource(env, {
    jobId: 'auto_job_streaming',
    sourceKey: SOURCE_KEY,
  });
  assert.equal(prepared.bytes, totalBytes);
  assert.equal(storedBytes, totalBytes);
  assert.equal(sourcePulls, chunkCount);
});

test('a failed snapshot write rolls back its app-owned key', async () => {
  const deleted: string[] = [];
  const env = {
    AUDIO: {
      async get() {
        return {
          size: ORIGINAL.byteLength,
          uploaded: new Date(),
          httpMetadata: { contentType: 'audio/wav' },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(ORIGINAL);
              controller.close();
            },
          }),
        };
      },
      async head() {
        return null;
      },
      async put(_key: string, body: unknown) {
        assert.ok(body instanceof ReadableStream);
        await body.getReader().read();
        throw new Error('simulated storage failure');
      },
      async delete(key: string) {
        deleted.push(key);
      },
    },
    LOCAL_HOSTING: 'false',
  } as unknown as Env;

  await assert.rejects(
    prepareAuthoritativeAutoSource(env, {
      jobId: 'auto_job_rollback',
      sourceKey: SOURCE_KEY,
    }),
    (error) =>
      error instanceof AuthoritativeAutoSourceError &&
      error.code === 'snapshot_failed'
  );
  assert.deepEqual(deleted, ['auto-inputs/v1/auto_job_rollback']);
});
