import assert from 'node:assert/strict';
import test from 'node:test';

import {
  audioAnalysisStatus,
  audioSeparatorStatus,
  queryIsolationProviderStatus,
  replicateSeparationStatus,
  runtimeConfigurationSummary,
  runtimeConfigurationWarnings,
  separationBackendStatus,
  youtubeImportStatus,
} from '../server/config.ts';

const disabled = {
  REPLICATE_API_TOKEN: '',
  SERVER_AUTO_ENABLED: undefined,
  SERVER_AUTO_MODE: undefined,
  INSTRUMENT_DISCOVERY_ENABLED: undefined,
  QUERY_ISOLATION_ENABLED: undefined,
  QUERY_ISOLATION_MODE: undefined,
  REPLICATE_AUDIOSEP_VERSION: undefined,
  QUERY_ISOLATION_COURSE_ID: undefined,
  QUERY_ISOLATION_SEMESTER_ID: undefined,
  QUERY_ISOLATION_MAX_PROVIDER_STARTS: undefined,
};
const ANALYSIS_TOKEN = 'analysis-test-token-000000000000000';
const YOUTUBE_TOKEN = 'youtube-test-token-000000000';

test('optional runtime services distinguish absent, incomplete, invalid, and configured state', () => {
  assert.equal(youtubeImportStatus(disabled), 'unconfigured');
  assert.equal(
    youtubeImportStatus({ ...disabled, REPLICATE_YT_MODEL: 'owner/model' }),
    'incomplete'
  );
  assert.equal(
    youtubeImportStatus({
      ...disabled,
      REPLICATE_API_TOKEN: YOUTUBE_TOKEN,
      REPLICATE_YT_MODEL: 'owner/model',
      REPLICATE_YT_MODEL_VERSION: 'latest',
    }),
    'invalid'
  );
  assert.equal(
    youtubeImportStatus({
      ...disabled,
      REPLICATE_API_TOKEN: YOUTUBE_TOKEN,
      REPLICATE_YT_MODEL: 'owner/model',
      REPLICATE_YT_MODEL_VERSION: 'a'.repeat(64),
    }),
    'configured'
  );
  assert.equal(
    youtubeImportStatus({
      ...disabled,
      REPLICATE_API_TOKEN: 'token',
      REPLICATE_YT_MODEL: 'owner/model',
      REPLICATE_YT_MODEL_VERSION: 'a'.repeat(64),
    }),
    'invalid'
  );
  for (const version of ['pinned-version-id', `${'a'.repeat(64)} `]) {
    assert.equal(
      youtubeImportStatus({
        ...disabled,
        REPLICATE_API_TOKEN: YOUTUBE_TOKEN,
        REPLICATE_YT_MODEL: 'owner/model',
        REPLICATE_YT_MODEL_VERSION: version,
      }),
      'invalid'
    );
  }

  assert.equal(audioAnalysisStatus(disabled), 'unconfigured');
  assert.equal(
    audioAnalysisStatus({ ...disabled, AUDIO_ANALYSIS_URL: 'https://analysis.test' }),
    'incomplete'
  );
  assert.equal(
    audioAnalysisStatus({
      ...disabled,
      AUDIO_ANALYSIS_URL: 'file:///tmp/not-a-service',
      AUDIO_ANALYSIS_TOKEN: ANALYSIS_TOKEN,
    }),
    'invalid'
  );
  assert.equal(
    audioAnalysisStatus({
      ...disabled,
      AUDIO_ANALYSIS_URL: 'https://analysis.test',
      AUDIO_ANALYSIS_TOKEN: ANALYSIS_TOKEN,
    }),
    'configured'
  );
  for (const url of [
    'http://analysis.example',
    'https://user:password@analysis.test',
    'https://analysis.test/private',
  ]) {
    assert.equal(
      audioAnalysisStatus({
        ...disabled,
        AUDIO_ANALYSIS_URL: url,
        AUDIO_ANALYSIS_TOKEN: ANALYSIS_TOKEN,
      }),
      'invalid',
      url
    );
  }
  assert.equal(
    audioAnalysisStatus({
      ...disabled,
      AUDIO_ANALYSIS_URL: 'http://audio-analysis.railway.internal:8080',
      AUDIO_ANALYSIS_TOKEN: ANALYSIS_TOKEN,
    }),
    'configured'
  );
  assert.equal(
    audioAnalysisStatus({
      ...disabled,
      AUDIO_ANALYSIS_URL: 'https://analysis.test',
      AUDIO_ANALYSIS_TOKEN: 'too-short',
    }),
    'invalid'
  );
  for (const [url, token] of [
    [' https://analysis.test', ANALYSIS_TOKEN],
    ['https://analysis.test ', ANALYSIS_TOKEN],
    ['https://analysis.test', `${ANALYSIS_TOKEN.slice(0, 16)} ${ANALYSIS_TOKEN.slice(16)}`],
  ]) {
    assert.equal(
      audioAnalysisStatus({
        ...disabled,
        AUDIO_ANALYSIS_URL: url,
        AUDIO_ANALYSIS_TOKEN: token,
      }),
      'invalid'
    );
  }
});

