import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AUDIO_ANALYSIS_SOURCE_SCOPE_VERSION } from '../../src/analysis/source-scope.ts';
import { PINNED_ROLE_CLASSIFIER_VERSION } from '../../src/analysis/types.ts';
import { loadRailwayRollbackBaselineEvidence } from './railway-baseline-evidence.mts';

export const RAILWAY_AUDIO_ANALYSIS_ACCEPTANCE_SCHEMA =
  'stem-splitter.railway-audio-analysis-acceptance.v1' as const;
export const RAILWAY_AUDIO_ANALYSIS_ACCEPTANCE_PATH =
  'docs/acceptance/2026-08-31-v3.2-railway-audio-analysis/evidence.json' as const;

const PROJECT_ID = 'f070742b-3375-4cba-9a86-335f39273c88';
const ENVIRONMENT_ID = 'b3381640-1e2f-4765-8e15-15baec599ec2';
const APP_SERVICE_ID = 'f53a2915-087c-493a-a345-7a1fa73e6588';
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

type RecordValue = Record<string, unknown>;

function object(value: unknown, keys: readonly string[], context: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  const candidate = value as RecordValue;
  if (
    Object.keys(candidate).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(candidate, key))
  ) {
    throw new Error(`${context} does not match the acceptance schema`);
  }
  return candidate;
}

function exact(value: unknown, expected: unknown, context: string): void {
  if (value !== expected) throw new Error(`${context} drifted`);
}

function pattern(value: unknown, expected: RegExp, context: string): string {
  if (typeof value !== 'string' || !expected.test(value)) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string' || new Date(value).toISOString() !== value) {
    throw new Error('Railway analyzer acceptance timestamp is invalid');
  }
  return value;
}

function positiveNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

