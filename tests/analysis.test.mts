import assert from 'node:assert/strict';
import test from 'node:test';
import {
  degradedAnalysis,
  parseAudioAnalysisResult,
  parseBrowserAutoSummary,
} from '../src/analysis/contract.ts';
import { resolveAutoRouting } from '../src/analysis/routing.ts';
import { httpAudioAnalysisProvider } from '../src/analysis/http.ts';
import { configuredAudioAnalysisProvider } from '../src/analysis/index.ts';
import {
  PINNED_ROLE_CLASSIFIER_VERSION,
  type AudioAnalysisProvider,
} from '../src/analysis/types.ts';
import { getSeparationOptions } from '../src/separation/options.ts';

const models = getSeparationOptions('replicate').models;
const allowed = new Set(models.map((model) => model.id));
const TEST_ANALYSIS_TOKEN = 'analysis-test-token-000000000000000';

function validAnalysis(model = 'htdemucs_6s') {
  return {
    schemaVersion: '1',
    roleClassifier: { version: PINNED_ROLE_CLASSIFIER_VERSION },
    vocabularyClassifier: { version: 'clap-music-2026-08', vocabularyVersion: 'classroom-v1' },
    decision: {
      choice: model === 'htdemucs_6s' ? 'six' : 'four',
      resolvedCoreModel: model,
      confidence: null,
      features: {
        onsetsPerSecond: 2.1,
        pitchedAttacksPerSecond: 1.2,
        sustainedLow: 0.18,
        percussiveHigh: 0.08,
        silent: false,
      },
      reason: 'plucked or hammered pitched layers — 6 parts can pull them out',
    },
    detectedInstruments: [{ id: 'saxophone', label: 'Saxophone', confidence: 0.82 }],
    timing: { totalMs: 84, analyzedSeconds: 45 },
    degraded: { active: false, code: null },
  };
}

test('analysis v1 accepts pinned, versioned metadata without routing a detection label', () => {
  const result = parseAudioAnalysisResult(validAnalysis(), models, 'htdemucs_ft', true);
  assert.equal(result.decision.resolvedCoreModel, 'htdemucs_6s');
  assert.equal(result.decision.confidence, null, 'v1 may say confidence is not calibrated');
  assert.deepEqual(result.detectedInstruments, [
    { id: 'saxophone', label: 'Saxophone', confidence: 0.82 },
  ]);
  assert.equal(allowed.has(result.detectedInstruments[0].id), false, 'a label is not a core model');
});

test('disabled discovery strips classifier labels and vocabulary metadata', () => {
  const result = parseAudioAnalysisResult(validAnalysis(), models, 'htdemucs_ft', false);
  assert.deepEqual(result.detectedInstruments, []);
  assert.equal(result.vocabularyClassifier, undefined);
});

test('analysis v1 rejects schema drift, floating pins, unsupported models, and duplicate labels', () => {
  assert.throws(
    () =>
      parseAudioAnalysisResult(
        { ...validAnalysis(), schemaVersion: '2' },
        models,
        'htdemucs_ft',
        true
      ),
    /schema version/
  );
  assert.throws(
    () =>
      parseAudioAnalysisResult(
        { ...validAnalysis(), roleClassifier: { version: 'latest' } },
        models,
        'htdemucs_ft',
        true
      ),
    /classifier version/
  );
  assert.throws(
    () =>
      parseAudioAnalysisResult(
        { ...validAnalysis(), roleClassifier: { version: 'autosplit-role-v2' } },
        models,
        'htdemucs_ft',
        true
      ),
    /does not match the app pin/
  );
  assert.throws(
    () =>
      parseAudioAnalysisResult(
        {
          ...validAnalysis(),
          decision: { ...validAnalysis().decision, resolvedCoreModel: 'auto' },
        },
        models,
        'htdemucs_ft',
        true
      ),
    /decision/
  );
  assert.throws(
    () =>
      parseAudioAnalysisResult(
        {
          ...validAnalysis(),
          detectedInstruments: [
            { id: 'saxophone', label: 'Saxophone', confidence: 0.8 },
            { id: 'saxophone', label: 'Sax', confidence: 0.7 },
          ],
        },
        models,
        'htdemucs_ft',
        true
      ),
    /duplicated/
  );
});

