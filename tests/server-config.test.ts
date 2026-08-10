import assert from 'node:assert/strict';
import test from 'node:test';

import {
  audioAnalysisStatus,
  runtimeConfigurationSummary,
  runtimeConfigurationWarnings,
  youtubeImportStatus,
} from '../server/config.ts';

const disabled = {
  REPLICATE_API_TOKEN: '',
  SERVER_AUTO_ENABLED: undefined,
  SERVER_AUTO_MODE: undefined,
  INSTRUMENT_DISCOVERY_ENABLED: undefined,
  QUERY_ISOLATION_ENABLED: undefined,
};
const ANALYSIS_TOKEN = 'analysis-test-token-000000000000000';

test('optional runtime services distinguish absent, incomplete, invalid, and configured state', () => {
  assert.equal(youtubeImportStatus(disabled), 'unconfigured');
  assert.equal(
    youtubeImportStatus({ ...disabled, REPLICATE_YT_MODEL: 'owner/model' }),
    'incomplete'
  );
  assert.equal(
    youtubeImportStatus({
      ...disabled,
      REPLICATE_API_TOKEN: 'token',
      REPLICATE_YT_MODEL: 'owner/model',
      REPLICATE_YT_MODEL_VERSION: 'latest',
    }),
    'invalid'
  );
  assert.equal(
    youtubeImportStatus({
      ...disabled,
      REPLICATE_API_TOKEN: 'token',
      REPLICATE_YT_MODEL: 'owner/model',
      REPLICATE_YT_MODEL_VERSION: 'a'.repeat(64),
    }),
    'configured'
  );
  for (const version of ['pinned-version-id', `${'a'.repeat(64)} `]) {
    assert.equal(
      youtubeImportStatus({
        ...disabled,
        REPLICATE_API_TOKEN: 'token',
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

test('authoritative Auto cannot look ready when its analyzer is absent', () => {
  const env = {
    ...disabled,
    SERVER_AUTO_ENABLED: 'true',
    SERVER_AUTO_MODE: 'authoritative',
  };
  assert.deepEqual(runtimeConfigurationSummary(env), {
    youtubeImport: 'unconfigured',
    audioAnalysis: 'unconfigured',
    serverAutoMode: 'authoritative',
    instrumentDiscovery: 'disabled',
    queryIsolation: 'disabled',
  });
  assert.ok(
    runtimeConfigurationWarnings(env).some((warning) =>
      warning.includes('Auto will use the explicit fallback')
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