export function validateRailwayAudioAnalysisAcceptance(
  value: unknown,
  repositoryRoot: string
): {
  capturedAt: string;
  sourceCommit: string;
  analyzerServiceId: string;
  restartDeploymentId: string;
  offDeploymentId: string;
} {
  const evidence = object(
    value,
    ['$schema', 'status', 'capturedAt', 'source', 'railway', 'runtime', 'rollback', 'safety'],
    'Railway analyzer acceptance'
  );
  exact(evidence.$schema, RAILWAY_AUDIO_ANALYSIS_ACCEPTANCE_SCHEMA, 'Railway analyzer acceptance schema');
  exact(evidence.status, 'passed', 'Railway analyzer acceptance status');
  const capturedAt = canonicalTimestamp(evidence.capturedAt);

  const source = object(evidence.source, ['commit', 'ci', 'testAudio'], 'acceptance source');
  const sourceCommit = pattern(source.commit, COMMIT, 'acceptance source commit');
  try {
    execFileSync('git', ['cat-file', '-e', `${sourceCommit}^{commit}`], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
  } catch {
    throw new Error('acceptance source commit is unavailable');
  }
  const ci = object(source.ci, ['runId', 'conclusion'], 'acceptance CI');
  pattern(ci.runId, /^[1-9][0-9]*$/, 'acceptance CI run');
  exact(ci.conclusion, 'success', 'acceptance CI conclusion');
  const testAudio = object(
    source.testAudio,
    ['baselineArtifact', 'bytes', 'sha256'],
    'acceptance test audio'
  );
  exact(
    testAudio.baselineArtifact,
    'docs/acceptance/2026-08-09-v3.2-rollback-baseline/baseline.json',
    'acceptance baseline artifact'
  );
  const baseline = loadRailwayRollbackBaselineEvidence(repositoryRoot);
  exact(testAudio.bytes, baseline.sourceBytes, 'acceptance source bytes');
  exact(testAudio.sha256, baseline.sourceSha256, 'acceptance source hash');
  pattern(testAudio.sha256, SHA256, 'acceptance source hash');

  const railway = object(
    evidence.railway,
    [
      'projectId', 'environmentId', 'appServiceId', 'analyzerServiceId',
      'analyzerServiceName', 'initialDeploymentId', 'initialDeploymentStatus',
      'restartDeploymentId', 'restartDeploymentStatus', 'privateHostname',
      'publicDomain', 'volumeCount', 'region', 'replicas', 'dockerfilePath',
      'healthcheckPath', 'healthcheckTimeoutSeconds', 'restartPolicy',
      'restartRetries', 'limits',
    ],
    'acceptance Railway topology'
  );
  exact(railway.projectId, PROJECT_ID, 'acceptance Railway project');
  exact(railway.environmentId, ENVIRONMENT_ID, 'acceptance Railway environment');
  exact(railway.appServiceId, APP_SERVICE_ID, 'acceptance Railway app service');
  const analyzerServiceId = pattern(railway.analyzerServiceId, UUID, 'acceptance analyzer service');
  exact(railway.analyzerServiceName, 'audio-analysis', 'acceptance analyzer name');
  pattern(railway.initialDeploymentId, UUID, 'acceptance initial deployment');
  exact(railway.initialDeploymentStatus, 'SUCCESS', 'acceptance initial deployment status');
  const restartDeploymentId = pattern(
    railway.restartDeploymentId,
    UUID,
    'acceptance restart deployment'
  );
  exact(railway.restartDeploymentStatus, 'SUCCESS', 'acceptance restart deployment status');
  exact(railway.privateHostname, 'audio-analysis.railway.internal', 'acceptance private hostname');
  exact(railway.publicDomain, null, 'acceptance analyzer public domain');
  exact(railway.volumeCount, 0, 'acceptance analyzer volume count');
  exact(railway.region, 'us-west2', 'acceptance analyzer region');
  exact(railway.replicas, 1, 'acceptance analyzer replicas');
  exact(railway.dockerfilePath, 'audio-analysis/Dockerfile', 'acceptance Dockerfile');
  exact(railway.healthcheckPath, '/readyz', 'acceptance healthcheck path');
  exact(railway.healthcheckTimeoutSeconds, 120, 'acceptance healthcheck timeout');
  exact(railway.restartPolicy, 'ON_FAILURE', 'acceptance restart policy');
  exact(railway.restartRetries, 3, 'acceptance restart retries');
  const limits = object(railway.limits, ['vcpus', 'memoryBytes'], 'acceptance limits');
  exact(limits.vcpus, 1, 'acceptance CPU limit');
  exact(limits.memoryBytes, 1_000_000_000, 'acceptance memory limit');

  const runtime = object(
    evidence.runtime,
    ['readiness', 'authorization', 'sourceScope', 'realAudio', 'metrics'],
    'acceptance runtime'
  );
  const readiness = object(
    runtime.readiness,
    ['status', 'ffmpegVersion', 'classifierVersion', 'sourceScopeVersion', 'instrumentDiscovery'],
    'acceptance readiness'
  );
  exact(readiness.status, 200, 'acceptance readiness status');
  exact(readiness.ffmpegVersion, '8.0.3', 'acceptance FFmpeg version');
  exact(readiness.classifierVersion, PINNED_ROLE_CLASSIFIER_VERSION, 'acceptance classifier');
  exact(readiness.sourceScopeVersion, AUDIO_ANALYSIS_SOURCE_SCOPE_VERSION, 'acceptance source scope');
  exact(readiness.instrumentDiscovery, 'unconfigured', 'acceptance discovery posture');
  const authorization = object(
    runtime.authorization,
    ['unauthenticatedStatus', 'authenticatedMalformedStatus'],
    'acceptance authorization'
  );
  exact(authorization.unauthenticatedStatus, 401, 'acceptance unauthenticated response');
  exact(authorization.authenticatedMalformedStatus, 400, 'acceptance authenticated malformed response');
  const sourceScope = object(runtime.sourceScope, ['rejectedPathStatus', 'error'], 'acceptance source scope');
  exact(sourceScope.rejectedPathStatus, 400, 'acceptance rejected source status');
  exact(sourceScope.error, 'source_url_not_scoped', 'acceptance rejected source error');
  const realAudio = object(
    runtime.realAudio,
    [
      'status', 'choice', 'resolvedCoreModel', 'degraded', 'analyzedSeconds',
      'sourceBytes', 'sourceSha256Verified', 'restartRetestPassed',
    ],
    'acceptance real audio'
  );
  exact(realAudio.status, 200, 'acceptance real-audio status');
  exact(realAudio.choice, 'four', 'acceptance real-audio choice');
  exact(realAudio.resolvedCoreModel, 'htdemucs_ft', 'acceptance real-audio model');
  exact(realAudio.degraded, false, 'acceptance real-audio degradation');
  exact(realAudio.analyzedSeconds, 45, 'acceptance analyzed seconds');
  exact(realAudio.sourceBytes, baseline.sourceBytes, 'acceptance analyzed source bytes');
  exact(realAudio.sourceSha256Verified, true, 'acceptance source hash verification');
  exact(realAudio.restartRetestPassed, true, 'acceptance restart retest');
  const metrics = object(
    runtime.metrics,
    ['sampleRateSeconds', 'cpuMax', 'memoryMaxGb', 'withinConfiguredLimits'],
    'acceptance metrics'
  );
  exact(metrics.sampleRateSeconds, 30, 'acceptance metrics sample rate');
  const cpuMax = positiveNumber(metrics.cpuMax, 'acceptance CPU maximum');
  const memoryMaxGb = positiveNumber(metrics.memoryMaxGb, 'acceptance memory maximum');
  if (cpuMax > 1 || memoryMaxGb > 1) throw new Error('acceptance runtime exceeded configured limits');
  exact(metrics.withinConfiguredLimits, true, 'acceptance metrics limit result');

  const rollback = object(
    evidence.rollback,
    [
      'shadowDeploymentId', 'shadowTerminalStatus', 'shadowMode',
      'shadowRoutingAdvertised', 'offDeploymentId', 'offTerminalStatus',
      'offMode', 'offRoutingAdvertised', 'providerCalls',
    ],
    'acceptance rollback'
  );
  pattern(rollback.shadowDeploymentId, UUID, 'acceptance shadow deployment');
  exact(rollback.shadowTerminalStatus, 'SUCCESS', 'acceptance shadow deployment status');
  exact(rollback.shadowMode, 'shadow', 'acceptance shadow mode');
  exact(rollback.shadowRoutingAdvertised, true, 'acceptance shadow routing advertisement');
  const offDeploymentId = pattern(rollback.offDeploymentId, UUID, 'acceptance off deployment');
  exact(rollback.offTerminalStatus, 'SUCCESS', 'acceptance off deployment status');
  exact(rollback.offMode, 'off', 'acceptance off mode');
  exact(rollback.offRoutingAdvertised, false, 'acceptance off routing advertisement');
  exact(rollback.providerCalls, 0, 'acceptance rollback provider calls');

  const safety = object(
    evidence.safety,
    ['publicDomainCreated', 'persistentVolumeCreated', 'secretsPrinted'],
    'acceptance safety'
  );
  exact(safety.publicDomainCreated, false, 'acceptance public-domain safety');
  exact(safety.persistentVolumeCreated, false, 'acceptance volume safety');
  exact(safety.secretsPrinted, 0, 'acceptance secret-output safety');

  return { capturedAt, sourceCommit, analyzerServiceId, restartDeploymentId, offDeploymentId };
}

export function loadRailwayAudioAnalysisAcceptance(
  repositoryRoot: string,
  evidencePath: string = RAILWAY_AUDIO_ANALYSIS_ACCEPTANCE_PATH
) {
  const value = JSON.parse(readFileSync(resolve(repositoryRoot, evidencePath), 'utf8')) as unknown;
  return validateRailwayAudioAnalysisAcceptance(value, repositoryRoot);
}