test('analysis v1 rejects invalid confidence, non-finite features, and inconsistent fallback state', () => {
  assert.throws(
    () =>
      parseAudioAnalysisResult(
        { ...validAnalysis(), decision: { ...validAnalysis().decision, confidence: 1.1 } },
        models,
        'htdemucs_ft',
        true
      ),
    /decision/
  );
  assert.throws(
    () =>
      parseAudioAnalysisResult(
        {
          ...validAnalysis(),
          decision: {
            ...validAnalysis().decision,
            features: { ...validAnalysis().decision.features, sustainedLow: Number.NaN },
          },
        },
        models,
        'htdemucs_ft',
        true
      ),
    /sustainedLow/
  );
  assert.throws(
    () =>
      parseAudioAnalysisResult(
        { ...validAnalysis(), degraded: { active: true, code: 'analysis_unavailable' } },
        models,
        'htdemucs_ft',
        true
      ),
    /fallback state/
  );
});

test('analysis v1 rejects contradictions between choice, model contract, and fallback', () => {
  assert.throws(
    () =>
      parseAudioAnalysisResult(
        {
          ...validAnalysis(),
          decision: { ...validAnalysis().decision, choice: 'two' },
        },
        models,
        'htdemucs_ft',
        true
      ),
    /choice does not match/
  );
  assert.throws(
    () =>
      parseAudioAnalysisResult(
        degradedAnalysis(
          'htdemucs_6s',
          'analysis_unavailable',
          'wrong fallback supplied by the service',
          10
        ),
        models,
        'htdemucs_ft',
        false
      ),
    /fallback state/
  );
});

test('analysis v1 rejects unversioned detections and work beyond the bounded window', () => {
  const { vocabularyClassifier: _removed, ...unversioned } = validAnalysis();
  assert.throws(
    () => parseAudioAnalysisResult(unversioned, models, 'htdemucs_ft', true),
    /pinned vocabulary classifier/
  );
  assert.throws(
    () =>
      parseAudioAnalysisResult(
        { ...validAnalysis(), timing: { totalMs: 100, analyzedSeconds: 45.01 } },
        models,
        'htdemucs_ft',
        true
      ),
    /timing/
  );
});

test('browser Auto summaries are bounded and must resolve to a concrete contract', () => {
  assert.deepEqual(
    parseBrowserAutoSummary(
      {
        classifierVersion: PINNED_ROLE_CLASSIFIER_VERSION,
        choice: 'four',
        resolvedCoreModel: 'htdemucs_ft',
        reason: 'percussion and low end present',
      },
      models
    ),
    {
      classifierVersion: PINNED_ROLE_CLASSIFIER_VERSION,
      choice: 'four',
      resolvedCoreModel: 'htdemucs_ft',
      reason: 'percussion and low end present',
    }
  );
  assert.throws(
    () =>
      parseBrowserAutoSummary(
        {
          classifierVersion: PINNED_ROLE_CLASSIFIER_VERSION,
          choice: 'four',
          resolvedCoreModel: 'auto',
          reason: 'invalid',
        },
        models
      ),
    /invalid/
  );
  assert.throws(
    () =>
      parseBrowserAutoSummary(
        {
          classifierVersion: 'autosplit-role-v2',
          choice: 'four',
          resolvedCoreModel: 'htdemucs_ft',
          reason: 'stale browser classifier',
        },
        models
      ),
    /invalid/
  );
});

const provider = (result: unknown): AudioAnalysisProvider => ({
  async analyze() {
    return result;
  },
});

