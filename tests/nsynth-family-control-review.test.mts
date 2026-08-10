import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { INSTRUMENT_REVIEW_OPTIONS } from '../src/analysis/instrument-review.ts';
import { INSTRUMENT_EVALUATION_REVIEW_ATTESTATION } from '../scripts/lib/instrument-evaluation.mts';
import {
  createPrivateNsynthFamilyControlReviewTemplate,
  finalizePrivateNsynthFamilyControlReview,
  nsynthFamilyControlManifestSha256,
  validateNsynthFamilyControlReview,
  verifyHydratedNsynthFamilyControls,
  type PrivateNsynthFamilyControlReviewV1,
} from '../scripts/lib/nsynth-family-control-review.mts';
import {
  NSYNTH_FAMILY_CONTROL_OUTPUT_DIRECTORY,
  loadNsynthFamilyControlManifest,
  type NsynthFamilyControlManifest,
} from '../scripts/lib/nsynth-family-control-corpus.mts';

const repositoryRoot = process.cwd();

function serialized(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function completedPrivateReview(
  manifest: NsynthFamilyControlManifest,
  manifestSha256 = nsynthFamilyControlManifestSha256(repositoryRoot)
): PrivateNsynthFamilyControlReviewV1 {
  const review = createPrivateNsynthFamilyControlReviewTemplate(manifest, manifestSha256);
  review.reviewer = 'Domain Reviewer 1';
  review.reviewedAt = '2026-08-10T21:00:00.000Z';
  review.attestation = INSTRUMENT_EVALUATION_REVIEW_ATTESTATION;
  for (const control of review.controls) {
    control.wholeSourceListened = true;
    for (const verdict of control.verdicts) verdict.verdict = 'absent';
  }
  return review;
}

function withTemporaryRoot(run: (root: string) => Promise<void> | void): Promise<void> | void {
  const root = mkdtempSync(join(tmpdir(), 'stem-splitter-nsynth-review-'));
  try {
    const result = run(root);
    if (result instanceof Promise) {
      return result.finally(() => rmSync(root, { recursive: true, force: true }));
    }
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function fixtureManifest(bytes: Buffer): NsynthFamilyControlManifest {
  const manifest = structuredClone(loadNsynthFamilyControlManifest(repositoryRoot)) as any;
  const control = manifest.controls[0];
  control.media.bytes = bytes.byteLength;
  control.media.sha256 = createHash('sha256').update(bytes).digest('hex');
  manifest.controls = [control];
  return manifest as NsynthFamilyControlManifest;
}

function writeFixtureAudio(
  root: string,
  manifest: NsynthFamilyControlManifest,
  bytes: Buffer
): string {
  const control = manifest.controls[0];
  const path = join(root, NSYNTH_FAMILY_CONTROL_OUTPUT_DIRECTORY, control.localFile);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

test('NSynth private review template covers all controls and every vocabulary label', () => {
  const manifest = loadNsynthFamilyControlManifest(repositoryRoot);
  const manifestSha256 = nsynthFamilyControlManifestSha256(repositoryRoot);
  const template = createPrivateNsynthFamilyControlReviewTemplate(manifest, manifestSha256);
  assert.equal(template.controls.length, 10);
  assert.equal(
    template.controls.reduce((total, control) => total + control.verdicts.length, 0),
    10 * INSTRUMENT_REVIEW_OPTIONS.length
  );
  assert.ok(template.controls.every((control) => !control.wholeSourceListened));
  assert.ok(
    template.controls.every((control) =>
      control.verdicts.every(({ verdict }) => verdict === 'unreviewed')
    )
  );
  assert.ok(
    template.controls.every((control) =>
      control.audioPath.startsWith(`${NSYNTH_FAMILY_CONTROL_OUTPUT_DIRECTORY}/`)
    )
  );
  assert.equal(template.claimBoundary.exactInstrumentClaims, false);
  assert.equal(template.claimBoundary.evaluationPlanIntegration, 'not-integrated');
  assert.equal(template.claimBoundary.promotionEligible, false);
});

test('NSynth finalization binds exact private bytes and removes reviewer and local paths', () => {
  const manifest = loadNsynthFamilyControlManifest(repositoryRoot);
  const manifestSha256 = nsynthFamilyControlManifestSha256(repositoryRoot);
  const privateReview = completedPrivateReview(manifest, manifestSha256);
  const privateBytes = serialized(privateReview);
  const review = finalizePrivateNsynthFamilyControlReview(
    privateReview,
    privateBytes,
    manifest,
    manifestSha256
  );
  assert.equal(
    review.privateReviewSha256,
    createHash('sha256').update(privateBytes).digest('hex')
  );
  assert.equal(review.deidentified, true);
  assert.equal(review.rawTeacherFeedbackIncluded, false);
  assert.equal(review.status, 'reviewed-deidentified-family-control-evidence');
  assert.equal(review.claimBoundary.exactInstrumentClaims, false);
  assert.equal(review.claimBoundary.promotionEligible, false);
  assert.deepEqual(review.claimBoundary.blockers, [
    'evaluation-plan-integration-missing',
    'candidate-observations-for-expanded-plan-missing',
    'candidate-quality-floor-not-selected',
    'human-candidate-selection-missing',
    'railway-shadow-evidence-missing',
  ]);
  const publicJson = JSON.stringify(review);
  assert.doesNotMatch(publicJson, /Domain Reviewer 1/);
  assert.doesNotMatch(publicJson, /audioPath/);
  assert.equal(review.controls.length, 10);
});

test('NSynth finalization rejects incomplete review, source drift, escalation, and byte mismatch', () => {
  const manifest = loadNsynthFamilyControlManifest(repositoryRoot);
  const manifestSha256 = nsynthFamilyControlManifestSha256(repositoryRoot);
  const cases: Array<[string, (value: any) => void]> = [
    ['unreviewed verdict', (value) => { value.controls[0].verdicts[0].verdict = 'unreviewed'; }],
    ['partial listening', (value) => { value.controls[0].wholeSourceListened = false; }],
    ['source hash drift', (value) => { value.controls[0].sourceSha256 = '0'.repeat(64); }],
    ['family drift', (value) => { value.controls[0].datasetFamily = 'guitar'; }],
    ['source type drift', (value) => { value.controls[0].datasetSource = 'acoustic'; }],
    ['audio path drift', (value) => { value.controls[0].audioPath = '/tmp/unpinned.wav'; }],
    ['control reorder', (value) => { value.controls.reverse(); }],
    ['verdict reorder', (value) => { value.controls[0].verdicts.reverse(); }],
    ['claim escalation', (value) => { value.claimBoundary.exactInstrumentClaims = true; }],
    ['bad attestation', (value) => { value.attestation = 'I sampled the controls.'; }],
    ['noncanonical time', (value) => { value.reviewedAt = '2026-08-10T21:00:00Z'; }],
    ['unknown field', (value) => { value.teacherApproved = true; }],
  ];
  for (const [name, mutate] of cases) {
    const value = completedPrivateReview(manifest, manifestSha256) as any;
    mutate(value);
    assert.throws(
      () =>
        finalizePrivateNsynthFamilyControlReview(
          value,
          serialized(value),
          manifest,
          manifestSha256
        ),
      /./,
      name
    );
  }

  const value = completedPrivateReview(manifest, manifestSha256);
  const originalBytes = serialized(value);
  value.reviewer = 'Domain Reviewer 2';
  assert.throws(
    () =>
      finalizePrivateNsynthFamilyControlReview(
        value,
        originalBytes,
        manifest,
        manifestSha256
      ),
    /bytes do not match/
  );
});

test('public NSynth review validation rejects identity leakage and promotion escalation', () => {
  const manifest = loadNsynthFamilyControlManifest(repositoryRoot);
  const manifestSha256 = nsynthFamilyControlManifestSha256(repositoryRoot);
  const privateReview = completedPrivateReview(manifest, manifestSha256);
  const review = finalizePrivateNsynthFamilyControlReview(
    privateReview,
    serialized(privateReview),
    manifest,
    manifestSha256
  );
  const cases: Array<[string, (value: Record<string, any>) => void]> = [
    ['reviewer identity', (value) => { value.reviewer = 'Domain Reviewer 1'; }],
    ['exact claim', (value) => { value.claimBoundary.exactInstrumentClaims = true; }],
    ['promotion claim', (value) => { value.claimBoundary.promotionEligible = true; }],
    ['plan integration claim', (value) => { value.claimBoundary.evaluationPlanIntegration = 'v4'; }],
    ['source reorder', (value) => { value.controls.reverse(); }],
    ['verdict drift', (value) => { value.controls[0].verdicts[0].instrumentId = 'unknown'; }],
  ];
  for (const [name, mutate] of cases) {
    const candidate = structuredClone(review) as unknown as Record<string, any>;
    mutate(candidate);
    assert.throws(
      () => validateNsynthFamilyControlReview(candidate, manifest, manifestSha256),
      /./,
      name
    );
  }
  assert.deepEqual(
    validateNsynthFamilyControlReview(review, manifest, manifestSha256),
    review
  );
});

test('NSynth review audio preflight requires exact owner-only regular files', async () => {
  const bytes = Buffer.from('bounded NSynth review control');
  const manifest = fixtureManifest(bytes);
  await withTemporaryRoot(async (root) => {
    const path = writeFixtureAudio(root, manifest, bytes);
    assert.deepEqual(verifyHydratedNsynthFamilyControls(root, manifest), [
      {
        id: manifest.controls[0].id,
        audioPath: `${NSYNTH_FAMILY_CONTROL_OUTPUT_DIRECTORY}/${manifest.controls[0].localFile}`,
        bytes: bytes.byteLength,
        sha256: manifest.controls[0].media.sha256,
      },
    ]);
    chmodSync(path, 0o644);
    assert.throws(
      () => verifyHydratedNsynthFamilyControls(root, manifest),
      /hydrate the pinned owner-only NSynth WAV/
    );
  });
  await withTemporaryRoot(async (root) => {
    const path = writeFixtureAudio(root, manifest, Buffer.from('changed NSynth review control'));
    chmodSync(path, 0o600);
    assert.throws(
      () => verifyHydratedNsynthFamilyControls(root, manifest),
      /SHA-256 pin/
    );
  });
  await withTemporaryRoot(async (root) => {
    const outside = join(root, 'outside.wav');
    writeFileSync(outside, bytes, { mode: 0o600 });
    const path = join(
      root,
      NSYNTH_FAMILY_CONTROL_OUTPUT_DIRECTORY,
      manifest.controls[0].localFile
    );
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(outside, path);
    assert.throws(
      () => verifyHydratedNsynthFamilyControls(root, manifest),
      /hydrate the pinned owner-only NSynth WAV/
    );
  });
});

test('NSynth review CLIs reject ambiguous arguments and unsafe private inputs before review', () => {
  const prepareScript = resolve(
    repositoryRoot,
    'scripts/prepare-nsynth-family-control-review.mts'
  );
  const finalizeScript = resolve(
    repositoryRoot,
    'scripts/finalize-nsynth-family-control-review.mts'
  );
  const badPrepare = spawnSync(
    process.execPath,
    ['--experimental-strip-types', prepareScript, '--output', 'one.json', '--output', 'two.json'],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );
  assert.equal(badPrepare.status, 1);
  assert.match(badPrepare.stderr, /usage:/);

  withTemporaryRoot((root) => {
    const privatePath = join(root, 'private.json');
    const linkedPath = join(root, 'linked.json');
    const outputPath = join(root, 'public.json');
    writeFileSync(privatePath, '{}\n', { mode: 0o600 });
    symlinkSync(privatePath, linkedPath);
    const linked = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        finalizeScript,
        '--input',
        linkedPath,
        '--output',
        outputPath,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' }
    );
    assert.equal(linked.status, 1);
    assert.match(linked.stderr, /regular file, not a symbolic link/);

    chmodSync(privatePath, 0o644);
    const permissive = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        finalizeScript,
        '--input',
        privatePath,
        '--output',
        outputPath,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' }
    );
    assert.equal(permissive.status, 1);
    assert.match(permissive.stderr, /owner-only/);

    writeFileSync(privatePath, Buffer.alloc(512 * 1024 + 1), { mode: 0o600 });
    chmodSync(privatePath, 0o600);
    const oversized = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        finalizeScript,
        '--input',
        privatePath,
        '--output',
        outputPath,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' }
    );
    assert.equal(oversized.status, 1);
    assert.match(oversized.stderr, /512 KiB safety boundary/);
  });
});
