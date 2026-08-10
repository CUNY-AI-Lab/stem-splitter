import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  AUDIO_PIPELINE_COMPONENT_ORDER,
  AUDIO_PIPELINE_PROMOTION_MANIFEST_PATH,
  loadAudioPipelinePromotionManifest,
  promotionBlockers,
  validateAudioPipelinePromotionManifest,
} from '../scripts/lib/audio-pipeline-promotion.mts';
import { AUDIO_ANALYSIS_SOURCE_SCOPE_VERSION } from '../src/analysis/source-scope.ts';
import { PINNED_ROLE_CLASSIFIER_VERSION } from '../src/analysis/types.ts';
import { AUDIOSEP_REVIEWED_REPLICATE_VERSION } from '../src/isolation/options.ts';
import { getSeparationOptions } from '../src/separation/options.ts';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');

function rawManifest(): Record<string, any> {
  return JSON.parse(
    readFileSync(resolve(REPOSITORY_ROOT, AUDIO_PIPELINE_PROMOTION_MANIFEST_PATH), 'utf8')
  );
}

function cloneManifest(): Record<string, any> {
  return structuredClone(rawManifest());
}

function assertCommitExists(commit: string): void {
  const result = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}

test('the v3.2 manifest binds real commits, executable core contracts, and ordered components', () => {
  const manifest = loadAudioPipelinePromotionManifest(REPOSITORY_ROOT);
  assertCommitExists(manifest.baseCommit);
  assertCommitExists(manifest.candidateCommit);
  assert.notEqual(manifest.baseCommit, manifest.candidateCommit);
  assert.deepEqual(
    manifest.coreContracts,
    getSeparationOptions('replicate').models.map(({ id, stems }) => ({ id, stems }))
  );
  assert.deepEqual(
    manifest.components.map(({ id, order, dependsOn }) => ({ id, order, dependsOn })),
    AUDIO_PIPELINE_COMPONENT_ORDER
  );
  assert.equal(
    manifest.components[0].artifactVersion,
    `${PINNED_ROLE_CLASSIFIER_VERSION}+${AUDIO_ANALYSIS_SOURCE_SCOPE_VERSION}`
  );
  assert.equal(manifest.components[2].artifactVersion, AUDIOSEP_REVIEWED_REPLICATE_VERSION);
  assert.deepEqual(
    [...manifest.blockers].sort(),
    promotionBlockers(manifest, 'shadow')
  );
});

test('a release may change exactly one declared axis and schema changes must be additive', () => {
  const twoAxes = cloneManifest();
  twoAxes.change.instrumentClassifier = true;
  assert.throws(
    () => validateAudioPipelinePromotionManifest(twoAxes),
    /exactly one declared axis/
  );

  const mismatchedAxis = cloneManifest();
  mismatchedAxis.change.axis = 'thresholds';
  assert.throws(
    () => validateAudioPipelinePromotionManifest(mismatchedAxis),
    /exactly one declared axis/
  );

  const destructiveSchema = cloneManifest();
  destructiveSchema.change.axis = 'schema';
  destructiveSchema.change.roleClassifier = false;
  destructiveSchema.change.schemaMigration = true;
  assert.throws(
    () => validateAudioPipelinePromotionManifest(destructiveSchema),
    /schema changes must be explicitly additive and isolated/
  );

  const additiveSchema = cloneManifest();
  additiveSchema.change.axis = 'schema';
  additiveSchema.change.roleClassifier = false;
  additiveSchema.change.schemaMigration = true;
  additiveSchema.change.additiveSchemaOnly = true;
  assert.equal(validateAudioPipelinePromotionManifest(additiveSchema).change.axis, 'schema');
});

test('default routing cannot change before the final rollout stage', () => {
  const value = cloneManifest();
  value.change.axis = 'default-routing';
  value.change.roleClassifier = false;
  value.change.defaultRouting = true;
  assert.throws(
    () => validateAudioPipelinePromotionManifest(value),
    /default routing may change only in a default-stage release/
  );
});