test('query isolation accepts only the reviewed exact provider identity', () => {
  assert.equal(queryIsolationProviderStatus(disabled), 'unconfigured');
  assert.equal(
    queryIsolationProviderStatus({ ...disabled, REPLICATE_AUDIOSEP_VERSION: 'a'.repeat(64) }),
    'invalid'
  );
  assert.equal(
    queryIsolationProviderStatus({
      ...disabled,
      REPLICATE_AUDIOSEP_VERSION:
        'f07004438b8f3e6c5b720ba889389007cbf8dbbc9caa124afc24d9bbd2d307b8',
    }),
    'configured'
  );
});

test('authoritative Auto cannot look ready when its analyzer is absent', () => {
  const env = {
    ...disabled,
    SERVER_AUTO_ENABLED: 'true',
    SERVER_AUTO_MODE: 'authoritative',
  };
  assert.deepEqual(runtimeConfigurationSummary(env), {
    separationBackend: 'replicate',
    audioSeparator: 'unconfigured',
    replicateSeparation: 'unconfigured',
    youtubeImport: 'unconfigured',
    audioAnalysis: 'unconfigured',
    serverAutoMode: 'authoritative',
    instrumentDiscovery: 'disabled',
    queryIsolationMode: 'off',
    queryIsolationProvider: 'unconfigured',
    queryIsolationBudget: 'unconfigured',
  });
  assert.ok(
    runtimeConfigurationWarnings(env).some((warning) =>
      warning.includes('Auto will use the explicit fallback')
    )
  );
});

test('query isolation shadow reports missing fingerprint and provider dependencies', () => {
  const env = {
    ...disabled,
    QUERY_ISOLATION_ENABLED: 'true',
    QUERY_ISOLATION_MODE: 'shadow',
  };
  assert.equal(runtimeConfigurationSummary(env).queryIsolationMode, 'shadow');
  const warnings = runtimeConfigurationWarnings(env);
  assert.ok(warnings.some((warning) => warning.includes('source fingerprinting will be unavailable')));
  assert.ok(warnings.some((warning) => warning.includes('reviewed provider identity is unconfigured')));
});

test('query isolation budget configuration is additive and fails lazy', () => {
  const incomplete = { ...disabled, QUERY_ISOLATION_COURSE_ID: 'music-101' };
  assert.equal(runtimeConfigurationSummary(incomplete).queryIsolationBudget, 'incomplete');
  assert.ok(
    runtimeConfigurationWarnings(incomplete).some((warning) =>
      warning.includes('budget configuration is incomplete')
    )
  );
  const configured = {
    ...disabled,
    QUERY_ISOLATION_COURSE_ID: 'music-101',
    QUERY_ISOLATION_SEMESTER_ID: '2026-fall',
    QUERY_ISOLATION_MAX_PROVIDER_STARTS: '40',
  };
  assert.equal(runtimeConfigurationSummary(configured).queryIsolationBudget, 'configured');
  assert.equal(
    runtimeConfigurationWarnings(configured).some((warning) => warning.includes('budget')),
    false
  );
});

test('query isolation mode fails closed and a mode string alone is ignored', () => {
  assert.ok(
    runtimeConfigurationWarnings({ ...disabled, QUERY_ISOLATION_MODE: 'shadow' }).includes(
      'QUERY_ISOLATION_MODE=shadow is ignored unless QUERY_ISOLATION_ENABLED=true'
    )
  );
  const invalid = {
    ...disabled,
    QUERY_ISOLATION_ENABLED: 'true',
    QUERY_ISOLATION_MODE: 'teacher_beta',
  };
  assert.equal(runtimeConfigurationSummary(invalid).queryIsolationMode, 'off');
  assert.ok(
    runtimeConfigurationWarnings(invalid).includes(
      'QUERY_ISOLATION_MODE=teacher_beta is invalid; query isolation will remain off'
    )
  );
});

