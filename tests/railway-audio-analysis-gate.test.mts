import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  assertNoRailwayAudioAnalysisViolations,
  findRailwayAudioAnalysisDeployedOffViolations,
  findRailwayAudioAnalysisPreProvisionViolations,
} from '../scripts/lib/railway-audio-analysis-gate.mjs';

const APP_ID = '11111111-1111-4111-8111-111111111111';
const ANALYSIS_ID = '22222222-2222-4222-8222-222222222222';
const DEPLOYMENT_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'private-analysis-token-0123456789abcdef';

function appVariables() {
  return {
    PUBLIC_BASE_URL: 'https://stem-splitter.example',
    REPLICATE_YT_MODEL_VERSION: 'a'.repeat(64),
    SERVER_AUTO_ENABLED: 'false',
    SERVER_AUTO_MODE: 'off',
    INSTRUMENT_DISCOVERY_ENABLED: 'false',
    QUERY_ISOLATION_ENABLED: 'false',
    QUERY_ISOLATION_MODE: 'off',
    AUDIO_ANALYSIS_URL: 'http://audio-analysis.railway.internal:8080',
    AUDIO_ANALYSIS_TOKEN: TOKEN,
    AUDIO_ANALYSIS_TIMEOUT_MS: '25000',
  };
}

function analysisVariables() {
  return {
    RAILWAY_PRIVATE_DOMAIN: 'audio-analysis.railway.internal',
    PORT: '8080',
    AUDIO_ANALYSIS_TOKEN: TOKEN,
    AUDIO_ANALYSIS_SOURCE_ORIGINS: 'https://stem-splitter.example',
    AUDIO_ANALYSIS_MAX_CONCURRENCY: '1',
    AUDIO_ANALYSIS_MAX_SOURCE_BYTES: '104857600',
    AUDIO_ANALYSIS_MAX_SOURCE_SECONDS: '900',
    AUDIO_ANALYSIS_FETCH_TIMEOUT_MS: '10000',
    AUDIO_ANALYSIS_DECODER_TIMEOUT_MS: '10000',
  };
}

function services({ includeAnalysis = true } = {}) {
  return [
    {
      id: APP_ID,
      name: 'stem-splitter',
      status: 'SUCCESS',
      latestDeployment: { status: 'SUCCESS' },
      url: 'https://stem-splitter.example',
      regions: [{ name: 'us-west2', configured: 1 }],
    },
    ...(includeAnalysis
      ? [
          {
            id: ANALYSIS_ID,
            name: 'audio-analysis',
            status: 'SUCCESS',
            deploymentId: DEPLOYMENT_ID,
            latestDeployment: { status: 'SUCCESS' },
            url: null,
            volumes: [],
            replicas: { configured: 1, running: 1, crashed: 0 },
            regions: [{ name: 'us-west2', configured: 1 }],
          },
        ]
      : []),
  ];
}

function deployments() {
  return [
    {
      id: DEPLOYMENT_ID,
      status: 'SUCCESS',
      meta: {
        rootDirectory: null,
        volumeMounts: [],
        serviceManifest: {
          build: {
            builder: 'DOCKERFILE',
            buildEnvironment: 'V3',
            dockerfilePath: 'audio-analysis/Dockerfile',
          },
          deploy: {
            healthcheckPath: '/readyz',
            healthcheckTimeout: 120,
            restartPolicyType: 'ON_FAILURE',
            restartPolicyMaxRetries: 3,
            sleepApplication: false,
            startCommand: null,
            preDeployCommand: null,
            cronSchedule: null,
            multiRegionConfig: { 'us-west2': { numReplicas: 1 } },
          },
        },
      },
    },
  ];
}

function deployedInput() {
  return {
    services: services(),
    deployments: deployments(),
    limits: { containers: { cpu: 1, memoryBytes: 1_000_000_000 } },
    appServiceId: APP_ID,
    appVariables: appVariables(),
    analysisVariables: analysisVariables(),
  };
}

test('pre-provision gate requires the canonical app, exact importer pin, flags off, and no analyzer', () => {
  const variables = appVariables();
  for (const name of [
    'SERVER_AUTO_ENABLED',
    'SERVER_AUTO_MODE',
    'INSTRUMENT_DISCOVERY_ENABLED',
    'QUERY_ISOLATION_ENABLED',
    'QUERY_ISOLATION_MODE',
    'AUDIO_ANALYSIS_URL',
    'AUDIO_ANALYSIS_TOKEN',
    'AUDIO_ANALYSIS_TIMEOUT_MS',
  ]) {
    delete variables[name];
  }
  assert.deepEqual(
    findRailwayAudioAnalysisPreProvisionViolations({
      services: services({ includeAnalysis: false }),
      appServiceId: APP_ID,
      appVariables: variables,
    }),
    []
  );
});

