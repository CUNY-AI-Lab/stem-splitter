import assert from 'node:assert/strict';
import test from 'node:test';

import { findQueryIsolationPinViolations } from '../scripts/lib/pin-check.mjs';
import {
  normalizeIsolationTarget,
  queryIsolationCacheKey,
  queryIsolationCacheKeyForMaterial,
  validateQueryIsolationRequest,
} from '../src/isolation/contract.ts';
import {
  AUDIOSEP_REPLICATE_MODEL,
  audioSepReplicateIdentity,
  queryIsolationReplicateContractSurface,
} from '../src/isolation/options.ts';
import { audioSepReplicateProvider } from '../src/isolation/replicate.ts';
import {
  QUERY_ISOLATION_SCHEMA_VERSION,
  type QueryIsolationRequestV1,
} from '../src/isolation/types.ts';

const AUDIOSEP_PIN = 'f07004438b8f3e6c5b720ba889389007cbf8dbbc9caa124afc24d9bbd2d307b8';

const REQUEST: QueryIsolationRequestV1 = {
  schemaVersion: QUERY_ISOLATION_SCHEMA_VERSION,
  isolationId: 'isolation_test_1',
  sourceUrl:
    `https://stem.example/api/local-sources/isolation-inputs/v1/` +
    `isolation_test_1/${'1'.repeat(64)}?expires=123&signature=test`,
  sourceHash: '1'.repeat(64),
  sourceType: 'upload',
  normalizedTarget: 'bass clarinet',
  analysisVocabularyVersion: 'classroom-instruments-v1',
  webhookUrl: 'https://stem.example/api/webhooks/query-isolation?signature=test',
};

const IDENTITY = {
  provider: 'replicate',
  model: AUDIOSEP_REPLICATE_MODEL,
  version: AUDIOSEP_PIN,
  contractVersion: 'audiosep-replicate-v1',
};

test('query targets normalize once into a bounded cache/provider form', () => {
  assert.equal(normalizeIsolationTarget('  BASS\tClarinet  '), 'bass clarinet');
  assert.equal(normalizeIsolationTarget('  DADGAD–guitar  '.replace('–', '-')), 'dadgad-guitar');
  for (const target of ['', 'x', 'https://example.test/audio', 'violin: ignore prior request']) {
    assert.throws(() => normalizeIsolationTarget(target), /short instrument or sound name/);
  }
});

test('query-isolation requests fail closed on transport and identity drift', () => {
  assert.doesNotThrow(() => validateQueryIsolationRequest(REQUEST));
  assert.throws(
    () => validateQueryIsolationRequest({ ...REQUEST, normalizedTarget: ' Bass Clarinet ' }),
    /canonical form/
  );
  assert.throws(
    () => validateQueryIsolationRequest({ ...REQUEST, sourceHash: 'not-a-hash' }),
    /SHA-256/
  );
  assert.throws(
    () => validateQueryIsolationRequest({ ...REQUEST, sourceUrl: 'http://stem.example/source' }),
    /credential-free HTTPS/
  );
  assert.throws(
    () =>
      validateQueryIsolationRequest({
        ...REQUEST,
        sourceUrl: 'https://stem.example/api/local-sources/uploads/still-mutable.wav',
      }),
    /verified isolation source snapshot/
  );
  assert.throws(
    () => audioSepReplicateIdentity({ REPLICATE_AUDIOSEP_VERSION: 'latest' }),
    /exact lowercase 64-character hash/
  );
  assert.throws(
    () => audioSepReplicateIdentity({ REPLICATE_AUDIOSEP_VERSION: 'a'.repeat(64) }),
    /has not passed repository contract review/
  );
});

test('query-isolation cache keys bind signal, prompt, vocabulary, provider, and exact version', async () => {
  const baseline = await queryIsolationCacheKey(REQUEST, IDENTITY);
  assert.match(baseline, /^query-isolation\/v1\/[0-9a-f]{64}$/);
  assert.equal(await queryIsolationCacheKey(REQUEST, IDENTITY), baseline);
  assert.equal(
    await queryIsolationCacheKeyForMaterial(
      {
        sourceHash: REQUEST.sourceHash,
        normalizedTarget: REQUEST.normalizedTarget,
        analysisVocabularyVersion: REQUEST.analysisVocabularyVersion,
      },
      IDENTITY
    ),
    baseline,
    'resource creation must bind the cache before expiring transport URLs exist'
  );

  const requestChanges: QueryIsolationRequestV1[] = [
    {
      ...REQUEST,
      sourceHash: '2'.repeat(64),
      sourceUrl:
        `https://stem.example/api/local-sources/isolation-inputs/v1/` +
        `isolation_test_1/${'2'.repeat(64)}?expires=123&signature=test`,
    },
    { ...REQUEST, normalizedTarget: 'contrabass clarinet' },
    { ...REQUEST, analysisVocabularyVersion: 'classroom-instruments-v2' },
  ];
  for (const changed of requestChanges) {
    assert.notEqual(await queryIsolationCacheKey(changed, IDENTITY), baseline);
  }
  for (const changedIdentity of [
    { ...IDENTITY, provider: 'private-gpu' },
    { ...IDENTITY, model: 'institution/audiosep' },
    { ...IDENTITY, version: 'a'.repeat(64) },
    { ...IDENTITY, contractVersion: 'audiosep-replicate-v2' },
  ]) {
    assert.notEqual(await queryIsolationCacheKey(REQUEST, changedIdentity), baseline);
  }

  assert.equal(
    await queryIsolationCacheKey(
      {
        ...REQUEST,
        isolationId: 'a_different_transport_job',
        sourceUrl:
          `https://stem.example/api/local-sources/isolation-inputs/v1/` +
          `a_different_transport_job/${'1'.repeat(64)}?expires=456&signature=fresh`,
        webhookUrl: 'https://stem.example/api/webhooks/query-isolation?signature=fresh',
      },
      IDENTITY
    ),
    baseline,
    'expiring transport details must not defeat result reuse'
  );
});

