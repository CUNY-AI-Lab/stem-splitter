import assert from 'node:assert/strict';
import test from 'node:test';
import {
  degradedAnalysis,
  parseAudioAnalysisResult,
  parseAudioFingerprintResult,
  parseAutoRoutingDecision,
  parseBrowserAutoSummary,
} from '../src/analysis/contract.ts';
import { resolveAutoRouting, resolveAutoRoutingWithSource } from '../src/analysis/routing.ts';
import { requestSourceFingerprint } from '../src/analysis/fingerprint.ts';
import { httpAudioAnalysisProvider } from '../src/analysis/http.ts';
import { configuredAudioAnalysisProvider } from '../src/analysis/index.ts';
import { redactInstrumentDiscovery } from '../src/analysis/redaction.ts';
import {
  PINNED_INSTRUMENT_CLASSIFIER_VERSION,
  PINNED_INSTRUMENT_MODEL_SHA256,
  PINNED_INSTRUMENT_VOCABULARY_SHA256,
  PINNED_INSTRUMENT_VOCABULARY_VERSION,
  PINNED_ROLE_CLASSIFIER_VERSION,
  type AudioAnalysisProvider,
} from '../src/analysis/types.ts';
import { getSeparationOptions } from '../src/separation/options.ts';

const models = getSeparationOptions('replicate').models;
const allowed = new Set(models.map((model) => model.id));
const TEST_ANALYSIS_TOKEN = 'analysis-test-token-000000000000000';
const SOURCE_SHA256 = 'a'.repeat(64);

const sourceIdentity = {
  schemaVersion: '1' as const,
  sha256: SOURCE_SHA256,
  bytes: 1234,
};

function validAnalysis(model = 'htdemucs_6s') {
  return {
    schemaVersion: '1',
    roleClassifier: { version: PINNED_ROLE_CLASSIFIER_VERSION },
    vocabularyClassifier: {
      version: PINNED_INSTRUMENT_CLASSIFIER_VERSION,
      weightsSha256: PINNED_INSTRUMENT_MODEL_SHA256,
      vocabularyVersion: PINNED_INSTRUMENT_VOCABULARY_VERSION,
      vocabularySha256: PINNED_INSTRUMENT_VOCABULARY_SHA256,
    },
    instrumentDiscovery: {
      status: 'complete',
      code: null,
      totalMs: 40,
      windowsAnalyzed: 3,
    },
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
    detectedInstruments: [
      {
        id: 'saxophone',
        label: 'Saxophone',
        confidence: 0.82,
        state: 'possible',
        windowSupport: 2,
        windowsAnalyzed: 3,
      },
    ],
    timing: { totalMs: 84, analyzedSeconds: 45 },
    degraded: { active: false, code: null },
  };
}

test('analysis v1 accepts pinned, versioned metadata without routing a detection label', () => {
  const result = parseAudioAnalysisResult(validAnalysis(), models, 'htdemucs_ft', true);
  assert.equal(result.decision.resolvedCoreModel, 'htdemucs_6s');
  assert.equal(result.decision.confidence, null, 'v1 may say confidence is not calibrated');
  assert.deepEqual(result.detectedInstruments, [
    {
      id: 'saxophone',
      label: 'Saxophone',
      confidence: 0.82,
      state: 'possible',
      windowSupport: 2,
      windowsAnalyzed: 3,
    },
  ]);
  assert.equal(allowed.has(result.detectedInstruments[0].id), false, 'a label is not a core model');
});

test('disabled discovery strips classifier labels and vocabulary metadata', () => {
  const result = parseAudioAnalysisResult(validAnalysis(), models, 'htdemucs_ft', false);
  assert.deepEqual(result.detectedInstruments, []);
  assert.equal(result.vocabularyClassifier, undefined);
});

test('source fingerprint metadata is exact, private, and bounded', () => {
  assert.deepEqual(
    parseAudioFingerprintResult({
      schemaVersion: '1',
      source: sourceIdentity,
      timing: { totalMs: 12 },
    }),
    { schemaVersion: '1', source: sourceIdentity, timing: { totalMs: 12 } }
  );
  for (const invalid of [
    { ...sourceIdentity, sha256: 'not-a-hash' },
    { ...sourceIdentity, sha256: SOURCE_SHA256.toUpperCase() },
    { ...sourceIdentity, bytes: 0 },
    { ...sourceIdentity, bytes: 100 * 1024 * 1024 + 1 },
    { ...sourceIdentity, unexpected: true },
  ]) {
    assert.throws(
      () =>
        parseAudioFingerprintResult({
          schemaVersion: '1',
          source: invalid,
          timing: { totalMs: 12 },
        }),
      /fingerprint/
    );
  }
});