test('core stem names and compiled artifact pins fail closed on drift', () => {
  const stemDrift = cloneManifest();
  stemDrift.coreContracts[1].stems[3] = 'accompaniment';
  assert.throws(
    () => validateAudioPipelinePromotionManifest(stemDrift),
    /core contracts drifted from the executable catalogue/
  );

  const floating = cloneManifest();
  floating.components[2].artifactVersion = 'latest';
  assert.throws(
    () => validateAudioPipelinePromotionManifest(floating),
    /exact non-floating version/
  );

  const analysisPinDrift = cloneManifest();
  analysisPinDrift.components[0].artifactVersion = 'autosplit-role-v99+analysis-source-scope-v2';
  assert.throws(
    () => validateAudioPipelinePromotionManifest(analysisPinDrift),
    /audio-analysis version does not match compiled pins/
  );

  const separatorPinDrift = cloneManifest();
  separatorPinDrift.components[2].artifactVersion = 'a'.repeat(64);
  assert.throws(
    () => validateAudioPipelinePromotionManifest(separatorPinDrift),
    /AudioSep version does not match the reviewed adapter pin/
  );

  const comparisonPinDrift = cloneManifest();
  comparisonPinDrift.components[3].artifactVersion = 'b'.repeat(64);
  assert.throws(
    () => validateAudioPipelinePromotionManifest(comparisonPinDrift),
    /SAM-Audio version does not match the evaluation pin/
  );
});

test('component order and acceptance prevent services from running out of sequence', () => {
  const reordered = cloneManifest();
  [reordered.components[1], reordered.components[2]] = [
    reordered.components[2],
    reordered.components[1],
  ];
  assert.throws(
    () => validateAudioPipelinePromotionManifest(reordered),
    /component dependency order drifted/
  );

  const earlyProvisioning = cloneManifest();
  earlyProvisioning.components[2].provisioned = true;
  assert.throws(
    () => validateAudioPipelinePromotionManifest(earlyProvisioning),
    /cannot run before its dependencies are accepted/
  );

  const enabledBeforeProvisioning = cloneManifest();
  enabledBeforeProvisioning.components[0].runtimeEnabled = true;
  assert.throws(
    () => validateAudioPipelinePromotionManifest(enabledBeforeProvisioning),
    /cannot be enabled before provisioning/
  );

  const executedBeforeEnablement = cloneManifest();
  executedBeforeEnablement.components[0].externalExecution = true;
  assert.throws(
    () => validateAudioPipelinePromotionManifest(executedBeforeEnablement),
    /cannot execute before enablement/
  );

  const blockedPromotion = cloneManifest();
  blockedPromotion.components[0].accepted = true;
  blockedPromotion.components[0].disposition = 'accepted';
  blockedPromotion.components[0].blockers = [];
  blockedPromotion.components[0].provisioned = true;
  blockedPromotion.components[0].runtimeEnabled = true;
  blockedPromotion.components[0].externalExecution = true;
  blockedPromotion.components[1].provisioned = true;
  assert.throws(
    () => validateAudioPipelinePromotionManifest(blockedPromotion),
    /blocked disposition cannot be promoted/
  );

  const paperAcceptance = cloneManifest();
  paperAcceptance.components[0].accepted = true;
  paperAcceptance.components[0].disposition = 'accepted';
  paperAcceptance.components[0].blockers = [];
  assert.throws(
    () => validateAudioPipelinePromotionManifest(paperAcceptance),
    /must execute successfully before acceptance/
  );
});

test('false-default feature flags cannot be bypassed by a mode', () => {
  const offWithFeature = cloneManifest();
  offWithFeature.flags.SERVER_AUTO_ENABLED = true;
  assert.throws(
    () => validateAudioPipelinePromotionManifest(offWithFeature),
    /off rollout must keep every processing feature disabled/
  );

  const bypass = cloneManifest();
  bypass.rolloutStage = 'shadow';
  bypass.flags.SERVER_AUTO_MODE = 'shadow';
  assert.throws(
    () => validateAudioPipelinePromotionManifest(bypass),
    /server Auto mode cannot bypass its master switch/
  );

  const hiddenRuntime = cloneManifest();
  hiddenRuntime.rolloutStage = 'shadow';
  hiddenRuntime.components[0].provisioned = true;
  hiddenRuntime.components[0].runtimeEnabled = true;
  assert.throws(
    () => validateAudioPipelinePromotionManifest(hiddenRuntime),
    /server Auto flag must match the audio-analysis runtime state/
  );
});