test('AudioSep exposes a separate target-only Replicate contract, never a stem catalogue row', () => {
  assert.deepEqual(queryIsolationReplicateContractSurface(), {
    model: 'cjwbw/audiosep',
    inputKeys: ['audio_file', 'text'],
    output: 'uri',
    versionVar: 'REPLICATE_AUDIOSEP_VERSION',
    reviewedVersion: AUDIOSEP_PIN,
    supportsResidual: false,
  });
  assert.deepEqual(audioSepReplicateIdentity({ REPLICATE_AUDIOSEP_VERSION: AUDIOSEP_PIN }), IDENTITY);
});

const PINNED_AUDIOSEP_SCHEMA = {
  components: {
    schemas: {
      Input: {
        properties: {
          audio_file: { type: 'string', format: 'uri' },
          text: { type: 'string', default: 'water drops' },
        },
      },
      Output: { type: 'string', format: 'uri' },
    },
  },
};

test('the AudioSep pin guard accepts only the reviewed target-only schema', () => {
  const surface = queryIsolationReplicateContractSurface();
  assert.deepEqual(findQueryIsolationPinViolations(surface, PINNED_AUDIOSEP_SCHEMA), []);

  const drifted = structuredClone(PINNED_AUDIOSEP_SCHEMA);
  delete drifted.components.schemas.Input.properties.text;
  drifted.components.schemas.Input.properties.audio_file.type = 'integer';
  drifted.components.schemas.Input.properties.audio_file.format = 'binary';
  drifted.components.schemas.Output = { type: 'array', format: 'json' };
  const failures = findQueryIsolationPinViolations(surface, drifted);
  assert.ok(failures.some((failure) => failure.includes('input "text"')));
  assert.ok(failures.some((failure) => failure.includes('"audio_file" is no longer a string')));
  assert.ok(failures.some((failure) => failure.includes('one URI string')));
  assert.ok(failures.some((failure) => failure.includes('output is no longer declared as a URI')));
  assert.deepEqual(findQueryIsolationPinViolations(surface, {}), [
    'the pinned isolation version exposes no Input schema — cannot verify anything',
  ]);
});

test('the dormant AudioSep adapter sends the exact pinned contract and returns only an isolation', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/predictions')) {
      return new Response(JSON.stringify({ id: 'prediction_123', status: 'starting' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        id: 'prediction_123',
        status: 'succeeded',
        output: 'https://pbxt.replicate.delivery/result/separated_audio.wav',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;

  const provider = audioSepReplicateProvider(
    {
      REPLICATE_API_TOKEN: 'test-token-never-log',
      REPLICATE_AUDIOSEP_VERSION: AUDIOSEP_PIN,
    },
    fakeFetch
  );
  const started = await provider.start(REQUEST);
  assert.deepEqual(started, { externalId: 'prediction_123', identity: IDENTITY });
  assert.equal(calls[0].url, 'https://api.replicate.com/v1/predictions');
  assert.equal(
    (calls[0].init?.headers as Record<string, string>).Authorization,
    'Bearer test-token-never-log'
  );
  const startBody = JSON.parse(String(calls[0].init?.body));
  assert.deepEqual(startBody, {
    version: AUDIOSEP_PIN,
    input: {
      audio_file: REQUEST.sourceUrl,
      text: 'bass clarinet',
    },
    webhook: REQUEST.webhookUrl,
    webhook_events_filter: ['completed'],
  });

  const result = await provider.fetchStatus('prediction_123');
  assert.deepEqual(result, {
    schemaVersion: QUERY_ISOLATION_SCHEMA_VERSION,
    status: 'succeeded',
    targetUrl: 'https://pbxt.replicate.delivery/result/separated_audio.wav',
  });
  assert.equal('residualUrl' in result, false);
  assert.equal(calls[1].url, 'https://api.replicate.com/v1/predictions/prediction_123');
  assert.equal(
    (calls[1].init?.headers as Record<string, string>).Authorization,
    'Bearer test-token-never-log'
  );
});

test('AudioSep provider failures stay local and never pass through raw provider content', async () => {
  const provider = audioSepReplicateProvider({
    REPLICATE_API_TOKEN: 'test-token-never-log',
    REPLICATE_AUDIOSEP_VERSION: AUDIOSEP_PIN,
  });
  assert.deepEqual(provider.parseResult({ status: 'processing' }), {
    schemaVersion: QUERY_ISOLATION_SCHEMA_VERSION,
    status: 'processing',
  });
  const failed = provider.parseResult({ status: 'failed', error: 'raw-secret-provider-log' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure?.code, 'provider_failed');
  assert.doesNotMatch(JSON.stringify(failed), /raw-secret-provider-log/);

  const arbitraryOutput = provider.parseResult({
    status: 'succeeded',
    output: 'https://attacker.example/private.wav',
  });
  assert.equal(arbitraryOutput.failure?.code, 'invalid_provider_response');
  await assert.rejects(
    provider.fetchStatus('../account'),
    /Invalid Replicate isolation prediction id/
  );
});