test('analysis v1 rejects core schema drift, floating pins, and unsupported models', () => {
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

test('analysis v1 quarantines invalid discovery without rejecting the core decision', () => {
  const { vocabularyClassifier: _removed, ...unversioned } = validAnalysis();
  const unversionedResult = parseAudioAnalysisResult(unversioned, models, 'htdemucs_ft', true);
  assert.equal(unversionedResult.decision.resolvedCoreModel, 'htdemucs_6s');
  assert.deepEqual(unversionedResult.detectedInstruments, []);
  assert.deepEqual(unversionedResult.instrumentDiscovery, {
    status: 'unavailable',
    code: 'discovery_contract_invalid',
    totalMs: 0,
    windowsAnalyzed: 0,
  });

  const duplicateResult = parseAudioAnalysisResult(
    {
      ...validAnalysis(),
      detectedInstruments: [
        ...validAnalysis().detectedInstruments,
        { ...validAnalysis().detectedInstruments[0], label: 'Sax' },
      ],
    },
    models,
    'htdemucs_ft',
    true
  );
  assert.equal(duplicateResult.decision.resolvedCoreModel, 'htdemucs_6s');
  assert.equal(duplicateResult.instrumentDiscovery?.code, 'discovery_contract_invalid');
  assert.deepEqual(duplicateResult.detectedInstruments, []);

  for (const detection of [
    { ...validAnalysis().detectedInstruments[0], id: 'kazoo', label: 'Kazoo' },
    { ...validAnalysis().detectedInstruments[0], label: 'Trumpet' },
  ]) {
    const driftedResult = parseAudioAnalysisResult(
      { ...validAnalysis(), detectedInstruments: [detection] },
      models,
      'htdemucs_ft',
      true
    );
    assert.equal(driftedResult.instrumentDiscovery?.code, 'discovery_contract_invalid');
    assert.deepEqual(driftedResult.detectedInstruments, []);
  }
});

test('analysis v1 still rejects core work beyond the bounded audio window', () => {
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

test('an explicit discovery outage preserves the core decision and its own failure trace', () => {
  const {
    vocabularyClassifier: _removedVocabulary,
    instrumentDiscovery: _removedTrace,
    ...base
  } = validAnalysis();
  const result = parseAudioAnalysisResult(
    {
      ...base,
      instrumentDiscovery: {
        status: 'unavailable',
        code: 'discovery_timeout',
        totalMs: 30_000,
        windowsAnalyzed: 0,
      },
      detectedInstruments: [],
    },
    models,
    'htdemucs_ft',
    true
  );
  assert.equal(result.decision.resolvedCoreModel, 'htdemucs_6s');
  assert.deepEqual(result.instrumentDiscovery, {
    status: 'unavailable',
    code: 'discovery_timeout',
    totalMs: 30_000,
    windowsAnalyzed: 0,
  });
  assert.deepEqual(result.detectedInstruments, []);
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

test('Auto returns verified source identity out-of-band without persisting it in the decision', async () => {
  const resolution = await resolveAutoRoutingWithSource({
    sourceUrl: 'https://audio.invalid/source',
    sourceType: 'upload',
    mode: 'authoritative',
    currentModel: 'htdemucs_ft',
    fallbackModel: 'htdemucs_ft',
    coreModels: models,
    provider: provider({ ...validAnalysis('htdemucs_6s'), source: sourceIdentity }),
    timeoutMs: 15_000,
    instrumentDiscovery: false,
  });
  assert.deepEqual(resolution.sourceIdentity, sourceIdentity);
  assert.equal(resolution.decision.resolvedCoreModel, 'htdemucs_6s');
  assert.equal('source' in resolution.decision, false);
  assert.doesNotMatch(JSON.stringify(resolution.decision), new RegExp(SOURCE_SHA256));

  const malformed = await resolveAutoRoutingWithSource({
    sourceUrl: 'https://audio.invalid/source',
    sourceType: 'upload',
    mode: 'authoritative',
    currentModel: 'htdemucs_ft',
    fallbackModel: 'htdemucs_ft',
    coreModels: models,
    provider: provider({ ...validAnalysis('htdemucs_6s'), source: { ...sourceIdentity, bytes: 0 } }),
    timeoutMs: 15_000,
    instrumentDiscovery: false,
  });
  assert.equal(malformed.sourceIdentity, null);
  assert.equal(malformed.decision.resolvedCoreModel, 'htdemucs_6s');
  assert.equal(malformed.decision.analysis.degraded.active, false);

  const invalidCore = await resolveAutoRoutingWithSource({
    sourceUrl: 'https://audio.invalid/source',
    sourceType: 'upload',
    mode: 'authoritative',
    currentModel: 'htdemucs_ft',
    fallbackModel: 'htdemucs_ft',
    coreModels: models,
    provider: provider({
      ...validAnalysis('htdemucs_6s'),
      roleClassifier: { version: 'floating-role-version' },
      source: sourceIdentity,
    }),
    timeoutMs: 15_000,
    instrumentDiscovery: false,
  });
  assert.equal(invalidCore.sourceIdentity, null);
  assert.equal(invalidCore.decision.analysis.degraded.code, 'analysis_contract_invalid');
});

test('server-fetched imports route only when analyzer identity matches exact stored bytes', async () => {
  const matching = await resolveAutoRoutingWithSource({
    sourceUrl: 'https://audio.invalid/source',
    sourceType: 'youtube',
    mode: 'authoritative',
    currentModel: 'htdemucs_ft',
    fallbackModel: 'htdemucs_ft',
    coreModels: models,
    expectedSourceIdentity: sourceIdentity,
    provider: provider({ ...validAnalysis('htdemucs_6s'), source: sourceIdentity }),
    timeoutMs: 15_000,
    instrumentDiscovery: false,
  });
  assert.equal(matching.decision.resolvedCoreModel, 'htdemucs_6s');
  assert.equal(matching.decision.applied, true);
  assert.deepEqual(matching.sourceIdentity, sourceIdentity);

  for (const returnedSource of [
    undefined,
    { ...sourceIdentity, sha256: 'b'.repeat(64) },
    { ...sourceIdentity, bytes: sourceIdentity.bytes + 1 },
  ]) {
    const resolution = await resolveAutoRoutingWithSource({
      sourceUrl: 'https://audio.invalid/source',
      sourceType: 'archive',
      mode: 'authoritative',
      currentModel: 'htdemucs_ft',
      fallbackModel: 'htdemucs_ft',
      coreModels: models,
      expectedSourceIdentity: sourceIdentity,
      provider: provider({
        ...validAnalysis('htdemucs_6s'),
        ...(returnedSource ? { source: returnedSource } : {}),
      }),
      timeoutMs: 15_000,
      instrumentDiscovery: false,
    });
    assert.equal(resolution.sourceIdentity, null);
    assert.equal(resolution.decision.resolvedCoreModel, 'htdemucs_ft');
    assert.equal(resolution.decision.applied, false);
    assert.equal(
      resolution.decision.analysis.degraded.code,
      'source_identity_mismatch'
    );
    assert.equal(resolution.decision.comparison, 'unavailable');
  }
});

test('immutable upload snapshots route only when analyzer byte count matches the frozen object', async () => {
  const matching = await resolveAutoRoutingWithSource({
    sourceUrl: 'https://audio.invalid/auto-inputs/v1/job',
    sourceType: 'upload',
    mode: 'authoritative',
    currentModel: 'htdemucs_ft',
    fallbackModel: 'htdemucs_ft',
    coreModels: models,
    expectedSourceBytes: sourceIdentity.bytes,
    provider: provider({ ...validAnalysis('htdemucs_6s'), source: sourceIdentity }),
    timeoutMs: 15_000,
    instrumentDiscovery: false,
  });
  assert.equal(matching.decision.resolvedCoreModel, 'htdemucs_6s');
  assert.equal(matching.decision.applied, true);
  assert.deepEqual(matching.sourceIdentity, sourceIdentity);

  for (const returnedSource of [
    undefined,
    { ...sourceIdentity, bytes: sourceIdentity.bytes + 1 },
  ]) {
    const resolution = await resolveAutoRoutingWithSource({
      sourceUrl: 'https://audio.invalid/auto-inputs/v1/job',
      sourceType: 'upload',
      mode: 'authoritative',
      currentModel: 'htdemucs_ft',
      fallbackModel: 'htdemucs_ft',
      coreModels: models,
      expectedSourceBytes: sourceIdentity.bytes,
      provider: provider({
        ...validAnalysis('htdemucs_6s'),
        ...(returnedSource ? { source: returnedSource } : {}),
      }),
      timeoutMs: 15_000,
      instrumentDiscovery: false,
    });
    assert.equal(resolution.sourceIdentity, null);
    assert.equal(resolution.decision.resolvedCoreModel, 'htdemucs_ft');
    assert.equal(resolution.decision.applied, false);
    assert.equal(
      resolution.decision.analysis.degraded.code,
      'source_identity_mismatch'
    );
  }
});

test('persisted Auto routing is normalized before teacher or student readback', async () => {
  const route = await resolveAutoRouting({
    sourceUrl: 'https://audio.invalid/source',
    sourceType: 'archive',
    mode: 'authoritative',
    currentModel: 'htdemucs_ft',
    fallbackModel: 'htdemucs_ft',
    coreModels: models,
    provider: provider(validAnalysis('htdemucs_6s')),
    timeoutMs: 15_000,
    instrumentDiscovery: true,
  });
  assert.deepEqual(parseAutoRoutingDecision(JSON.parse(JSON.stringify(route)), models), route);

  assert.throws(
    () => parseAutoRoutingDecision({ ...route, unexpected: 'stored drift' }, models),
    /stored Auto routing decision/
  );
  assert.throws(
    () => parseAutoRoutingDecision({ ...route, applied: false }, models),
    /authoritative routing/
  );
  assert.throws(
    () => parseAutoRoutingDecision({ ...route, resolvedCoreModel: 'auto' }, models),
    /routing model/
  );
});

test('persisted malformed discovery is quarantined without losing its valid core route', async () => {
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
  const parsed = parseAutoRoutingDecision(
    {
      ...route,
      analysis: { ...route.analysis, instrumentDiscovery: { status: 'complete' } },
    },
    models
  );
  assert.equal(parsed.resolvedCoreModel, 'htdemucs_6s');
  assert.equal(parsed.applied, true);
  assert.equal(parsed.analysis.instrumentDiscovery?.code, 'discovery_contract_invalid');
  assert.deepEqual(parsed.analysis.detectedInstruments, []);
});

test('malformed advisory discovery cannot change an authoritative core recommendation', async () => {
  const route = await resolveAutoRouting({
    sourceUrl: 'https://audio.invalid/source',
    sourceType: 'youtube',
    mode: 'authoritative',
    currentModel: 'htdemucs_ft',
    fallbackModel: 'htdemucs_ft',
    coreModels: models,
    provider: provider({ ...validAnalysis(), instrumentDiscovery: { status: 'complete' } }),
    timeoutMs: 15_000,
    instrumentDiscovery: true,
  });
  assert.equal(route.resolvedCoreModel, 'htdemucs_6s');
  assert.equal(route.applied, true);
  assert.equal(route.analysis.degraded.active, false);
  assert.equal(route.analysis.instrumentDiscovery?.code, 'discovery_contract_invalid');
  assert.deepEqual(route.analysis.detectedInstruments, []);
});

test('student redaction is non-mutating and removes discovery labels and private pins', async () => {
  const route = await resolveAutoRouting({
    sourceUrl: 'https://audio.invalid/source',
    sourceType: 'upload',
    mode: 'authoritative',
    currentModel: 'htdemucs_ft',
    fallbackModel: 'htdemucs_ft',
    coreModels: models,
    provider: provider(validAnalysis('htdemucs_6s')),
    timeoutMs: 15_000,
    instrumentDiscovery: true,
  });
  const studentRoute = redactInstrumentDiscovery(route);
  assert.equal(studentRoute.resolvedCoreModel, 'htdemucs_6s');
  assert.equal(studentRoute.analysis.vocabularyClassifier, undefined);
  assert.deepEqual(studentRoute.analysis.detectedInstruments, []);
  assert.equal(studentRoute.analysis.instrumentDiscovery?.status, 'complete');
  assert.equal(route.analysis.detectedInstruments[0].id, 'saxophone');
  assert.equal(route.analysis.vocabularyClassifier?.weightsSha256, PINNED_INSTRUMENT_MODEL_SHA256);
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

test('HTTP fingerprint adapter uses the same guarded origin and bounded contract', async () => {
  const originalFetch = globalThis.fetch;
  let observed: { url?: string; init?: RequestInit } = {};
  globalThis.fetch = async (input, init) => {
    observed = { url: String(input), init };
    return new Response(
      JSON.stringify({ schemaVersion: '1', source: sourceIdentity, timing: { totalMs: 8 } }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  };
  try {
    const adapter = httpAudioAnalysisProvider('https://analysis.test', TEST_ANALYSIS_TOKEN);
    const identity = await requestSourceFingerprint({
      sourceUrl: 'https://source.invalid/signed',
      sourceType: 'archive',
      provider: adapter,
      timeoutMs: 15_000,
    });
    assert.deepEqual(identity, sourceIdentity);
    assert.equal(observed.url, 'https://analysis.test/v1/fingerprint');
    assert.equal(
      new Headers(observed.init?.headers).get('authorization'),
      `Bearer ${TEST_ANALYSIS_TOKEN}`
    );
    assert.equal(observed.init?.redirect, 'manual');
    assert.deepEqual(JSON.parse(String(observed.init?.body)), {
      schemaVersion: '1',
      sourceUrl: 'https://source.invalid/signed',
      sourceType: 'archive',
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
  for (const [url, token] of [
    [' https://analysis.test', TEST_ANALYSIS_TOKEN],
    ['https://analysis.test ', TEST_ANALYSIS_TOKEN],
    ['https://analysis.test', `${TEST_ANALYSIS_TOKEN.slice(0, 16)} ${TEST_ANALYSIS_TOKEN.slice(16)}`],
  ]) {
    assert.equal(
      configuredAudioAnalysisProvider({
        AUDIO_ANALYSIS_URL: url,
        AUDIO_ANALYSIS_TOKEN: token,
      } as never),
      null
    );
  }
});