test('a mode string alone does not enable Auto and is called out as ignored', () => {
  const env = {
    ...disabled,
    SERVER_AUTO_ENABLED: 'false',
    SERVER_AUTO_MODE: 'authoritative',
  };
  assert.equal(runtimeConfigurationSummary(env).serverAutoMode, 'off');
  assert.ok(
    runtimeConfigurationWarnings(env).includes(
      'SERVER_AUTO_MODE=authoritative is ignored unless SERVER_AUTO_ENABLED=true'
    )
  );
});

const SEPARATOR_TOKEN = 'separator-test-token-000000000000000';
const REPLICATE_TOKEN = 'r8_separation_test_token_0000';

test('separation configuration reports backend and provider state without values', () => {
  assert.equal(separationBackendStatus(disabled), 'replicate');
  assert.equal(separationBackendStatus({ ...disabled, SEPARATION_BACKEND: 'failover' }), 'failover');
  assert.equal(separationBackendStatus({ ...disabled, SEPARATION_BACKEND: 'legion' }), 'invalid');

  assert.equal(audioSeparatorStatus(disabled), 'unconfigured');
  assert.equal(
    audioSeparatorStatus({ ...disabled, AUDIO_SEPARATOR_URL: 'https://separator.example.org' }),
    'incomplete'
  );
  for (const [url, token] of [
    ['http://separator.example.org', SEPARATOR_TOKEN],
    ['https://separator.example.org', 'short-token'],
    ['https://separator.example.org?token=x', SEPARATOR_TOKEN],
    ['not a url', SEPARATOR_TOKEN],
    ['https://separator.example.org', `${SEPARATOR_TOKEN} `],
  ]) {
    assert.equal(
      audioSeparatorStatus({ ...disabled, AUDIO_SEPARATOR_URL: url, AUDIO_SEPARATOR_TOKEN: token }),
      'invalid',
      `${url} / ${token.length}`
    );
  }
  assert.equal(
    audioSeparatorStatus({
      ...disabled,
      AUDIO_SEPARATOR_URL: 'https://separator.example.org',
      AUDIO_SEPARATOR_TOKEN: SEPARATOR_TOKEN,
    }),
    'configured'
  );
  // Loopback dev keeps its short local token, matching local-separator/service.py.
  assert.equal(
    audioSeparatorStatus({
      ...disabled,
      AUDIO_SEPARATOR_URL: 'http://127.0.0.1:8765',
      AUDIO_SEPARATOR_TOKEN: 'local-separator-token',
    }),
    'configured'
  );

  assert.equal(replicateSeparationStatus(disabled), 'unconfigured');
  assert.equal(
    replicateSeparationStatus({ ...disabled, REPLICATE_API_TOKEN: REPLICATE_TOKEN }),
    'incomplete'
  );
  assert.equal(
    replicateSeparationStatus({
      ...disabled,
      REPLICATE_API_TOKEN: REPLICATE_TOKEN,
      REPLICATE_MODEL_VERSION: 'latest',
    }),
    'invalid'
  );
  assert.equal(
    replicateSeparationStatus({
      ...disabled,
      REPLICATE_API_TOKEN: REPLICATE_TOKEN,
      REPLICATE_MODEL_VERSION: 'b'.repeat(64),
    }),
    'configured'
  );
});

test('a half-configured failover warns and never echoes its secrets', () => {
  const env = {
    ...disabled,
    SEPARATION_BACKEND: 'failover',
    AUDIO_SEPARATOR_URL: 'https://separator.example.org',
    AUDIO_SEPARATOR_TOKEN: 'short-but-secret-value',
  };
  const summary = runtimeConfigurationSummary(env);
  assert.equal(summary.separationBackend, 'failover');
  assert.equal(summary.audioSeparator, 'invalid');
  const warnings = runtimeConfigurationWarnings(env);
  assert.ok(warnings.some((warning) => warning.includes('failover will send every split to Replicate')));
  assert.ok(warnings.some((warning) => warning.includes('Replicate separation configuration is unconfigured')));
  const shipped = JSON.stringify({ summary, warnings });
  assert.ok(!shipped.includes('separator.example.org'));
  assert.ok(!shipped.includes('short-but-secret-value'));

  const ready = {
    ...env,
    AUDIO_SEPARATOR_TOKEN: SEPARATOR_TOKEN,
    REPLICATE_API_TOKEN: REPLICATE_TOKEN,
    REPLICATE_MODEL_VERSION: 'b'.repeat(64),
  };
  assert.deepEqual(
    runtimeConfigurationWarnings(ready).filter((warning) => /separat/i.test(warning)),
    []
  );
});
