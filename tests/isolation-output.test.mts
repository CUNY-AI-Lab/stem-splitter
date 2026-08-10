import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FsR2Bucket } from '../server/r2.ts';
import {
  discardQueryIsolationOutput,
  hydrateQueryIsolationOutput,
  isSupportedQueryIsolationWav,
  QueryIsolationOutputError,
  QUERY_ISOLATION_OUTPUT_RETENTION_MS,
  validateStoredQueryIsolationOutput,
  validatedQueryIsolationOutputUrl,
} from '../src/isolation/output.ts';

const ISOLATION_ID = 'isolation_output_1';
const OUTPUT_URL = 'https://pbxt.replicate.delivery/result/separated_audio.wav?token=opaque';

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

async function withBucket(
  run: (bucket: FsR2Bucket) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'stem-splitter-isolation-output-'));
  try {
    await run(new FsR2Bucket(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('isolation output hydration validates WAV bytes and stores exact identity', async () => {
  await withBucket(async (bucket) => {
    const audio = wavBytes();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(audio, {
        status: 200,
        headers: {
          'Content-Type': 'audio/wav; charset=binary',
          'Content-Length': String(audio.byteLength),
        },
      });
    }) as typeof fetch;

    const output = await hydrateQueryIsolationOutput(
      { AUDIO: bucket } as never,
      { isolationId: ISOLATION_ID, kind: 'target', outputUrl: OUTPUT_URL },
      { fetchImpl }
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, OUTPUT_URL);
    assert.equal(calls[0].init?.redirect, 'manual');
    assert.equal(output.storageKey, `isolations/${ISOLATION_ID}/target.wav`);
    assert.equal(output.bytes, audio.byteLength);
    assert.match(output.sha256, /^[0-9a-f]{64}$/);
    assert.equal(output.contentType, 'audio/wav');
    assert.equal(
      Date.parse(output.retainedUntil) - Date.parse(output.createdAt),
      QUERY_ISOLATION_OUTPUT_RETENTION_MS
    );
    assert.equal(validateStoredQueryIsolationOutput(output, ISOLATION_ID, 'target'), output);
    const noncanonicalCreatedAt = new Date(Date.parse(output.createdAt)).toUTCString();
    assert.throws(
      () =>
        validateStoredQueryIsolationOutput(
          {
            ...output,
            createdAt: noncanonicalCreatedAt,
            retainedUntil: new Date(
              Date.parse(noncanonicalCreatedAt) + QUERY_ISOLATION_OUTPUT_RETENTION_MS
            ).toISOString(),
          },
          ISOLATION_ID,
          'target'
        ),
      (error: unknown) =>
        error instanceof QueryIsolationOutputError && error.code === 'invalid_request'
    );
    const stored = await bucket.get(output.storageKey);
    assert.ok(stored);
    assert.equal(stored.httpMetadata.contentType, 'audio/wav');
    assert.deepEqual(
      new Uint8Array(await new Response(stored.body).arrayBuffer()),
      audio
    );
  });
});

test('isolation output URL and redirect policy fail before unsafe bytes are read', async () => {
  for (const url of [
    'http://pbxt.replicate.delivery/result.wav',
    'https://user:pass@pbxt.replicate.delivery/result.wav',
    'https://pbxt.replicate.delivery:8443/result.wav',
    'https://attacker.example/result.wav',
    'https://replicate.delivery.evil.example/result.wav',
    'https://pbxt.replicate.delivery/result.wav#fragment',
  ]) {
    assert.throws(
      () => validatedQueryIsolationOutputUrl(url),
      (error: unknown) =>
        error instanceof QueryIsolationOutputError && error.code === 'unsafe_output_url'
    );
  }

  let canceled = false;
  const fetchImpl = (async () =>
    new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
      { status: 302, headers: { Location: 'https://attacker.example/result.wav' } }
    )) as typeof fetch;
  await assert.rejects(
    hydrateQueryIsolationOutput(
      { AUDIO: {} } as never,
      { isolationId: ISOLATION_ID, kind: 'target', outputUrl: OUTPUT_URL },
      { fetchImpl }
    ),
    (error: unknown) =>
      error instanceof QueryIsolationOutputError && error.code === 'unsafe_output_url'
  );
  assert.equal(canceled, true);
});

