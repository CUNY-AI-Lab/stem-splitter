import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  INSTRUMENT_EVALUATION_REVIEW_ATTESTATION,
  instrumentEvaluationPlanSha256,
  loadInstrumentEvaluationPlan,
  type InstrumentEvaluationPlanV1,
} from '../scripts/lib/instrument-evaluation.mts';
import {
  createPrivateInstrumentEvaluationReviewTemplate,
  finalizePrivateInstrumentEvaluationReview,
  type PrivateInstrumentEvaluationReviewV1,
} from '../scripts/lib/instrument-evaluation-review.mts';
import { INSTRUMENT_REVIEW_OPTIONS } from '../src/analysis/instrument-review.ts';

const repositoryRoot = process.cwd();

function completedPrivateReview(
  plan: InstrumentEvaluationPlanV1
): PrivateInstrumentEvaluationReviewV1 {
  const value = createPrivateInstrumentEvaluationReviewTemplate(
    plan,
    instrumentEvaluationPlanSha256(repositoryRoot)
  );
  value.reviewer = 'Domain Reviewer 1';
  value.reviewedAt = '2026-08-10T17:00:00.000Z';
  value.attestation = INSTRUMENT_EVALUATION_REVIEW_ATTESTATION;
  for (const source of value.sources) {
    source.wholeSourceListened = true;
    for (const verdict of source.verdicts) verdict.verdict = 'absent';
  }
  return value;
}

function serialized(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

test('private review template is exhaustive, pending, and contains no media locations', () => {
  const plan = loadInstrumentEvaluationPlan(repositoryRoot);
  const template = createPrivateInstrumentEvaluationReviewTemplate(
    plan,
    instrumentEvaluationPlanSha256(repositoryRoot)
  );
  assert.equal(template.sources.length, 19);
  assert.equal(
    template.sources.reduce((total, source) => total + source.verdicts.length, 0),
    19 * INSTRUMENT_REVIEW_OPTIONS.length
  );
  assert.ok(template.sources.every((source) => !source.wholeSourceListened));
  assert.ok(
    template.sources.every((source) =>
      source.verdicts.every(({ verdict }) => verdict === 'unreviewed')
    )
  );
  assert.equal(template.reviewer, '');
  const templateJson = JSON.stringify(template);
  assert.doesNotMatch(templateJson, /(?:audio|media|source)(?:Url|Path)/i);
});

test('finalization binds exact private bytes and removes reviewer identity', () => {
  const plan = loadInstrumentEvaluationPlan(repositoryRoot);
  const privateReview = completedPrivateReview(plan);
  const privateBytes = serialized(privateReview);
  const review = finalizePrivateInstrumentEvaluationReview(
    privateReview,
    privateBytes,
    plan,
    instrumentEvaluationPlanSha256(repositoryRoot)
  );
  assert.equal(
    review.privateReviewSha256,
    createHash('sha256').update(privateBytes).digest('hex')
  );
  assert.equal(review.deidentified, true);
  assert.equal(review.rawTeacherFeedbackIncluded, false);
  assert.equal('reviewer' in review, false);
  assert.equal(review.sources.length, 19);
});

test('finalization rejects incomplete listening, drift, reordering, and mismatched bytes', () => {
  const plan = loadInstrumentEvaluationPlan(repositoryRoot);
  const planSha256 = instrumentEvaluationPlanSha256(repositoryRoot);
  const cases: Array<[string, (value: PrivateInstrumentEvaluationReviewV1) => void]> = [
    ['unreviewed', (value) => { value.sources[0].verdicts[0].verdict = 'unreviewed'; }],
    ['partial listening', (value) => { value.sources[0].wholeSourceListened = false; }],
    ['bad attestation', (value) => { value.attestation = 'I skimmed the sources.'; }],
    ['noncanonical time', (value) => { value.reviewedAt = '2026-08-10T17:00:00Z'; }],
    ['reordered sources', (value) => { value.sources.reverse(); }],
  ];
  for (const [name, mutate] of cases) {
    const value = completedPrivateReview(plan);
    mutate(value);
    assert.throws(
      () => finalizePrivateInstrumentEvaluationReview(value, serialized(value), plan, planSha256),
      /./,
      name
    );
  }

  const value = completedPrivateReview(plan);
  const originalBytes = serialized(value);
  value.reviewer = 'Domain Reviewer 2';
  assert.throws(
    () => finalizePrivateInstrumentEvaluationReview(value, originalBytes, plan, planSha256),
    /bytes do not match/
  );
});

test('review commands use owner-only, no-overwrite files and reject symbolic-link input', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'stem-splitter-instrument-review-'));
  try {
    const privatePath = join(temporaryRoot, 'private.json');
    const publicPath = join(temporaryRoot, 'public.json');
    const prepare = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(repositoryRoot, 'scripts/prepare-instrument-evaluation-review.mts'),
        '--output',
        privatePath,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' }
    );
    assert.equal(prepare.status, 0, prepare.stderr);
    assert.equal(lstatSync(privatePath).mode & 0o777, 0o600);

    const plan = loadInstrumentEvaluationPlan(repositoryRoot);
    const value = completedPrivateReview(plan);
    writeFileSync(privatePath, serialized(value), 'utf8');
    chmodSync(privatePath, 0o600);
    const finalize = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(repositoryRoot, 'scripts/finalize-instrument-evaluation-review.mts'),
        '--input',
        privatePath,
        '--output',
        publicPath,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' }
    );
    assert.equal(finalize.status, 0, finalize.stderr);
    assert.equal(lstatSync(publicPath).mode & 0o777, 0o600);
    const publicReview = JSON.parse(readFileSync(publicPath, 'utf8'));
    assert.equal(publicReview.rawTeacherFeedbackIncluded, false);
    assert.equal('reviewer' in publicReview, false);

    const noOverwrite = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(repositoryRoot, 'scripts/finalize-instrument-evaluation-review.mts'),
        '--input',
        privatePath,
        '--output',
        publicPath,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' }
    );
    assert.notEqual(noOverwrite.status, 0);

    const linkedPath = join(temporaryRoot, 'linked-private.json');
    const linkedOutput = join(temporaryRoot, 'linked-public.json');
    symlinkSync(privatePath, linkedPath);
    const linked = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(repositoryRoot, 'scripts/finalize-instrument-evaluation-review.mts'),
        '--input',
        linkedPath,
        '--output',
        linkedOutput,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' }
    );
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /regular file, not a symbolic link/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