test('rollback remains flag-only and declared blockers must match the computed gate', () => {
  const schemaRollback = cloneManifest();
  schemaRollback.rollback.schemaRollbackRequired = true;
  assert.throws(
    () => validateAudioPipelinePromotionManifest(schemaRollback),
    /must not require a schema rollback/
  );

  const untestedFallback = cloneManifest();
  untestedFallback.rollback.localFallbackTested = false;
  assert.throws(
    () => validateAudioPipelinePromotionManifest(untestedFallback),
    /prove its local kill-switch fallback/
  );

  const hiddenBlocker = cloneManifest();
  hiddenBlocker.blockers.pop();
  assert.throws(
    () => validateAudioPipelinePromotionManifest(hiddenBlocker),
    /blockers do not match the shadow promotion gate/
  );
});

test('the rollout ladder exposes each missing proof without skipping stages', () => {
  const current = loadAudioPipelinePromotionManifest(REPOSITORY_ROOT);
  assert.deepEqual(promotionBlockers(current, 'off'), []);
  assert.deepEqual(promotionBlockers(current, 'shadow'), [
    'audio-analysis-service-absent',
    'manual-listening-missing',
    'native-amd64-image-missing',
    'railway-resource-acceptance-missing',
    'railway-rollback-missing',
  ]);
  assert.ok(promotionBlockers(current, 'default').includes('rollout-stage-skip'));

  const shadowReady = structuredClone(current);
  shadowReady.components[0].provisioned = true;
  shadowReady.evidence.nativeAmd64Image = true;
  shadowReady.evidence.manualListening = true;
  shadowReady.evidence.railwayResourceAcceptance = true;
  shadowReady.rollback.railwayRollbackTested = true;
  assert.deepEqual(promotionBlockers(shadowReady, 'shadow'), []);

  const teacherCandidate = structuredClone(shadowReady);
  teacherCandidate.rolloutStage = 'shadow';
  assert.deepEqual(promotionBlockers(teacherCandidate, 'teacher-beta'), [
    'audience-guard-missing',
    'railway-shadow-missing',
  ]);
  teacherCandidate.evidence.audienceGuard = true;
  teacherCandidate.evidence.railwayShadow = true;
  assert.deepEqual(promotionBlockers(teacherCandidate, 'teacher-beta'), []);

  teacherCandidate.rolloutStage = 'teacher-beta';
  assert.deepEqual(promotionBlockers(teacherCandidate, 'student-canary'), [
    'teacher-beta-missing',
  ]);
  teacherCandidate.evidence.teacherBeta = true;
  teacherCandidate.rolloutStage = 'student-canary';
  assert.deepEqual(promotionBlockers(teacherCandidate, 'default'), [
    'student-canary-missing',
  ]);
});

test('the CLI reports blockers and fails only when a blocked stage is required', () => {
  const command = [
    '--experimental-strip-types',
    'scripts/check-audio-pipeline-promotion.mts',
  ];
  const report = spawnSync(process.execPath, command, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
  assert.equal(report.status, 0, report.stderr);
  assert.equal(JSON.parse(report.stdout).promotable, false);

  const required = spawnSync(process.execPath, [...command, '--require-stage', 'shadow'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
  assert.equal(required.status, 1, required.stderr);
  const summary = JSON.parse(required.stdout);
  assert.equal(summary.requestedStage, 'shadow');
  assert.deepEqual(summary.blockers, promotionBlockers(loadAudioPipelinePromotionManifest(REPOSITORY_ROOT), 'shadow'));
});