test('isolation output rejects mislabeled, malformed, truncated, and empty WAV data', async () => {
  const valid = wavBytes();
  const malformed = [
    new TextEncoder().encode('<html>not audio</html>'),
    valid.slice(0, 43),
    (() => {
      const changed = valid.slice();
      changed.set(new TextEncoder().encode('AVI '), 8);
      return changed;
    })(),
    (() => {
      const changed = valid.slice();
      new DataView(changed.buffer).setUint32(40, 0, true);
      return changed;
    })(),
    (() => {
      const changed = valid.slice();
      new DataView(changed.buffer).setUint32(40, valid.byteLength, true);
      return changed;
    })(),
    (() => {
      const changed = new Uint8Array(valid.byteLength + 1);
      changed.set(valid);
      changed[changed.byteLength - 1] = 1;
      return changed;
    })(),
    (() => {
      const changed = valid.slice();
      new DataView(changed.buffer).setUint16(32, 4, true);
      return changed;
    })(),
  ];
  for (const audio of malformed) assert.equal(isSupportedQueryIsolationWav(audio.buffer), false);

  await assert.rejects(
    hydrateQueryIsolationOutput(
      { AUDIO: {} } as never,
      { isolationId: ISOLATION_ID, kind: 'target', outputUrl: OUTPUT_URL },
      {
        fetchImpl: (async () =>
          new Response(valid, { headers: { 'Content-Type': 'text/html' } })) as typeof fetch,
      }
    ),
    (error: unknown) =>
      error instanceof QueryIsolationOutputError && error.code === 'invalid_output_audio'
  );
});

test('isolation output enforces declared and streamed byte ceilings', async () => {
  const audio = wavBytes();
  let declaredCanceled = false;
  await assert.rejects(
    hydrateQueryIsolationOutput(
      { AUDIO: {} } as never,
      { isolationId: ISOLATION_ID, kind: 'target', outputUrl: OUTPUT_URL },
      {
        maximumBytes: 44,
        maximumAttempts: 1,
        fetchImpl: (async () =>
          new Response(
            new ReadableStream({
              cancel() {
                declaredCanceled = true;
              },
            }),
            { headers: { 'Content-Length': String(audio.byteLength) } }
          )) as typeof fetch,
      }
    ),
    (error: unknown) =>
      error instanceof QueryIsolationOutputError && error.code === 'output_too_large'
  );
  assert.equal(declaredCanceled, true);

  let streamedCanceled = false;
  await assert.rejects(
    hydrateQueryIsolationOutput(
      { AUDIO: {} } as never,
      { isolationId: ISOLATION_ID, kind: 'target', outputUrl: OUTPUT_URL },
      {
        maximumBytes: 44,
        maximumAttempts: 1,
        fetchImpl: (async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(audio.slice(0, 30));
                controller.enqueue(audio.slice(30));
              },
              cancel() {
                streamedCanceled = true;
              },
            })
          )) as typeof fetch,
      }
    ),
    (error: unknown) =>
      error instanceof QueryIsolationOutputError && error.code === 'output_too_large'
  );
  assert.equal(streamedCanceled, true);
});

test('transient isolation output downloads retry within one bounded attempt set', async () => {
  await withBucket(async (bucket) => {
    let calls = 0;
    const output = await hydrateQueryIsolationOutput(
      { AUDIO: bucket } as never,
      { isolationId: ISOLATION_ID, kind: 'target', outputUrl: OUTPUT_URL },
      {
        fetchImpl: (async () => {
          calls += 1;
          return calls < 3
            ? new Response(null, { status: 503 })
            : new Response(wavBytes(), { headers: { 'Content-Type': 'audio/wav' } });
        }) as typeof fetch,
      }
    );
    assert.equal(calls, 3);
    assert.equal(output.kind, 'target');
  });
});

test('isolation output cancels a body that stalls beyond the shared deadline', async () => {
  let canceled = false;
  await assert.rejects(
    hydrateQueryIsolationOutput(
      { AUDIO: {} } as never,
      { isolationId: ISOLATION_ID, kind: 'target', outputUrl: OUTPUT_URL },
      {
        timeoutMs: 10,
        maximumAttempts: 1,
        fetchImpl: (async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                canceled = true;
              },
            }),
            { headers: { 'Content-Type': 'audio/wav' } }
          )) as typeof fetch,
      }
    ),
    (error: unknown) =>
      error instanceof QueryIsolationOutputError &&
      error.code === 'download_failed' &&
      error.retryable
  );
  assert.equal(canceled, true);
});

test('storage failures clean only a newly created isolation output key', async () => {
  const deleted: string[] = [];
  const audio = wavBytes();
  const bucket = {
    async head() {
      return null;
    },
    async put() {
      throw new Error('private storage detail');
    },
    async delete(key: string) {
      deleted.push(key);
    },
  };
  await assert.rejects(
    hydrateQueryIsolationOutput(
      { AUDIO: bucket } as never,
      { isolationId: ISOLATION_ID, kind: 'target', outputUrl: OUTPUT_URL },
      { fetchImpl: (async () => new Response(audio)) as typeof fetch }
    ),
    (error: unknown) =>
      error instanceof QueryIsolationOutputError &&
      error.code === 'storage_failed' &&
      !error.message.includes('private storage detail')
  );
  assert.deepEqual(deleted, [`isolations/${ISOLATION_ID}/target.wav`]);

  await assert.rejects(
    discardQueryIsolationOutput(
      { AUDIO: { delete() { throw new Error('must not run'); } } } as never,
      'uploads/student/source.wav'
    ),
    (error: unknown) =>
      error instanceof QueryIsolationOutputError && error.code === 'invalid_request'
  );
});