test('pre-provision gate rejects the wrong project surface, enabled flags, floating pins, and duplicates', () => {
  const variables = appVariables();
  variables.SERVER_AUTO_ENABLED = 'true';
  variables.REPLICATE_YT_MODEL_VERSION = 'latest';
  variables.REPLICATE_AUDIOSEP_VERSION = 'b'.repeat(64);
  variables.QUERY_ISOLATION_COURSE_ID = 'music-101';
  variables.AUDIO_ANALYSIS_URL = 'http://orphaned.railway.internal:8080';
  const failures = findRailwayAudioAnalysisPreProvisionViolations({
    services: [...services(), { ...services()[1], id: 'duplicate' }],
    appServiceId: 'missing',
    appVariables: variables,
  });
  assert.ok(failures.some((failure) => failure.includes('canonical app')));
  assert.ok(failures.some((failure) => failure.includes('already exists')));
  assert.ok(failures.some((failure) => failure.includes('64-hex')));
  assert.ok(failures.some((failure) => failure.includes('SERVER_AUTO_ENABLED')));
  assert.ok(failures.some((failure) => failure.includes('REPLICATE_AUDIOSEP_VERSION')));
  assert.ok(failures.some((failure) => failure.includes('QUERY_ISOLATION_COURSE_ID')));
  assert.ok(failures.some((failure) => failure.includes('AUDIO_ANALYSIS_URL')));
});

test('deployed-off gate accepts one private, capped, ready analyzer while every feature remains off', () => {
  const failures = findRailwayAudioAnalysisDeployedOffViolations(deployedInput());
  assert.deepEqual(failures, []);
  assert.doesNotThrow(() => assertNoRailwayAudioAnalysisViolations(failures));
});

test('deployed-off gate fails closed across topology, deployment, resources, tokens, and flags', () => {
  const mutations: Array<[string, (input: ReturnType<typeof deployedInput>) => void]> = [
    ['public domain', (input) => { input.services[1].url = 'https://analysis.example'; }],
    ['volume', (input) => { input.services[1].volumes = [{ mountPath: '/data' }]; }],
    ['healthcheck', (input) => {
      input.deployments[0].meta.serviceManifest.deploy.healthcheckPath = '/healthz';
    }],
    ['dockerfile', (input) => {
      input.deployments[0].meta.serviceManifest.build.dockerfilePath = 'Dockerfile.worker';
    }],
    ['restart', (input) => {
      input.deployments[0].meta.serviceManifest.deploy.restartPolicyMaxRetries = 10;
    }],
    ['resource cap', (input) => { input.limits.containers.memoryBytes = 8_000_000_000; }],
    ['region', (input) => { input.services[1].regions[0].name = 'us-east4'; }],
    ['token mismatch', (input) => { input.analysisVariables.AUDIO_ANALYSIS_TOKEN += 'x'; }],
    ['source origin', (input) => {
      input.analysisVariables.AUDIO_ANALYSIS_SOURCE_ORIGINS = 'https://other.example';
    }],
    ['private URL', (input) => {
      input.appVariables.AUDIO_ANALYSIS_URL = 'https://analysis.example';
    }],
    ['Auto enabled', (input) => { input.appVariables.SERVER_AUTO_ENABLED = 'true'; }],
    ['discovery staged', (input) => {
      input.analysisVariables.INSTRUMENT_DISCOVERY_URL =
        'http://instrument-discovery.railway.internal';
    }],
  ];
  for (const [label, mutate] of mutations) {
    const input = structuredClone(deployedInput());
    mutate(input);
    assert.notDeepEqual(
      findRailwayAudioAnalysisDeployedOffViolations(input),
      [],
      label
    );
  }
});

test('CLI wrapper uses explicit Railway IDs and never prints variable values', () => {
  const source = readFileSync('scripts/check-railway-audio-analysis.mjs', 'utf8');
  assert.match(source, /--project/);
  assert.match(source, /--environment/);
  assert.match(source, /--app-service/);
  assert.match(source, /secretsPrinted: 0/);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^)]*(?:appVariables|analysisVariables)/);
  assert.doesNotMatch(source, /JSON\.stringify\((?:appVariables|analysisVariables)/);
});
