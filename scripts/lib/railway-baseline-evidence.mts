import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getSeparationOptions } from '../../src/separation/options.ts';

export const RAILWAY_ROLLBACK_BASELINE_PATH =
  'docs/acceptance/2026-08-09-v3.2-rollback-baseline/baseline.json' as const;
export const RAILWAY_ROLLBACK_BASELINE_SOURCE_PATH =
  'tests/corpus/audio/electronic-stiff-hand.mp3' as const;
export const RAILWAY_ROLLBACK_BASELINE_SHA256 =
  'e2369d661e0e0ee11072e5d6877171ce9ec894aab6398e404beb409368dd4827' as const;

const CORPUS_PATH = 'tests/corpus/corpus.json';
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const CANONICAL_BASE = 'https://stem-splitter-production-78b9.up.railway.app';
const CANONICAL_PROJECT_ID = 'f070742b-3375-4cba-9a86-335f39273c88';
const CANONICAL_ENVIRONMENT_ID = 'b3381640-1e2f-4765-8e15-15baec599ec2';
const CANONICAL_APP_SERVICE_ID = 'f53a2915-087c-493a-a345-7a1fa73e6588';

type RecordValue = Record<string, unknown>;

export interface RailwayRollbackBaselineSummary {
  schemaVersion: '1';
  artifactSha256: string;
  corpusSlug: string;
  sourceSha256: string;
  sourceBytesVerified: boolean;
  deploymentId: string;
  deployedCommit: string;
  imageDigest: string;
  providerVersion: string;
  latencyMs: number;
  stemHashes: string[];
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function object(value: unknown, keys: readonly string[], context: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  const record = value as RecordValue;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${context} does not match the baseline schema`);
  }
  return record;
}

function string(value: unknown, pattern: RegExp, context: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${context} must be a positive integer`);
  }
  return Number(value);
}

