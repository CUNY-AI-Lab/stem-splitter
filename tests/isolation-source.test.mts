import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Env } from '../src/env.ts';
import {
  discardQueryIsolationSpendSource,
  prepareQueryIsolationSpendSource,
  QueryIsolationSourceError,
} from '../src/isolation/source.ts';
import {
  isLocalSourceDownloadKey,
  verifyLocalSource,
} from '../src/r2.ts';
import { FsR2Bucket } from '../server/r2.ts';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SOURCE_KEY = 'uploads/browser-put/source.wav';
const ISOLATION_ID = 'isolation_spend_guard_1';
const ORIGINAL = new TextEncoder().encode('verified source bytes');
const REPLACEMENT = new TextEncoder().encode('different source bytes');

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

function testEnv(bucket: FsR2Bucket): Env {
  return {
    AUDIO: bucket,
    LOCAL_HOSTING: 'true',
    PUBLIC_BASE_URL: 'https://stem-splitter.test',
    WEBHOOK_SECRET: 'isolation-source-test-signing-secret',
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
  const directory = await mkdtemp(join(tmpdir(), 'stem-splitter-isolation-source-'));
  try {
    const bucket = new FsR2Bucket(directory);
    await run(bucket, testEnv(bucket));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('pre-spend source preparation gives the provider immutable verified bytes', async () => {
  await withBucket(async (bucket, env) => {
    const expectedSourceHash = await sha256Hex(ORIGINAL);
    await bucket.put(SOURCE_KEY, ORIGINAL, {
      httpMetadata: { contentType: 'audio/wav' },
    });

    const prepared = await prepareQueryIsolationSpendSource(env, {
      isolationId: ISOLATION_ID,
      sourceKey: SOURCE_KEY,
      expectedSourceHash,
    });

    assert.equal(
      prepared.snapshotKey,
      `isolation-inputs/v1/${ISOLATION_ID}/${expectedSourceHash}`
    );
    assert.equal(prepared.sourceHash, expectedSourceHash);
    assert.equal(prepared.bytes, ORIGINAL.byteLength);
    assert.equal(prepared.replacedExistingSnapshot, false);
    assert.equal(isLocalSourceDownloadKey(prepared.snapshotKey), true);
    assert.equal(prepared.snapshotKey.startsWith('uploads/'), false);
    assert.deepEqual(await storedBytes(bucket, prepared.snapshotKey), ORIGINAL);

    const url = new URL(prepared.sourceUrl);
    const expires = url.searchParams.get('expires');
    const signature = url.searchParams.get('signature');
    const nowSeconds = Math.floor(Date.now() / 1000);
    assert.equal(
      await verifyLocalSource(
        env,
        prepared.snapshotKey,
        expires ?? undefined,
        signature ?? undefined,
        nowSeconds
      ),
      true
    );
    assert.ok(Number(expires) > nowSeconds);
    assert.ok(Number(expires) <= nowSeconds + 15 * 60 + 1);
    assert.equal(
      await verifyLocalSource(
        env,
        prepared.snapshotKey,
        expires ?? undefined,
        signature ?? undefined,
        Number(expires) + 1
      ),
      false,
      'a provider URL must fail after its explicit deadline'
    );

    // A valid browser PUT can still replace the original object, but the URL
    // returned above addresses the isolated copy and retains the verified bytes.
    await bucket.put(SOURCE_KEY, REPLACEMENT, {
      httpMetadata: { contentType: 'audio/wav' },
    });
    assert.deepEqual(await storedBytes(bucket, prepared.snapshotKey), ORIGINAL);
  });
});

test('pre-spend source preparation rejects replacement, deletion, and retention expiry', async () => {
  await withBucket(async (bucket, env) => {
    const expectedSourceHash = await sha256Hex(ORIGINAL);
    await bucket.put(SOURCE_KEY, ORIGINAL);
    await bucket.put(SOURCE_KEY, REPLACEMENT);

    await assert.rejects(
      prepareQueryIsolationSpendSource(env, {
        isolationId: ISOLATION_ID,
        sourceKey: SOURCE_KEY,
        expectedSourceHash,
      }),
      (error) =>
        error instanceof QueryIsolationSourceError &&
        error.code === 'source_identity_mismatch'
    );
    assert.equal(
      await bucket.head(`isolation-inputs/v1/${ISOLATION_ID}/${expectedSourceHash}`),
      null
    );

    await bucket.delete(SOURCE_KEY);
    await assert.rejects(
      prepareQueryIsolationSpendSource(env, {
        isolationId: ISOLATION_ID,
        sourceKey: SOURCE_KEY,
        expectedSourceHash,
      }),
      (error) =>
        error instanceof QueryIsolationSourceError && error.code === 'source_unavailable'
    );

    await bucket.put(SOURCE_KEY, ORIGINAL);
    const stored = await bucket.head(SOURCE_KEY);
    assert.ok(stored);
    await assert.rejects(
      prepareQueryIsolationSpendSource(env, {
        isolationId: ISOLATION_ID,
        sourceKey: SOURCE_KEY,
        expectedSourceHash,
        nowMs: stored.uploaded.getTime() + RETENTION_MS + 1,
      }),
      (error) =>
        error instanceof QueryIsolationSourceError && error.code === 'source_unavailable'
    );
    assert.equal(await bucket.head(SOURCE_KEY), null, 'expired local audio is deleted on access');
  });
});

test('pre-spend source preparation bounds a body that exceeds stored metadata', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(ORIGINAL);
      controller.enqueue(new Uint8Array([0]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const env = {
    AUDIO: {
      async get() {
        return {
          size: ORIGINAL.byteLength,
          uploaded: new Date(),
          httpMetadata: { contentType: 'audio/wav' },
          body,
        };
      },
    },
    LOCAL_HOSTING: 'true',
    PUBLIC_BASE_URL: 'https://stem-splitter.test',
    WEBHOOK_SECRET: 'isolation-source-test-signing-secret',
  } as unknown as Env;

  await assert.rejects(
    prepareQueryIsolationSpendSource(env, {
      isolationId: ISOLATION_ID,
      sourceKey: SOURCE_KEY,
      expectedSourceHash: await sha256Hex(ORIGINAL),
    }),
    (error) =>
      error instanceof QueryIsolationSourceError &&
      error.code === 'source_unavailable' &&
      /recorded size/.test(error.message)
  );
  assert.equal(cancelled, true);
});

test('same-digest retries are safe and snapshot cleanup is narrowly scoped', async () => {
  await withBucket(async (bucket, env) => {
    const expectedSourceHash = await sha256Hex(ORIGINAL);
    await bucket.put(SOURCE_KEY, ORIGINAL);
    const first = await prepareQueryIsolationSpendSource(env, {
      isolationId: ISOLATION_ID,
      sourceKey: SOURCE_KEY,
      expectedSourceHash,
    });

    // Simulate reuse of a still-valid upload locator with byte-identical data.
    await bucket.put(SOURCE_KEY, ORIGINAL);
    const retry = await prepareQueryIsolationSpendSource(env, {
      isolationId: ISOLATION_ID,
      sourceKey: SOURCE_KEY,
      expectedSourceHash,
    });
    assert.equal(retry.snapshotKey, first.snapshotKey);
    assert.equal(retry.replacedExistingSnapshot, true);
    assert.deepEqual(await storedBytes(bucket, retry.snapshotKey), ORIGINAL);

    await assert.rejects(
      discardQueryIsolationSpendSource(env, SOURCE_KEY),
      (error) =>
        error instanceof QueryIsolationSourceError && error.code === 'invalid_request'
    );
    assert.deepEqual(await storedBytes(bucket, SOURCE_KEY), ORIGINAL);

    await discardQueryIsolationSpendSource(env, retry.snapshotKey);
    assert.equal(await bucket.head(retry.snapshotKey), null);
    assert.deepEqual(await storedBytes(bucket, SOURCE_KEY), ORIGINAL);
  });
});

test('isolation preparation accepts an app-owned authoritative Auto source', async () => {
  await withBucket(async (bucket, env) => {
    const autoSourceKey = 'auto-inputs/v1/auto_job_isolation_compat';
    const expectedSourceHash = await sha256Hex(ORIGINAL);
    await bucket.put(autoSourceKey, ORIGINAL, {
      httpMetadata: { contentType: 'audio/wav' },
    });

    const prepared = await prepareQueryIsolationSpendSource(env, {
      isolationId: 'isolation_from_auto_job',
      sourceKey: autoSourceKey,
      expectedSourceHash,
    });
    assert.equal(prepared.sourceHash, expectedSourceHash);
    assert.deepEqual(await storedBytes(bucket, prepared.snapshotKey), ORIGINAL);
  });
});
