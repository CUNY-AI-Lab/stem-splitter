#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

import {
  assertNoRailwayAudioAnalysisViolations,
  findRailwayAudioAnalysisDeployedOffViolations,
  findRailwayAudioAnalysisPreProvisionViolations,
  RAILWAY_AUDIO_ANALYSIS_GATE_SCHEMA,
  RAILWAY_AUDIO_ANALYSIS_SERVICE_NAME,
} from './lib/railway-audio-analysis-gate.mjs';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

function parseArgs(argv) {
  const supported = new Set(['--phase', '--project', '--environment', '--app-service']);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const candidate = argv[index + 1];
    if (!supported.has(name) || !candidate || candidate.startsWith('--')) {
      throw new Error(`invalid Railway analysis gate argument: ${name ?? '(missing)'}`);
    }
    if (Object.hasOwn(result, name)) throw new Error(`duplicate Railway gate argument: ${name}`);
    result[name] = candidate;
  }
  const phase = result['--phase'];
  if (!['pre-provision', 'deployed-off'].includes(phase)) {
    throw new Error('--phase must be pre-provision or deployed-off');
  }
  for (const name of ['--project', '--environment', '--app-service']) {
    if (!UUID.test(result[name] ?? '')) throw new Error(`${name} must be an explicit Railway UUID`);
  }
  return {
    phase,
    projectId: result['--project'],
    environmentId: result['--environment'],
    appServiceId: result['--app-service'],
  };
}

function railwayJson(args, label) {
  let output;
  try {
    output = execFileSync('railway', args, {
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    throw new Error(`${label} failed without exposing Railway output`);
  }
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function variables(projectId, environmentId, serviceId, label) {
  return railwayJson(
    [
      'variable',
      'list',
      '--project',
      projectId,
      '--environment',
      environmentId,
      '--service',
      serviceId,
      '--json',
    ],
    label
  );
}

const { phase, projectId, environmentId, appServiceId } = parseArgs(process.argv.slice(2));
const services = railwayJson(
  ['service', 'list', '--project', projectId, '--environment', environmentId, '--json'],
  'Railway service inventory'
);
const appVariables = variables(
  projectId,
  environmentId,
  appServiceId,
  'canonical app variable readback'
);

let analysisServiceId = null;
if (phase === 'pre-provision') {
  assertNoRailwayAudioAnalysisViolations(
    findRailwayAudioAnalysisPreProvisionViolations({ services, appServiceId, appVariables })
  );
} else {
  const matches = services.filter((service) => service?.name === RAILWAY_AUDIO_ANALYSIS_SERVICE_NAME);
  analysisServiceId = matches.length === 1 ? matches[0].id : null;
  const deployments = analysisServiceId
    ? railwayJson(
        [
          'deployment',
          'list',
          '--project',
          projectId,
          '--environment',
          environmentId,
          '--service',
          analysisServiceId,
          '--json',
        ],
        'audio-analysis deployment readback'
      )
    : [];
  const analysisVariables = analysisServiceId
    ? variables(
        projectId,
        environmentId,
        analysisServiceId,
        'audio-analysis variable readback'
      )
    : {};
  const limitsResponse = analysisServiceId
    ? railwayJson(
        [
          'api',
          'query Limits($serviceId: String!, $environmentId: String!) { serviceInstanceLimitOverride(serviceId: $serviceId, environmentId: $environmentId) }',
          '--raw-var',
          `serviceId=${analysisServiceId}`,
          '--raw-var',
          `environmentId=${environmentId}`,
          '--compact',
        ],
        'audio-analysis resource-limit readback'
      )
    : null;
  const limits = limitsResponse?.data?.serviceInstanceLimitOverride ?? null;
  assertNoRailwayAudioAnalysisViolations(
    findRailwayAudioAnalysisDeployedOffViolations({
      services,
      deployments,
      limits,
      appServiceId,
      appVariables,
      analysisVariables,
    })
  );
}

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: RAILWAY_AUDIO_ANALYSIS_GATE_SCHEMA,
      phase,
      projectId,
      environmentId,
      appServiceId,
      analysisService: analysisServiceId ?? 'absent',
      featurePosture: 'off',
      secretsPrinted: 0,
      mutations: 0,
      providerCalls: 0,
    },
    null,
    2
  )}\n`
);