function timestamp(value: unknown, context: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`${context} is invalid`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${context} is invalid`);
  return parsed;
}

function exactStringArray(value: unknown, expected: readonly string[], context: string): string[] {
  if (!Array.isArray(value) || JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(`${context} drifted from the frozen contract`);
  }
  return [...expected];
}

function corpusEvidence(value: unknown, source: RecordValue): { slug: string; sourceSha256: string } {
  const corpus = object(value, ['$comment', 'sources'], 'corpus');
  if (!Array.isArray(corpus.sources)) throw new Error('corpus sources are invalid');
  const filename = string(source.filename, SAFE_FILENAME, 'baseline source filename');
  const sourceSha256 = string(source.sha256, SHA256, 'baseline source SHA-256');
  const match = corpus.sources.find((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const row = candidate as RecordValue;
    const provenance = row.provenance as RecordValue | undefined;
    return (
      row.kind === 'file' &&
      row.source === RAILWAY_ROLLBACK_BASELINE_SOURCE_PATH &&
      row.source === `tests/corpus/audio/${filename}` &&
      provenance?.contentSha256 === sourceSha256
    );
  }) as RecordValue | undefined;
  if (!match) throw new Error('baseline source is not pinned in the authorized corpus');
  const provenance = match.provenance as RecordValue;
  if (
    typeof match.slug !== 'string' ||
    !Array.isArray(match.manualChecks) ||
    match.manualChecks.length === 0 ||
    typeof provenance.license !== 'string' ||
    !provenance.license.startsWith('CC ')
  ) {
    throw new Error('baseline corpus row lacks review or license evidence');
  }
  return { slug: match.slug, sourceSha256 };
}

export function validateRailwayRollbackBaseline(
  value: unknown,
  corpusValue: unknown,
  sourceBytes?: Uint8Array
): RailwayRollbackBaselineSummary {
  const baseline = object(
    value,
    ['schemaVersion', 'capturedAt', 'base', 'health', 'catalogue', 'source', 'job', 'stems', 'railway', 'provider'],
    'baseline'
  );
  if (baseline.schemaVersion !== '1') throw new Error('baseline schema version drifted');
  if (baseline.base !== CANONICAL_BASE) throw new Error('baseline origin is not canonical');

  const health = object(baseline.health, ['ok', 'base', 'promptSchema'], 'baseline health');
  if (health.ok !== true || health.base !== CANONICAL_BASE || health.promptSchema !== 'ready') {
    throw new Error('baseline health evidence is invalid');
  }

  const expectedModel = getSeparationOptions('replicate').models.find(
    (model) => model.id === 'htdemucs_ft'
  );
  if (!expectedModel) throw new Error('frozen four-track model is unavailable');
  const catalogue = object(
    baseline.catalogue,
    ['backend', 'defaultModel', 'model'],
    'baseline catalogue'
  );
  const model = object(catalogue.model, ['id', 'stems', 'engine'], 'baseline model');
  if (
    catalogue.backend !== 'replicate' ||
    catalogue.defaultModel !== expectedModel.id ||
    model.id !== expectedModel.id ||
    model.engine !== expectedModel.engine
  ) {
    throw new Error('baseline catalogue drifted from the Replicate default');
  }
  const expectedStems = exactStringArray(model.stems, expectedModel.stems, 'baseline model stems');

  const source = object(baseline.source, ['filename', 'bytes', 'sha256'], 'baseline source');
  const sourceSize = positiveInteger(source.bytes, 'baseline source bytes');
  const corpus = corpusEvidence(corpusValue, source);
  const sourceBytesVerified = sourceBytes !== undefined;
  if (
    sourceBytes !== undefined &&
    (sourceBytes.byteLength !== sourceSize || sha256(sourceBytes) !== corpus.sourceSha256)
  ) {
    throw new Error('hydrated baseline source bytes drifted');
  }

  const job = object(
    baseline.job,
    ['id', 'model', 'status', 'expectedStems', 'startedAt', 'completedAt', 'latencyMs'],
    'baseline job'
  );
  string(job.id, UUID, 'baseline job id');
  if (job.model !== expectedModel.id || job.status !== 'done') {
    throw new Error('baseline job did not complete the frozen default');
  }
  exactStringArray(job.expectedStems, expectedStems, 'baseline job stems');
  const startedAt = timestamp(job.startedAt, 'baseline job startedAt');
  const completedAt = timestamp(job.completedAt, 'baseline job completedAt');
  const capturedAt = timestamp(baseline.capturedAt, 'baseline capturedAt');
  const latencyMs = positiveInteger(job.latencyMs, 'baseline job latency');
  if (completedAt <= startedAt || completedAt - startedAt !== latencyMs || capturedAt !== completedAt) {
    throw new Error('baseline job timing evidence is inconsistent');
  }

  if (!Array.isArray(baseline.stems) || baseline.stems.length !== expectedStems.length) {
    throw new Error('baseline stem evidence is incomplete');
  }
  const stemHashes = baseline.stems.map((candidate, index) => {
    const stem = object(candidate, ['name', 'bytes', 'sha256'], `baseline stem ${index}`);
    if (stem.name !== expectedStems[index]) throw new Error('baseline stem order drifted');
    const bytes = positiveInteger(stem.bytes, `baseline stem ${index} bytes`);
    if (bytes < 1024 || bytes > 100 * 1024 * 1024) {
      throw new Error('baseline stem size is outside the accepted audio boundary');
    }
    return string(stem.sha256, SHA256, `baseline stem ${index} SHA-256`);
  });
  if (new Set(stemHashes).size !== stemHashes.length) {
    throw new Error('baseline stems do not have distinct hashes');
  }

  const railway = object(
    baseline.railway,
    [
      'projectId',
      'environmentId',
      'serviceId',
      'deploymentId',
      'deployedCommit',
      'imageDigest',
      'evidenceScope',
    ],
    'baseline Railway evidence'
  );
  if (
    railway.projectId !== CANONICAL_PROJECT_ID ||
    railway.environmentId !== CANONICAL_ENVIRONMENT_ID ||
    railway.serviceId !== CANONICAL_APP_SERVICE_ID ||
    railway.evidenceScope !== 'explicit-railway-readback'
  ) {
    throw new Error('baseline Railway scope is not canonical');
  }
  const deploymentId = string(railway.deploymentId, UUID, 'baseline deployment id');
  const deployedCommit = string(railway.deployedCommit, COMMIT, 'baseline deployed commit');
  const imageDigest = string(railway.imageDigest, IMAGE_DIGEST, 'baseline image digest');

  const provider = object(
    baseline.provider,
    ['separation', 'youtubeConfigPlane'],
    'baseline provider evidence'
  );
  const separation = object(
    provider.separation,
    ['backend', 'version', 'evidenceScope'],
    'baseline separation provider'
  );
  if (separation.backend !== 'replicate' || separation.evidenceScope !== 'railway-config-plane') {
    throw new Error('baseline separation provider evidence is invalid');
  }
  const providerVersion = string(
    separation.version,
    SHA256,
    'baseline separation provider version'
  );
  const youtube = object(
    provider.youtubeConfigPlane,
    ['model', 'stagedVersion', 'evidenceScope'],
    'baseline YouTube provider'
  );
  if (
    youtube.model !== 'milwrite/yt-audio' ||
    youtube.evidenceScope !== 'staged-not-running'
  ) {
    throw new Error('baseline YouTube provider evidence is invalid');
  }
  string(youtube.stagedVersion, SHA256, 'baseline staged YouTube version');

  return {
    schemaVersion: '1',
    artifactSha256: RAILWAY_ROLLBACK_BASELINE_SHA256,
    corpusSlug: corpus.slug,
    sourceSha256: corpus.sourceSha256,
    sourceBytesVerified,
    deploymentId,
    deployedCommit,
    imageDigest,
    providerVersion,
    latencyMs,
    stemHashes,
  };
}

export function loadRailwayRollbackBaselineEvidence(
  repositoryRoot: string
): RailwayRollbackBaselineSummary {
  const artifactPath = resolve(repositoryRoot, RAILWAY_ROLLBACK_BASELINE_PATH);
  const artifactBytes = readFileSync(artifactPath);
  if (sha256(artifactBytes) !== RAILWAY_ROLLBACK_BASELINE_SHA256) {
    throw new Error('Railway rollback baseline artifact hash drifted');
  }
  const corpusValue = JSON.parse(readFileSync(resolve(repositoryRoot, CORPUS_PATH), 'utf8')) as unknown;
  const sourcePath = resolve(repositoryRoot, RAILWAY_ROLLBACK_BASELINE_SOURCE_PATH);
  const sourceBytes = existsSync(sourcePath) ? readFileSync(sourcePath) : undefined;
  return validateRailwayRollbackBaseline(
    JSON.parse(artifactBytes.toString('utf8')) as unknown,
    corpusValue,
    sourceBytes
  );
}
