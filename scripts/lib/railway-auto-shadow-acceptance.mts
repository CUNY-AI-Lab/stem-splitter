import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { PINNED_ROLE_CLASSIFIER_VERSION } from '../../src/analysis/types.ts';

export const RAILWAY_AUTO_SHADOW_ACCEPTANCE_SCHEMA =
  'stem-splitter.railway-auto-shadow-acceptance.v1' as const;
export const RAILWAY_AUTO_SHADOW_ACCEPTANCE_PATH =
  'docs/acceptance/2026-08-31-v3.2-railway-auto-shadow/evidence.json' as const;

const PROJECT_ID = 'f070742b-3375-4cba-9a86-335f39273c88';
const ENVIRONMENT_ID = 'b3381640-1e2f-4765-8e15-15baec599ec2';
const APP_SERVICE_ID = 'f53a2915-087c-493a-a345-7a1fa73e6588';
const ANALYZER_SERVICE_ID = 'f8e3b4a6-f370-4877-a6fb-64655e43ce25';
const PRODUCTION_BASE = 'https://stem-splitter-production-78b9.up.railway.app';
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CORE_STEMS = ['vocals', 'drums', 'bass', 'other'] as const;

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
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(`${context} drifted`);
  }
}

function pattern(value: unknown, expected: RegExp, context: string): string {
  if (typeof value !== 'string' || !expected.test(value)) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function positiveNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string' || new Date(value).toISOString() !== value) {
    throw new Error('Railway Auto shadow timestamp is invalid');
  }
  return value;
}

function validateJourney(
  value: unknown,
  expected: {
    sourceType: 'upload' | 'archive' | 'youtube';
    jobId: string;
    filename: string;
    choice: 'two' | 'four';
    recommendedCoreModel: 'vocals_instrumental' | 'htdemucs_ft';
  }
): void {
  const journey = object(
    value,
    [
      'sourceType', 'jobId', 'filename', 'status', 'separationModel',
      'expectedStems', 'actualStems', 'analysis',
    ],
    `${expected.sourceType} journey`
  );
  exact(journey.sourceType, expected.sourceType, `${expected.sourceType} source type`);
  exact(journey.jobId, expected.jobId, `${expected.sourceType} job`);
  pattern(journey.jobId, UUID, `${expected.sourceType} job`);
  exact(journey.filename, expected.filename, `${expected.sourceType} filename`);
  exact(journey.status, 'done', `${expected.sourceType} status`);
  exact(journey.separationModel, 'htdemucs_ft', `${expected.sourceType} separation model`);
  exact(journey.expectedStems, CORE_STEMS, `${expected.sourceType} expected stems`);
  exact(journey.actualStems, CORE_STEMS, `${expected.sourceType} actual stems`);

  const analysis = object(
    journey.analysis,
    [
      'roleClassifier', 'choice', 'recommendedCoreModel', 'shadowApplied',
      'degraded', 'degradedCode', 'totalMs', 'analyzedSeconds',
    ],
    `${expected.sourceType} analysis`
  );
  exact(analysis.roleClassifier, PINNED_ROLE_CLASSIFIER_VERSION, `${expected.sourceType} classifier`);
  exact(analysis.choice, expected.choice, `${expected.sourceType} choice`);
  exact(
    analysis.recommendedCoreModel,
    expected.recommendedCoreModel,
    `${expected.sourceType} recommendation`
  );
  exact(analysis.shadowApplied, false, `${expected.sourceType} shadow authority`);
  exact(analysis.degraded, false, `${expected.sourceType} degradation`);
  exact(analysis.degradedCode, null, `${expected.sourceType} degraded code`);
  positiveNumber(analysis.totalMs, `${expected.sourceType} total time`);
  positiveNumber(analysis.analyzedSeconds, `${expected.sourceType} analyzed seconds`);
}