test('shadow Auto records disagreement while honoring the existing browser choice', async () => {
  const route = await resolveAutoRouting({
    sourceUrl: 'https://audio.invalid/source',
    sourceType: 'upload',
    mode: 'shadow',
    currentModel: 'vocals_instrumental',
    fallbackModel: 'htdemucs_ft',
    coreModels: models,
    browserAnalysis: {
      classifierVersion: PINNED_ROLE_CLASSIFIER_VERSION,
      choice: 'two',
      resolvedCoreModel: 'vocals_instrumental',
      reason: 'sustained material',
    },
    provider: provider(validAnalysis('htdemucs_6s')),
    timeoutMs: 15_000,
    instrumentDiscovery: false,
  });
  assert.equal(route.resolvedCoreModel, 'vocals_instrumental');
  assert.equal(route.analysis.decision.resolvedCoreModel, 'htdemucs_6s');
  assert.equal(route.applied, false);
  assert.equal(route.comparison, 'disagree');
});

test('authoritative Auto applies a valid core recommendation', async () => {
  const route = await resolveAutoRouting({
    sourceUrl: 'https://audio.invalid/source',
    sourceType: 'youtube',
    mode: 'authoritative',
    currentModel: 'htdemucs_ft',
    fallbackModel: 'htdemucs_ft',
    coreModels: models,
    provider: provider(validAnalysis('htdemucs_6s')),
    timeoutMs: 15_000,
    instrumentDiscovery: true,
  });
  assert.equal(route.resolvedCoreModel, 'htdemucs_6s');
  assert.equal(route.applied, true);
  assert.equal(route.sourceType, 'youtube');
  assert.equal(route.analysis.detectedInstruments[0].id, 'saxophone');
});

test('missing, failed, malformed, and service-degraded analysis all preserve the four-track fallback', async () => {
  const cases: Array<[string, AudioAnalysisProvider | null]> = [
    ['missing', null],
    ['failed', { async analyze() { throw new Error('offline'); } }],
    ['malformed', provider({ schemaVersion: '9' })],
    [
      'classifier-version-mismatch',
      provider({ ...validAnalysis(), roleClassifier: { version: 'autosplit-role-v2' } }),
    ],
    [
      'degraded',
      provider(degradedAnalysis('htdemucs_ft', 'audio_unsupported', 'unsupported audio', 10)),
    ],
  ];
  for (const [name, candidate] of cases) {
    const route = await resolveAutoRouting({
      sourceUrl: 'https://audio.invalid/source',
      sourceType: 'archive',
      mode: 'authoritative',
      currentModel: 'htdemucs_ft',
      fallbackModel: 'htdemucs_ft',
      coreModels: models,
      provider: candidate,
      timeoutMs: 15_000,
      instrumentDiscovery: false,
    });
    assert.equal(route.resolvedCoreModel, 'htdemucs_ft', name);
    assert.equal(route.analysis.degraded.active, true, name);
    assert.equal(route.applied, false, name);
    assert.equal(route.comparison, 'unavailable', name);
  }
});

test('a degraded analyzer cannot manufacture shadow agreement with the browser fallback', async () => {
  const route = await resolveAutoRouting({
    sourceUrl: 'https://audio.invalid/source',
    sourceType: 'upload',
    mode: 'shadow',
    currentModel: 'htdemucs_ft',
    fallbackModel: 'htdemucs_ft',
    coreModels: models,
    browserAnalysis: {
      classifierVersion: PINNED_ROLE_CLASSIFIER_VERSION,
      choice: 'four',
      resolvedCoreModel: 'htdemucs_ft',
      reason: 'browser chose the fallback',
    },
    provider: null,
    timeoutMs: 15_000,
    instrumentDiscovery: false,
  });
  assert.equal(route.comparison, 'unavailable');
});

test('routing enforces its timeout even when a provider ignores AbortSignal', async () => {
  const route = await resolveAutoRouting({
    sourceUrl: 'https://audio.invalid/source',
    sourceType: 'upload',
    mode: 'authoritative',
    currentModel: 'htdemucs_ft',
    fallbackModel: 'htdemucs_ft',
    coreModels: models,
    provider: { async analyze() { return new Promise(() => {}); } },
    timeoutMs: 1_000,
    instrumentDiscovery: false,
  });
  assert.equal(route.resolvedCoreModel, 'htdemucs_ft');
  assert.equal(route.analysis.degraded.code, 'analysis_timeout');
  assert.equal(route.applied, false);
});

