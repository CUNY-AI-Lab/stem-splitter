import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INSTRUMENT_DISCOVERY_SCHEMA_VERSION,
  PINNED_INSTRUMENT_CLASSIFIER_VERSION,
  PINNED_INSTRUMENT_MODEL_SHA256,
  PINNED_INSTRUMENT_VOCABULARY_SHA256,
  PINNED_INSTRUMENT_VOCABULARY_VERSION,
} from '../src/analysis/types.ts';
import { ANALYSIS_SAMPLE_RATE } from './config.ts';
import type { DecodedAnalysisAudio } from './decoder.ts';
import {
  discoveryWindowSampleCounts,
  httpInstrumentDiscoveryProvider,
  instrumentDiscoveryEndpoint,
  InstrumentDiscoveryError,
  parseInstrumentDiscoveryResult,
} from './discovery.ts';

function decoded(seconds = 1, windowSampleCounts?: readonly number[]): DecodedAnalysisAudio {
  const samples = new Float32Array(seconds * ANALYSIS_SAMPLE_RATE);
  return {
    samples,
    sampleRate: ANALYSIS_SAMPLE_RATE,
    sourceDurationSeconds: seconds,
    analyzedSeconds: seconds,
    windowSampleCounts: windowSampleCounts ?? [samples.length],
  };
}

function wire(windowsAnalyzed = 1) {
  return {
    schemaVersion: INSTRUMENT_DISCOVERY_SCHEMA_VERSION,
    classifier: {
      version: PINNED_INSTRUMENT_CLASSIFIER_VERSION,
      weightsSha256: PINNED_INSTRUMENT_MODEL_SHA256,
    },
    vocabularyVersion: PINNED_INSTRUMENT_VOCABULARY_VERSION,
    vocabularySha256: PINNED_INSTRUMENT_VOCABULARY_SHA256,
    detections: [
      {
        id: 'saxophone',
        label: 'Saxophone',
        confidence: 0.82,
        state: 'possible',
        windowSupport: 1,
        windowsAnalyzed,
      },
    ],
    windowsAnalyzed,
    timingMs: 120,
  } as const;
}

function contractInvalid(error: unknown): boolean {
  return error instanceof InstrumentDiscoveryError && error.code === 'discovery_contract_invalid';
}

test('discovery response parser requires every classifier and vocabulary content pin', () => {
  assert.deepEqual(parseInstrumentDiscoveryResult(wire(), 1), wire());
  for (const candidate of [
    { ...wire(), schemaVersion: '2' },
    { ...wire(), vocabularyVersion: 'latest' },
    { ...wire(), vocabularySha256: '0'.repeat(64) },
    {
      ...wire(),
      classifier: { ...wire().classifier, weightsSha256: '0'.repeat(64) },
    },
    { ...wire(), unexpected: true },
    { ...wire(), windowsAnalyzed: 2 },
    { ...wire(), detections: [...wire().detections, wire().detections[0]] },
    {
      ...wire(),
      detections: [{ ...wire().detections[0], windowSupport: 2 }],
    },
  ]) {
    assert.throws(() => parseInstrumentDiscoveryResult(candidate, 1), contractInvalid);
  }
});

test('discovery windows are bounded, contiguous, and never exceed three', () => {
  const fifteenSeconds = 15 * ANALYSIS_SAMPLE_RATE;
  assert.deepEqual(
    discoveryWindowSampleCounts(decoded(45, [fifteenSeconds, fifteenSeconds, fifteenSeconds])),
    [fifteenSeconds, fifteenSeconds, fifteenSeconds]
  );
  assert.deepEqual(discoveryWindowSampleCounts(decoded(45)), [
    fifteenSeconds,
    fifteenSeconds,
    fifteenSeconds,
  ]);
  assert.throws(() => discoveryWindowSampleCounts(decoded(46)), contractInvalid);
  assert.throws(() => discoveryWindowSampleCounts(decoded(2, [ANALYSIS_SAMPLE_RATE])), contractInvalid);
});

test('discovery endpoint accepts only loopback or Railway private origins', () => {
  assert.equal(instrumentDiscoveryEndpoint('http://127.0.0.1:9090'), 'http://127.0.0.1:9090/v1/classify');
  assert.equal(
    instrumentDiscoveryEndpoint('http://instrument-discovery.railway.internal'),
    'http://instrument-discovery.railway.internal/v1/classify'
  );
  for (const candidate of [
    'https://public-discovery.example',
    'http://metadata.internal',
    'http://user:pass@127.0.0.1:9090',
    'http://127.0.0.1:9090/base',
    'http://127.0.0.1:9090/?next=public',
  ]) {
    assert.throws(() => instrumentDiscoveryEndpoint(candidate), (error: unknown) =>
      error instanceof InstrumentDiscoveryError && error.code === 'discovery_unconfigured'
    );
  }
});

test('HTTP discovery sends bounded PCM and exact pins without following redirects', async (t) => {
  const source = decoded();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal(String(input), 'http://instrument-discovery.railway.internal/v1/classify');
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-audio-sample-rate'), String(ANALYSIS_SAMPLE_RATE));
    assert.equal(headers.get('x-audio-window-samples'), String(ANALYSIS_SAMPLE_RATE));
    assert.equal(headers.get('x-expected-weights-sha256'), PINNED_INSTRUMENT_MODEL_SHA256);
    assert.equal(headers.get('x-vocabulary-sha256'), PINNED_INSTRUMENT_VOCABULARY_SHA256);
    assert.equal((init?.body as Uint8Array).byteLength, source.samples.byteLength);
    return new Response(JSON.stringify(wire()), {
      status: 302,
      headers: {
        'Content-Type': 'application/json',
        Location: 'https://public-discovery.example/steal-token',
      },
    });
  });
  const provider = httpInstrumentDiscoveryProvider({
    baseUrl: 'http://instrument-discovery.railway.internal',
    token: 'discovery-test-token-that-is-at-least-32-characters',
    timeoutMs: 1_000,
  });
  await assert.rejects(
    provider.discover(source),
    (error: unknown) =>
      error instanceof InstrumentDiscoveryError && error.code === 'discovery_unavailable'
  );
  assert.equal(calls, 1);
});

test('HTTP discovery honors a parent request that was already aborted', async (t) => {
  const parent = new AbortController();
  parent.abort(new Error('caller gone'));
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.signal?.aborted, true);
    throw init?.signal?.reason;
  });
  const provider = httpInstrumentDiscoveryProvider({
    baseUrl: 'http://instrument-discovery.railway.internal',
    token: 'discovery-test-token-that-is-at-least-32-characters',
    timeoutMs: 1_000,
  });
  await assert.rejects(
    provider.discover(decoded(), parent.signal),
    (error: unknown) =>
      error instanceof InstrumentDiscoveryError && error.code === 'discovery_unavailable'
  );
});