function validateScreenshot(
  value: unknown,
  repositoryRoot: string,
  expected: { sourceType: string; jobId: string; path: string }
): void {
  const screenshot = object(value, ['sourceType', 'jobId', 'path', 'sha256'], 'shadow screenshot');
  exact(screenshot.sourceType, expected.sourceType, 'shadow screenshot source type');
  exact(screenshot.jobId, expected.jobId, 'shadow screenshot job');
  pattern(screenshot.jobId, UUID, 'shadow screenshot job');
  exact(screenshot.path, expected.path, 'shadow screenshot path');
  const expectedHash = pattern(screenshot.sha256, SHA256, 'shadow screenshot hash');
  const path = resolve(repositoryRoot, expected.path);
  if (statSync(path).size < 10_000) throw new Error('shadow screenshot is unexpectedly small');
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 3).toString('hex') !== 'ffd8ff') {
    throw new Error('shadow screenshot is not a JPEG');
  }
  exact(createHash('sha256').update(bytes).digest('hex'), expectedHash, 'shadow screenshot bytes');
}

export function validateRailwayAutoShadowAcceptance(
  value: unknown,
  repositoryRoot: string
): {
  capturedAt: string;
  restoreDeploymentId: string;
  jobIds: string[];
} {
  const evidence = object(
    value,
    [
      '$schema', 'status', 'capturedAt', 'source', 'railway', 'configuration',
      'journeys', 'fallback', 'audienceGuard', 'screenshots', 'metrics', 'safety',
    ],
    'Railway Auto shadow acceptance'
  );
  exact(evidence.$schema, RAILWAY_AUTO_SHADOW_ACCEPTANCE_SCHEMA, 'Railway Auto shadow schema');
  exact(evidence.status, 'passed', 'Railway Auto shadow status');
  const capturedAt = canonicalTimestamp(evidence.capturedAt);

  const source = object(evidence.source, ['commit', 'ci'], 'shadow source');
  const sourceCommit = pattern(source.commit, SHA1, 'shadow source commit');
  try {
    execFileSync('git', ['cat-file', '-e', `${sourceCommit}^{commit}`], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
  } catch {
    throw new Error('shadow source commit is unavailable');
  }
  const ci = object(source.ci, ['runId', 'headSha', 'conclusion', 'jobs'], 'shadow CI');
  pattern(ci.runId, /^[1-9][0-9]*$/, 'shadow CI run');
  exact(ci.headSha, sourceCommit, 'shadow CI commit');
  exact(ci.conclusion, 'success', 'shadow CI conclusion');
  exact(
    ci.jobs,
    ['Source gate', 'Pinned analysis image (native amd64)'],
    'shadow CI jobs'
  );

  const railway = object(
    evidence.railway,
    [
      'projectId', 'environmentId', 'appServiceId', 'analyzerServiceId',
      'analyzerDeploymentId', 'analyzerDeploymentStatus', 'shadowDeploymentId',
      'shadowTerminalStatus', 'shadowSuperseded', 'outageDeploymentId',
      'outageTerminalStatus', 'outageSuperseded', 'restoreDeploymentId',
      'restoreDeploymentStatus', 'privateHostname',
    ],
    'shadow Railway topology'
  );
  exact(railway.projectId, PROJECT_ID, 'shadow Railway project');
  exact(railway.environmentId, ENVIRONMENT_ID, 'shadow Railway environment');
  exact(railway.appServiceId, APP_SERVICE_ID, 'shadow app service');
  exact(railway.analyzerServiceId, ANALYZER_SERVICE_ID, 'shadow analyzer service');
  for (const key of [
    'analyzerDeploymentId', 'shadowDeploymentId', 'outageDeploymentId', 'restoreDeploymentId',
  ]) {
    pattern(railway[key], UUID, `shadow ${key}`);
  }
  exact(railway.analyzerDeploymentStatus, 'SUCCESS', 'shadow analyzer deployment status');
  exact(railway.shadowTerminalStatus, 'SUCCESS', 'shadow deployment terminal status');
  exact(railway.shadowSuperseded, true, 'shadow deployment supersession');
  exact(railway.outageTerminalStatus, 'SUCCESS', 'outage deployment terminal status');
  exact(railway.outageSuperseded, true, 'outage deployment supersession');
  exact(railway.restoreDeploymentStatus, 'SUCCESS', 'restore deployment status');
  exact(railway.privateHostname, 'audio-analysis.railway.internal', 'shadow private hostname');
  const restoreDeploymentId = railway.restoreDeploymentId as string;

  const configuration = object(
    evidence.configuration,
    [
      'productionBase', 'audioAnalysis', 'serverAutoEnabled', 'serverAutoMode',
      'instrumentDiscovery', 'instrumentDiscoveryUrlPresent', 'queryIsolationMode',
      'analyzerPrivateUrlRestored', 'catalogue',
    ],
    'shadow configuration'
  );
  exact(configuration.productionBase, PRODUCTION_BASE, 'shadow production base');
  exact(configuration.audioAnalysis, 'configured', 'shadow analyzer configuration');
  exact(configuration.serverAutoEnabled, true, 'shadow master flag');
  exact(configuration.serverAutoMode, 'shadow', 'shadow server mode');
  exact(configuration.instrumentDiscovery, 'disabled', 'shadow discovery flag');
  exact(configuration.instrumentDiscoveryUrlPresent, false, 'shadow discovery URL');
  exact(configuration.queryIsolationMode, 'off', 'shadow isolation mode');
  exact(configuration.analyzerPrivateUrlRestored, true, 'shadow private URL restore');
  exact(
    configuration.catalogue,
    ['vocals_instrumental', 'htdemucs_ft', 'htdemucs_6s'],
    'shadow core catalogue'
  );

  if (!Array.isArray(evidence.journeys) || evidence.journeys.length !== 3) {
    throw new Error('shadow journeys must contain upload, Archive, and YouTube');
  }
  const journeyExpectations = [
    {
      sourceType: 'upload' as const,
      jobId: '99e780fe-1a16-4a8e-b908-4955571f52b5',
      filename: 'v32-analyzer-restored.mp3',
      choice: 'four' as const,
      recommendedCoreModel: 'htdemucs_ft' as const,
    },
    {
      sourceType: 'archive' as const,
      jobId: 'a770fd04-694e-45f4-8aa3-125bff7d3403',
      filename: 'selene XIV - Stiff Hand',
      choice: 'four' as const,
      recommendedCoreModel: 'htdemucs_ft' as const,
    },
    {
      sourceType: 'youtube' as const,
      jobId: 'b09fac45-6f8f-4f48-96e3-a5da12d2931c',
      filename: 'Me at the zoo',
      choice: 'two' as const,
      recommendedCoreModel: 'vocals_instrumental' as const,
    },
  ];
  evidence.journeys.forEach((journey, index) => {
    validateJourney(journey, journeyExpectations[index]);
  });

  const fallback = object(
    evidence.fallback,
    [
      'jobId', 'filename', 'status', 'separationModel', 'actualStems',
      'analysisChoice', 'roleClassifier', 'degraded', 'degradedCode',
      'shadowApplied', 'restoreRetestJobId', 'restoreRetestPassed',
    ],
    'shadow fallback'
  );
  exact(fallback.jobId, '3f106bad-f416-4372-9195-a374d673cfdd', 'shadow fallback job');
  pattern(fallback.jobId, UUID, 'shadow fallback job');
  exact(fallback.filename, 'v32-analyzer-outage-fallback.mp3', 'shadow fallback filename');
  exact(fallback.status, 'done', 'shadow fallback status');
  exact(fallback.separationModel, 'htdemucs_ft', 'shadow fallback model');
  exact(fallback.actualStems, CORE_STEMS, 'shadow fallback stems');
  exact(fallback.analysisChoice, 'fallback', 'shadow fallback choice');
  exact(fallback.roleClassifier, 'not-run', 'shadow fallback classifier');
  exact(fallback.degraded, true, 'shadow fallback degraded state');
  exact(fallback.degradedCode, 'analysis_unavailable', 'shadow fallback code');
  exact(fallback.shadowApplied, false, 'shadow fallback authority');
  exact(fallback.restoreRetestJobId, journeyExpectations[0].jobId, 'shadow restore retest job');
  exact(fallback.restoreRetestPassed, true, 'shadow restore retest');

  const audienceGuard = object(
    evidence.audienceGuard,
    [
      'studentJobsChecked', 'sourceKeyPresent', 'sourceHashPresent',
      'isolationsPresent', 'vocabularyClassifierPresent',
      'instrumentDiscoveryPresent', 'browserVisibleInternalAnalysis',
      'publicUiCopyChanged',
    ],
    'shadow audience guard'
  );
  exact(audienceGuard.studentJobsChecked, 5, 'shadow student job count');
  for (const key of [
    'sourceKeyPresent', 'sourceHashPresent', 'isolationsPresent',
    'vocabularyClassifierPresent', 'instrumentDiscoveryPresent',
    'browserVisibleInternalAnalysis', 'publicUiCopyChanged',
  ]) {
    exact(audienceGuard[key], false, `shadow audience ${key}`);
  }

  if (!Array.isArray(evidence.screenshots) || evidence.screenshots.length !== 4) {
    throw new Error('shadow acceptance must bind four screenshots');
  }
  const screenshotExpectations = [
    {
      sourceType: 'upload',
      jobId: journeyExpectations[0].jobId,
      path: 'docs/acceptance/2026-08-31-v3.2-railway-auto-shadow/01-upload-restored-mixer.jpg',
    },
    {
      sourceType: 'archive',
      jobId: journeyExpectations[1].jobId,
      path: 'docs/acceptance/2026-08-31-v3.2-railway-auto-shadow/02-archive-shadow.jpg',
    },
    {
      sourceType: 'youtube',
      jobId: journeyExpectations[2].jobId,
      path: 'docs/acceptance/2026-08-31-v3.2-railway-auto-shadow/03-youtube-shadow-receipt.jpg',
    },
    {
      sourceType: 'outage-fallback',
      jobId: fallback.jobId as string,
      path: 'docs/acceptance/2026-08-31-v3.2-railway-auto-shadow/04-analysis-outage-fallback.jpg',
    },
  ];
  evidence.screenshots.forEach((screenshot, index) => {
    validateScreenshot(screenshot, repositoryRoot, screenshotExpectations[index]);
  });

  const metrics = object(
    evidence.metrics,
    [
      'windowHours', 'sampleRateSeconds', 'analyzerCpuMax',
      'analyzerMemoryMaxGb', 'withinConfiguredLimits',
      'appHttpRequestsSampled', 'appHttpErrors',
    ],
    'shadow metrics'
  );
  exact(metrics.windowHours, 1, 'shadow metrics window');
  exact(metrics.sampleRateSeconds, 30, 'shadow metrics sample rate');
  const cpuMax = positiveNumber(metrics.analyzerCpuMax, 'shadow analyzer CPU maximum');
  const memoryMaxGb = positiveNumber(metrics.analyzerMemoryMaxGb, 'shadow analyzer memory maximum');
  if (cpuMax > 1 || memoryMaxGb > 1) throw new Error('shadow analyzer exceeded configured limits');
  exact(metrics.withinConfiguredLimits, true, 'shadow metrics limit result');
  positiveNumber(metrics.appHttpRequestsSampled, 'shadow HTTP sample count');
  exact(metrics.appHttpErrors, 0, 'shadow HTTP error count');

  const safety = object(
    evidence.safety,
    ['secretsPrinted', 'instrumentDiscoveryProviderCalls', 'schemaMigrationRequired'],
    'shadow safety'
  );
  exact(safety.secretsPrinted, 0, 'shadow secret output');
  exact(safety.instrumentDiscoveryProviderCalls, 0, 'shadow discovery provider calls');
  exact(safety.schemaMigrationRequired, false, 'shadow schema rollback');

  return {
    capturedAt,
    restoreDeploymentId,
    jobIds: [...journeyExpectations.map(({ jobId }) => jobId), fallback.jobId as string],
  };
}

export function loadRailwayAutoShadowAcceptance(
  repositoryRoot: string,
  evidencePath: string = RAILWAY_AUTO_SHADOW_ACCEPTANCE_PATH
) {
  const value = JSON.parse(readFileSync(resolve(repositoryRoot, evidencePath), 'utf8')) as unknown;
  return validateRailwayAutoShadowAcceptance(value, repositoryRoot);
}