test('HTTP analysis adapter sends the private bearer token and versioned request', async () => {
  const originalFetch = globalThis.fetch;
  let observed: { url?: string; init?: RequestInit } = {};
  globalThis.fetch = async (input, init) => {
    observed = { url: String(input), init };
    return new Response(JSON.stringify(validAnalysis()), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const adapter = httpAudioAnalysisProvider('https://analysis.test', TEST_ANALYSIS_TOKEN);
    await adapter.analyze({
      schemaVersion: '1',
      sourceUrl: 'https://source.invalid/signed',
      sourceType: 'upload',
      coreModels: models.map(({ id, stems }) => ({ id, stems })),
      fallbackModel: 'htdemucs_ft',
      instrumentDiscovery: false,
    });
    assert.equal(observed.url, 'https://analysis.test/v1/analyze');
    assert.equal(
      new Headers(observed.init?.headers).get('authorization'),
      `Bearer ${TEST_ANALYSIS_TOKEN}`
    );
    assert.equal(new Headers(observed.init?.headers).get('content-type'), 'application/json');
    assert.equal(observed.init?.redirect, 'manual');
    assert.deepEqual(JSON.parse(String(observed.init?.body)), {
      schemaVersion: '1',
      sourceUrl: 'https://source.invalid/signed',
      sourceType: 'upload',
      coreModels: models.map(({ id, stems }) => ({ id, stems })),
      fallbackModel: 'htdemucs_ft',
      instrumentDiscovery: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('HTTP analysis adapter does not follow redirects with its bearer token', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.redirect, 'manual');
    return new Response(null, {
      status: 307,
      headers: { Location: 'https://attacker.invalid/collect' },
    });
  };
  try {
    const adapter = httpAudioAnalysisProvider('https://analysis.test', TEST_ANALYSIS_TOKEN);
    await assert.rejects(
      adapter.analyze({
        schemaVersion: '1',
        sourceUrl: 'https://source.invalid/signed',
        sourceType: 'upload',
        coreModels: models.map(({ id, stems }) => ({ id, stems })),
        fallbackModel: 'htdemucs_ft',
        instrumentDiscovery: false,
      }),
      /failed \(307\)/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('HTTP analysis adapter rejects an oversized streamed body before parsing it', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('x'.repeat(64 * 1024 + 1), {
      headers: { 'Content-Type': 'application/json' },
    });
  try {
    const adapter = httpAudioAnalysisProvider('https://analysis.test', TEST_ANALYSIS_TOKEN);
    await assert.rejects(
      adapter.analyze({
        schemaVersion: '1',
        sourceUrl: 'https://source.invalid/signed',
        sourceType: 'upload',
        coreModels: models.map(({ id, stems }) => ({ id, stems })),
        fallbackModel: 'htdemucs_ft',
        instrumentDiscovery: false,
      }),
      /too large/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('invalid analysis service configuration fails closed instead of throwing during job setup', () => {
  for (const url of [
    'file:///tmp/not-a-service',
    'not a URL',
    'http://analysis.example',
    'https://user:password@analysis.test',
    'https://analysis.test/private',
    'https://analysis.test?target=other',
  ]) {
    assert.equal(
      configuredAudioAnalysisProvider({
        AUDIO_ANALYSIS_URL: url,
        AUDIO_ANALYSIS_TOKEN: TEST_ANALYSIS_TOKEN,
      } as never),
      null,
      url
    );
  }
  for (const url of [
    'https://analysis.test',
    'http://audio-analysis.railway.internal:8080',
    'http://127.0.0.1:8080',
    'http://localhost:8080',
  ]) {
    assert.ok(
      configuredAudioAnalysisProvider({
        AUDIO_ANALYSIS_URL: url,
        AUDIO_ANALYSIS_TOKEN: TEST_ANALYSIS_TOKEN,
      } as never),
      url
    );
  }
  assert.equal(
    configuredAudioAnalysisProvider({
      AUDIO_ANALYSIS_URL: 'https://analysis.test',
      AUDIO_ANALYSIS_TOKEN: 'too-short',
    } as never),
    null
  );
});
