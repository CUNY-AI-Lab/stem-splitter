import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  RAILWAY_ROLLBACK_BASELINE_PATH,
  RAILWAY_ROLLBACK_BASELINE_SHA256,
  RAILWAY_ROLLBACK_BASELINE_SOURCE_PATH,
  loadRailwayRollbackBaselineEvidence,
  validateRailwayRollbackBaseline,
} from '../scripts/lib/railway-baseline-evidence.mts';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');
const CORPUS_PATH = resolve(REPOSITORY_ROOT, 'tests/corpus/corpus.json');
const ARTIFACT_PATH = resolve(REPOSITORY_ROOT, RAILWAY_ROLLBACK_BASELINE_PATH);
const SOURCE_PATH = resolve(REPOSITORY_ROOT, RAILWAY_ROLLBACK_BASELINE_SOURCE_PATH);

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function rawBaseline(): Record<string, any> {
  return JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8'));
}

function rawCorpus(): Record<string, any> {
  return JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));
}

function hydratedSource(): Buffer | undefined {
  return existsSync(SOURCE_PATH) ? readFileSync(SOURCE_PATH) : undefined;
}

test('the promotion manifest binds the immutable authorized Railway rollback baseline', () => {
  const artifactBytes = readFileSync(ARTIFACT_PATH);
  assert.equal(sha256(artifactBytes), RAILWAY_ROLLBACK_BASELINE_SHA256);

  const summary = loadRailwayRollbackBaselineEvidence(REPOSITORY_ROOT);
  assert.equal(summary.artifactSha256, RAILWAY_ROLLBACK_BASELINE_SHA256);
  assert.equal(summary.corpusSlug, 'electronic-stiff-hand');
  assert.equal(
    summary.sourceSha256,
    'a929ec6515ecc915111d2de59acb9ff81d53a6194f2a551775859b0d291cd658'
  );
  assert.equal(summary.sourceBytesVerified, existsSync(SOURCE_PATH));
  assert.equal(summary.latencyMs, 42_738);
  assert.equal(summary.stemHashes.length, 4);
  assert.equal(new Set(summary.stemHashes).size, 4);

  const commit = spawnSync('git', ['cat-file', '-e', `${summary.deployedCommit}^{commit}`], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
  assert.equal(commit.status, 0, commit.stderr);
});

test('the baseline remains valid in CI when gitignored corpus audio is not hydrated', () => {
  const summary = validateRailwayRollbackBaseline(rawBaseline(), rawCorpus());
  assert.equal(summary.sourceBytesVerified, false);
  assert.equal(summary.corpusSlug, 'electronic-stiff-hand');
});

test('baseline validation rejects schema, source, contract, and execution drift', () => {
  const mutations: Array<[string, (value: Record<string, any>) => void, RegExp]> = [
    ['extra field', (value) => { value.classCode = 'must-never-exist'; }, /baseline schema/],
    ['origin', (value) => { value.base = 'https://example.com'; }, /origin is not canonical/],
    ['source hash', (value) => { value.source.sha256 = '0'.repeat(64); }, /authorized corpus/],
    ['model stem', (value) => { value.catalogue.model.stems[3] = 'accompaniment'; }, /frozen contract/],
    ['job timing', (value) => { value.job.latencyMs += 1; }, /timing evidence/],
    ['stem order', (value) => { value.stems.reverse(); }, /stem order/],
    ['stem identity', (value) => { value.stems[1].sha256 = value.stems[0].sha256; }, /distinct hashes/],
    ['Railway scope', (value) => { value.railway.projectId = randomUUID(); }, /scope is not canonical/],
    ['provider pin', (value) => { value.provider.separation.version = 'latest'; }, /provider version is invalid/],
  ];

  for (const [label, mutate, expected] of mutations) {
    const value = rawBaseline();
    mutate(value);
    assert.throws(
      () => validateRailwayRollbackBaseline(value, rawCorpus(), hydratedSource()),
      expected,
      label
    );
  }
});

test('hydrated source bytes must match both committed size and corpus SHA-256', () => {
  const changed = Buffer.from(hydratedSource() ?? Buffer.alloc(rawBaseline().source.bytes));
  changed[changed.length - 1] ^= 0xff;
  assert.throws(
    () => validateRailwayRollbackBaseline(rawBaseline(), rawCorpus(), changed),
    /hydrated baseline source bytes drifted/
  );
});
