import assert from 'node:assert/strict';
import test from 'node:test';
import { flagEnabled, processingFeatureFlags } from '../src/features.ts';
import { getSeparationOptions } from '../src/separation/options.ts';

test('processing feature flags default off and only literal true enables them', () => {
  for (const value of [undefined, '', 'false', '0', 'TRUE', 'yes', ' true ']) {
    assert.equal(flagEnabled(value), false, `${String(value)} must fail closed`);
  }
  assert.equal(flagEnabled('true'), true);
});

test('server Auto master flag controls rollout mode and invalid modes fail closed', () => {
  assert.equal(processingFeatureFlags({ SERVER_AUTO_MODE: 'authoritative' }).serverAutoMode, 'off');
  assert.equal(
    processingFeatureFlags({ SERVER_AUTO_ENABLED: 'false', SERVER_AUTO_MODE: 'authoritative' })
      .serverAutoMode,
    'off'
  );
  assert.equal(processingFeatureFlags({ SERVER_AUTO_ENABLED: 'true' }).serverAutoMode, 'shadow');
  assert.equal(
    processingFeatureFlags({ SERVER_AUTO_ENABLED: 'true', SERVER_AUTO_MODE: 'shadow' }).serverAutoMode,
    'shadow'
  );
  assert.equal(
    processingFeatureFlags({ SERVER_AUTO_ENABLED: 'true', SERVER_AUTO_MODE: 'authoritative' })
      .serverAutoMode,
    'authoritative'
  );
  assert.equal(
    processingFeatureFlags({ SERVER_AUTO_ENABLED: 'true', SERVER_AUTO_MODE: 'unexpected' })
      .serverAutoMode,
    'off'
  );
});

test('discovery and isolation flags cannot change the frozen core catalogue', () => {
  const before = JSON.stringify(getSeparationOptions('replicate'));
  const flags = processingFeatureFlags({
    INSTRUMENT_DISCOVERY_ENABLED: 'true',
    QUERY_ISOLATION_ENABLED: 'true',
  });
  assert.equal(flags.instrumentDiscovery, true);
  assert.equal(flags.queryIsolation, true);
  assert.equal(JSON.stringify(getSeparationOptions('replicate')), before);
});
