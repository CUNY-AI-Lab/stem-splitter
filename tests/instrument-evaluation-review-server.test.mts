import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  INSTRUMENT_EVALUATION_REVIEW_ATTESTATION,
  instrumentEvaluationPlanSha256,
  loadInstrumentEvaluationPlan,
} from '../scripts/lib/instrument-evaluation.mts';
import {
  createPrivateInstrumentEvaluationReviewTemplate,
  validatePrivateInstrumentEvaluationReviewDraft,
} from '../scripts/lib/instrument-evaluation-review.mts';

const repositoryRoot = process.cwd();

function draft() {
  const plan = loadInstrumentEvaluationPlan(repositoryRoot);
  return {
    plan,
    value: createPrivateInstrumentEvaluationReviewTemplate(
      plan,
      instrumentEvaluationPlanSha256(repositoryRoot)
    ),
  };
}

test('private review drafts preserve frozen identity while allowing partial progress', () => {
  const { plan, value } = draft();
  value.sources[0].verdicts[0].verdict = 'audible';
  value.sources[0].verdicts[1].verdict = 'uncertain';
  const validated = validatePrivateInstrumentEvaluationReviewDraft(
    value,
    plan,
    instrumentEvaluationPlanSha256(repositoryRoot)
  );
  assert.equal(validated.sources[0].verdicts[0].verdict, 'audible');
  assert.equal(validated.sources[0].verdicts[1].verdict, 'uncertain');
  assert.equal(validated.sources[0].wholeSourceListened, false);
});

test('private review drafts reject false completion, reordered sources, and verdict drift', () => {
  const cases: Array<[string, (value: ReturnType<typeof draft>['value']) => void]> = [
    ['false completion', (value) => { value.sources[0].wholeSourceListened = true; }],
    ['reordered sources', (value) => { value.sources.reverse(); }],
    ['source hash drift', (value) => { value.sources[0].sourceSha256 = '0'.repeat(64); }],
    ['verdict drift', (value) => {
      value.sources[0].verdicts[0].verdict = 'present' as never;
    }],
    ['partial completion metadata', (value) => { value.reviewer = 'Zach'; }],
    ['premature attestation', (value) => {
      value.reviewer = 'Zach';
      value.reviewedAt = '2026-08-31T21:28:00.000Z';
      value.attestation = INSTRUMENT_EVALUATION_REVIEW_ATTESTATION;
    }],
  ];
  for (const [name, mutate] of cases) {
    const { plan, value } = draft();
    mutate(value);
    assert.throws(
      () => validatePrivateInstrumentEvaluationReviewDraft(
        value,
        plan,
        instrumentEvaluationPlanSha256(repositoryRoot)
      ),
      /./,
      name
    );
  }
});

test('local review surface is isolated from the public app and requires guarded saves', () => {
  const server = readFileSync('scripts/serve-instrument-evaluation-review.mts', 'utf8');
  const html = readFileSync('scripts/instrument-review-ui/index.html', 'utf8');
  const client = readFileSync('scripts/instrument-review-ui/app.js', 'utf8');
  assert.match(server, /const HOST = '127\.0\.0\.1'/);
  assert.match(server, /SameSite=Strict/);
  assert.match(server, /instrument_review_\$\{port\}/);
  assert.match(server, /request\.headers\.origin !== origin/);
  assert.match(server, /private instrument review must remain under the repository output directory/);
  assert.match(html, /<audio id="source-audio" controls/);
  assert.match(html, /I listened to the whole recording\./);
  assert.match(client, /method: 'PUT'/);
  assert.doesNotMatch(`${server}\n${html}\n${client}`, /public\/teacher|\/teacher\.html/);
  assert.doesNotMatch(html, /AutoSplit analysis|authorized testing|job id/i);
});
