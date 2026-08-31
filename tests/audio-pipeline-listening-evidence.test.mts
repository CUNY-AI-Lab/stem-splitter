import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  AUDIO_PIPELINE_LISTENING_ATTESTATION,
  AUDIO_PIPELINE_LISTENING_SCHEMA,
  createPendingAudioPipelineListeningReview,
  validateAudioPipelineListeningEvidence,
} from '../scripts/lib/audio-pipeline-listening-evidence.mts';
import {
  AUDIO_PIPELINE_PROMOTION_MANIFEST_PATH,
  validateAudioPipelinePromotionEvidence,
  validateAudioPipelinePromotionManifest,
} from '../scripts/lib/audio-pipeline-promotion.mts';
import { loadRailwayRollbackBaselineEvidence } from '../scripts/lib/railway-baseline-evidence.mts';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');

function acceptedReview(): Record<string, any> {
  const baseline = loadRailwayRollbackBaselineEvidence(REPOSITORY_ROOT);
  const review = createPendingAudioPipelineListeningReview(baseline) as Record<string, any>;
  review.reviewedAt = '2026-08-10T12:00:00.000Z';
  review.reviewedBy = 'Course Instructor';
  review.reviewerRole = 'teacher';
  review.decision = 'accepted';
  review.attestation = AUDIO_PIPELINE_LISTENING_ATTESTATION;
  for (const key of Object.keys(review.checks)) review.checks[key] = true;
  for (const stem of review.stems) stem.verdict = 'accepted';
  return review;
}

test('an attributable complete review accepts only the exact frozen Railway stems', () => {
  const baseline = loadRailwayRollbackBaselineEvidence(REPOSITORY_ROOT);
  const summary = validateAudioPipelineListeningEvidence(acceptedReview(), baseline);
  assert.equal(summary.schema, AUDIO_PIPELINE_LISTENING_SCHEMA);
  assert.equal(summary.decision, 'accepted');
  assert.equal(summary.reviewedBy, 'Course Instructor');
  assert.equal(summary.jobId, baseline.jobId);
  assert.deepEqual(summary.stemHashes, baseline.stemHashes);
});

test('pending, partial, anonymous, and drifted listening claims fail closed', () => {
  const baseline = loadRailwayRollbackBaselineEvidence(REPOSITORY_ROOT);
  const mutations: Array<[string, (value: Record<string, any>) => void, RegExp]> = [
    ['pending', (value) => { value.decision = 'pending'; }, /decision must be accepted/],
    ['anonymous', (value) => { value.reviewedBy = ''; }, /reviewedBy is invalid/],
    ['role', (value) => { value.reviewerRole = 'automated-agent'; }, /reviewerRole is invalid/],
    ['attestation', (value) => { value.attestation = 'accepted'; }, /attestation is incomplete/],
    ['partial check', (value) => { value.checks.bassUsable = false; }, /bassUsable is not accepted/],
    ['review date', (value) => { value.reviewedAt = '2026-08-09T00:00:00.000Z'; }, /predates the frozen baseline/],
    ['job', (value) => { value.jobId = '00000000-0000-0000-0000-000000000000'; }, /frozen release baseline/],
    ['stem hash', (value) => { value.stems[0].sha256 = '0'.repeat(64); }, /frozen bytes/],
    ['stem order', (value) => { value.stems.reverse(); }, /frozen bytes/],
    ['extra field', (value) => { value.approved = true; }, /listening schema/],
  ];
  for (const [label, mutate, expected] of mutations) {
    const review = acceptedReview();
    mutate(review);
    assert.throws(
      () => validateAudioPipelineListeningEvidence(review, baseline),
      expected,
      label
    );
  }
});

test('the current promotion validates the canonical listening review', () => {
  const raw = JSON.parse(
    readFileSync(resolve(REPOSITORY_ROOT, AUDIO_PIPELINE_PROMOTION_MANIFEST_PATH), 'utf8')
  );
  const manifest = validateAudioPipelinePromotionManifest(raw);
  assert.doesNotThrow(() => validateAudioPipelinePromotionEvidence(REPOSITORY_ROOT, manifest));
});
