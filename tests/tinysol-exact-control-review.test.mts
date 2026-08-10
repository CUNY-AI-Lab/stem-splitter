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

import {
  TINYSOL_EXACT_CONTROL_REVIEW_ATTESTATION,
  createPrivateTinySolExactControlReviewTemplate,
  finalizePrivateTinySolExactControlReview,
  tinySolExactControlManifestSha256,
  validateTinySolExactControlReview,
  verifyHydratedTinySolExactControls,
  type PrivateTinySolExactControlReviewV1,
} from '../scripts/lib/tinysol-exact-control-review.mts';
import {
  TINYSOL_EXACT_CONTROL_OUTPUT_DIRECTORY,
  loadTinySolExactControlManifest,
  type TinySolExactControlManifest,
} from '../scripts/lib/tinysol-exact-control-corpus.mts';

const repositoryRoot = process.cwd();

function serialized(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function completedPrivateReview(
  manifest: TinySolExactControlManifest,
  manifestSha256 = tinySolExactControlManifestSha256(repositoryRoot)
): PrivateTinySolExactControlReviewV1 {
  const review = createPrivateTinySolExactControlReviewTemplate(manifest, manifestSha256);
  review.reviewer = 'Domain Reviewer 1';
  review.reviewedAt = '2026-08-10T22:00:00.000Z';
  review.attestation = TINYSOL_EXACT_CONTROL_REVIEW_ATTESTATION;
  for (const control of review.controls) {
    control.wholeSourceListened = true;
    control.sourceLabelVerdict = 'matches-audio';
    control.vocabularyMappingVerdict = 'approved';
  }
  return review;
}

function withTemporaryRoot(run: (root: string) => Promise<void> | void): Promise<void> | void {
  const root = mkdtempSync(join(tmpdir(), 'stem-splitter-tinysol-review-'));
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

function fixtureManifest(bytes: Buffer): TinySolExactControlManifest {
  const manifest = structuredClone(loadTinySolExactControlManifest(repositoryRoot)) as any;
  const control = manifest.controls[0];
  control.media.bytes = bytes.byteLength;
  control.media.sha256 = createHash('sha256').update(bytes).digest('hex');
  manifest.controls = [control];
  return manifest as TinySolExactControlManifest;
}

function writeFixtureAudio(
  root: string,
  manifest: TinySolExactControlManifest,
  bytes: Buffer
): string {
  const control = manifest.controls[0];
  const path = join(root, TINYSOL_EXACT_CONTROL_OUTPUT_DIRECTORY, control.localFile);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

test('TinySOL private review separates source-label and vocabulary-mapping judgments', () => {
  const manifest = loadTinySolExactControlManifest(repositoryRoot);
  const manifestSha256 = tinySolExactControlManifestSha256(repositoryRoot);
  const template = createPrivateTinySolExactControlReviewTemplate(manifest, manifestSha256);
  assert.equal(template.controls.length, 5);
  assert.ok(template.controls.every((control) => !control.wholeSourceListened));
  assert.ok(template.controls.every(({ sourceLabelVerdict }) => sourceLabelVerdict === 'unreviewed'));
  assert.ok(
    template.controls.every(
      ({ vocabularyMappingVerdict }) => vocabularyMappingVerdict === 'unreviewed'
    )
  );
  assert.ok(
    template.controls.every(({ audioPath }) =>
      audioPath.startsWith(`${TINYSOL_EXACT_CONTROL_OUTPUT_DIRECTORY}/`)
    )
  );
  assert.deepEqual(
    template.controls.find(({ datasetInstrument }) => datasetInstrument === 'Contrabass'),
    {
      id: 'tinysol-contrabass-c4-mf',
      sourceSha256: manifest.controls[2].media.sha256,
      datasetInstrument: 'Contrabass',
      proposedVocabularyId: 'double-bass',
      audioPath: `${TINYSOL_EXACT_CONTROL_OUTPUT_DIRECTORY}/tinysol-contrabass-c4-mf.wav`,
      wholeSourceListened: false,
      sourceLabelVerdict: 'unreviewed',
      vocabularyMappingVerdict: 'unreviewed',
    }
  );
  assert.equal(template.claimBoundary.datasetGroundTruth, 'dataset-authored-source-label-only');
  assert.equal(template.claimBoundary.candidateNegativeReviewStatus, 'not-collected');
  assert.equal(template.claimBoundary.evaluationPlanIntegration, 'not-integrated');
  assert.equal(template.claimBoundary.promotionEligible, false);
  assert.throws(
    () => createPrivateTinySolExactControlReviewTemplate(manifest, '0'.repeat(64)),
    /manifest identity/
  );
});

test('TinySOL finalization binds private bytes, deidentifies, and records explicit approvals', () => {
  const manifest = loadTinySolExactControlManifest(repositoryRoot);
  const manifestSha256 = tinySolExactControlManifestSha256(repositoryRoot);
  const privateReview = completedPrivateReview(manifest, manifestSha256);
  const privateBytes = serialized(privateReview);
  const review = finalizePrivateTinySolExactControlReview(
    privateReview,
    privateBytes,
    manifest,
    manifestSha256
  );
  assert.equal(review.privateReviewSha256, createHash('sha256').update(privateBytes).digest('hex'));
  assert.equal(review.deidentified, true);
  assert.equal(review.rawTeacherFeedbackIncluded, false);
  assert.equal(review.status, 'reviewed-deidentified-exact-control-evidence');
  assert.deepEqual(review.reviewSummary, {
    controlCount: 5,
    sourceLabelVerdicts: { matchesAudio: 5, doesNotMatchAudio: 0, uncertain: 0 },
    vocabularyMappingVerdicts: { approved: 5, rejected: 0, uncertain: 0 },
    allSourceLabelsConfirmed: true,
    allVocabularyMappingsApproved: true,
    contrabassToDoubleBassApproved: true,
  });
  assert.deepEqual(review.blockers, [
    'evaluation-plan-integration-missing',
    'candidate-observations-for-expanded-plan-missing',
    'candidate-quality-floor-not-selected',
    'human-candidate-selection-missing',
    'railway-shadow-evidence-missing',
  ]);
  assert.equal(review.claimBoundary.candidateNegativeReviewStatus, 'not-collected');
  assert.equal(review.claimBoundary.promotionEligible, false);
  const publicJson = JSON.stringify(review);
  assert.doesNotMatch(publicJson, /Domain Reviewer 1/);
  assert.doesNotMatch(publicJson, /audioPath/);
});

test('TinySOL rejected and uncertain judgments remain evidence but retain acceptance blockers', () => {
  const manifest = loadTinySolExactControlManifest(repositoryRoot);
  const manifestSha256 = tinySolExactControlManifestSha256(repositoryRoot);
  const privateReview = completedPrivateReview(manifest, manifestSha256);
  privateReview.controls[0].vocabularyMappingVerdict = 'rejected';
  privateReview.controls[1].sourceLabelVerdict = 'uncertain';
  privateReview.controls[2].vocabularyMappingVerdict = 'uncertain';
  const review = finalizePrivateTinySolExactControlReview(
    privateReview,
    serialized(privateReview),
    manifest,
    manifestSha256
  );
  assert.deepEqual(review.reviewSummary.sourceLabelVerdicts, {
    matchesAudio: 4,
    doesNotMatchAudio: 0,
    uncertain: 1,
  });
  assert.deepEqual(review.reviewSummary.vocabularyMappingVerdicts, {
    approved: 3,
    rejected: 1,
    uncertain: 1,
  });
  assert.equal(review.reviewSummary.contrabassToDoubleBassApproved, false);
  assert.deepEqual(review.blockers.slice(0, 3), [
    'source-label-confirmation-incomplete',
    'vocabulary-mapping-approval-incomplete',
    'contrabass-double-bass-mapping-approval-missing',
  ]);
  assert.equal(review.status, 'reviewed-deidentified-exact-control-evidence');
});

test('TinySOL finalization rejects incomplete review, source drift, escalation, and byte mismatch', () => {
  const manifest = loadTinySolExactControlManifest(repositoryRoot);
  const manifestSha256 = tinySolExactControlManifestSha256(repositoryRoot);
  const cases: Array<[string, (value: any) => void]> = [
    ['unreviewed source label', (value) => { value.controls[0].sourceLabelVerdict = 'unreviewed'; }],
    ['unreviewed mapping', (value) => { value.controls[0].vocabularyMappingVerdict = 'unreviewed'; }],
    ['partial listening', (value) => { value.controls[0].wholeSourceListened = false; }],
    ['source hash drift', (value) => { value.controls[0].sourceSha256 = '0'.repeat(64); }],
    ['dataset label drift', (value) => { value.controls[0].datasetInstrument = 'Harmonica'; }],
    ['mapping drift', (value) => { value.controls[2].proposedVocabularyId = 'bass-guitar'; }],
    ['audio path drift', (value) => { value.controls[0].audioPath = '/tmp/unpinned.wav'; }],
    ['control reorder', (value) => { value.controls.reverse(); }],
    ['claim escalation', (value) => { value.claimBoundary.promotionEligible = true; }],
    ['negative-review claim', (value) => { value.claimBoundary.candidateNegativeReviewStatus = 'complete'; }],
    ['bad attestation', (value) => { value.attestation = 'I sampled the controls.'; }],
    ['noncanonical time', (value) => { value.reviewedAt = '2026-08-10T22:00:00Z'; }],
    ['unknown field', (value) => { value.teacherApproved = true; }],
  ];
  for (const [name, mutate] of cases) {
    const value = completedPrivateReview(manifest, manifestSha256) as any;
    mutate(value);
    assert.throws(
      () =>
        finalizePrivateTinySolExactControlReview(
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
      finalizePrivateTinySolExactControlReview(
        value,
        originalBytes,
        manifest,
        manifestSha256
      ),
    /bytes do not match/
  );
});

test('public TinySOL review validation rejects identity leakage and synthesized acceptance', () => {
  const manifest = loadTinySolExactControlManifest(repositoryRoot);
  const manifestSha256 = tinySolExactControlManifestSha256(repositoryRoot);
  const privateReview = completedPrivateReview(manifest, manifestSha256);
  const review = finalizePrivateTinySolExactControlReview(
    privateReview,
    serialized(privateReview),
    manifest,
    manifestSha256
  );
  const cases: Array<[string, (value: Record<string, any>) => void]> = [
    ['reviewer identity', (value) => { value.reviewer = 'Domain Reviewer 1'; }],
    ['audio path', (value) => { value.controls[0].audioPath = '/private/control.wav'; }],
    ['promotion claim', (value) => { value.claimBoundary.promotionEligible = true; }],
    ['plan integration claim', (value) => { value.claimBoundary.evaluationPlanIntegration = 'v4'; }],
    ['negative review claim', (value) => { value.claimBoundary.candidateNegativeReviewStatus = 'complete'; }],
    ['summary drift', (value) => { value.reviewSummary.allVocabularyMappingsApproved = false; }],
    ['blocker deletion', (value) => { value.blockers.pop(); }],
    ['source reorder', (value) => { value.controls.reverse(); }],
    ['mapping verdict drift', (value) => { value.controls[2].vocabularyMappingVerdict = 'unreviewed'; }],
  ];
  for (const [name, mutate] of cases) {
    const candidate = structuredClone(review) as unknown as Record<string, any>;
    mutate(candidate);
    assert.throws(
      () => validateTinySolExactControlReview(candidate, manifest, manifestSha256),
      /./,
      name
    );
  }
  assert.deepEqual(
    validateTinySolExactControlReview(review, manifest, manifestSha256),
    review
  );
});

test('TinySOL review audio preflight requires exact owner-only regular files', async () => {
  const bytes = Buffer.from('bounded TinySOL review control');
  const manifest = fixtureManifest(bytes);
  await withTemporaryRoot(async (root) => {
    const path = writeFixtureAudio(root, manifest, bytes);
    assert.deepEqual(verifyHydratedTinySolExactControls(root, manifest), [
      {
        id: manifest.controls[0].id,
        audioPath: `${TINYSOL_EXACT_CONTROL_OUTPUT_DIRECTORY}/${manifest.controls[0].localFile}`,
        bytes: bytes.byteLength,
        sha256: manifest.controls[0].media.sha256,
      },
    ]);
    chmodSync(path, 0o644);
    assert.throws(
      () => verifyHydratedTinySolExactControls(root, manifest),
      /hydrate the pinned owner-only TinySOL WAV/
    );
  });
  await withTemporaryRoot(async (root) => {
    const changed = Buffer.from('changed TinySOL review control');
    const path = writeFixtureAudio(root, manifest, changed);
    chmodSync(path, 0o600);
    assert.throws(
      () => verifyHydratedTinySolExactControls(root, manifest),
      /SHA-256 pin/
    );
  });
  await withTemporaryRoot(async (root) => {
    const outside = join(root, 'outside.wav');
    writeFileSync(outside, bytes, { mode: 0o600 });
    const path = join(
      root,
      TINYSOL_EXACT_CONTROL_OUTPUT_DIRECTORY,
      manifest.controls[0].localFile
    );
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(outside, path);
    assert.throws(
      () => verifyHydratedTinySolExactControls(root, manifest),
      /hydrate the pinned owner-only TinySOL WAV/
    );
  });
});

test('TinySOL review CLIs reject ambiguous arguments and unsafe private inputs before review', () => {
  const prepareScript = resolve(repositoryRoot, 'scripts/prepare-tinysol-exact-control-review.mts');
  const finalizeScript = resolve(repositoryRoot, 'scripts/finalize-tinysol-exact-control-review.mts');
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
    assert.match(linked.stderr, /direct regular file, not a symbolic link/);

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

    writeFileSync(privatePath, Buffer.alloc(128 * 1024 + 1), { mode: 0o600 });
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
    assert.match(oversized.stderr, /128 KiB safety boundary/);
  });
});
