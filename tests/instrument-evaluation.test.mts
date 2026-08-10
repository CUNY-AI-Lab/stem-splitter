import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  evaluateInstrumentCandidate,
  INSTRUMENT_CANDIDATE_OBSERVATIONS_SCHEMA,
  INSTRUMENT_EVALUATION_PLAN_PATH,
  INSTRUMENT_EVALUATION_REVIEW_ATTESTATION,
  INSTRUMENT_EVALUATION_REVIEW_SCHEMA,
  instrumentEvaluationPlanSha256,
  loadInstrumentEvaluationPlan,
  summarizeInstrumentEvaluationPlan,
  validateInstrumentCandidateObservations,
  validateInstrumentEvaluationPlan,
  validateInstrumentEvaluationReview,
  type InstrumentCandidateObservationsV1,
  type InstrumentEvaluationPlanV1,
  type InstrumentEvaluationReviewV1,
} from '../scripts/lib/instrument-evaluation.mts';
import { INSTRUMENT_REVIEW_OPTIONS } from '../src/analysis/instrument-review.ts';

const repositoryRoot = process.cwd();

function planSources(plan: InstrumentEvaluationPlanV1) {
  return plan.partitions.flatMap((partition) =>
    partition.sources.map((source) => ({
      partitionId: partition.id,
      corpusKind: partition.corpusKind,
      ...source,
    }))
  );
}

const audibleBySource = new Map<string, string[]>([
  ['folk-duet', ['voice', 'acoustic-guitar']],
  ['orchestral', ['violin', 'trumpet', 'flute']],
  ['shoegaze', ['electric-guitar', 'drum-kit']],
  ['piano-strings', ['piano']],
  ['jazz-sax', ['saxophone', 'harmonica']],
  ['hip-hop', ['synthesizer']],
  ['bluegrass', ['banjo']],
  ['synthwave', ['synthesizer']],
  ['electronic-stiff-hand', ['drum-machine']],
  ['electronic-back-counting', ['sampler']],
  ['electronic-house', ['steelpan']],
  ['flute-an1', ['flute']],
  ['oboe-ba1', ['oboe']],
  ['clarinet-cr1', ['clarinet']],
  ['trumpet-an1', ['trumpet']],
  ['horn-cr1', ['horn']],
  ['trombone-ba1', ['trombone']],
  ['saxophone-cr1', ['saxophone']],
  ['tuba-an1', ['tuba']],
]);

function completeReview(plan: InstrumentEvaluationPlanV1): InstrumentEvaluationReviewV1 {
  return {
    $schema: INSTRUMENT_EVALUATION_REVIEW_SCHEMA,
    planPath: INSTRUMENT_EVALUATION_PLAN_PATH,
    planVersion: plan.version,
    planSha256: instrumentEvaluationPlanSha256(repositoryRoot),
    status: 'reviewed-deidentified-ground-truth',
    reviewProtocolVersion: 'instrument-evaluation-listening-v1',
    privateReviewSha256: 'a'.repeat(64),
    curatedAt: '2026-08-10T16:00:00.000Z',
    reviewAuthority: 'teacher-or-domain-reviewer',
    deidentified: true,
    rawTeacherFeedbackIncluded: false,
    attestation: INSTRUMENT_EVALUATION_REVIEW_ATTESTATION,
    sources: planSources(plan).map((source) => {
      const audible = new Set(audibleBySource.get(source.id) ?? []);
      return {
        partitionId: source.partitionId,
        id: source.id,
        corpusKind: source.corpusKind,
        sourceSha256: source.sourceSha256,
        genreFamily: source.genreFamily,
        wholeSourceListened: true,
        verdicts: INSTRUMENT_REVIEW_OPTIONS.map(({ id }) => ({
          instrumentId: id,
          verdict: audible.has(id) ? 'audible' as const : 'absent' as const,
        })),
      };
    }),
  };
}

function perfectCandidate(
  plan: InstrumentEvaluationPlanV1,
  review: InstrumentEvaluationReviewV1
): InstrumentCandidateObservationsV1 {
  return {
    $schema: INSTRUMENT_CANDIDATE_OBSERVATIONS_SCHEMA,
    planPath: INSTRUMENT_EVALUATION_PLAN_PATH,
    planVersion: plan.version,
    planSha256: review.planSha256,
    generatedAt: '2026-08-10T16:05:00.000Z',
    candidate: {
      classifierVersion: 'candidate-test-v1',
      modelSha256: 'b'.repeat(64),
      vocabularyVersion: plan.vocabulary.version,
      vocabularySha256: plan.vocabulary.sha256,
      preprocessingVersion: 'analysis-windows-v1',
      thresholdPolicyVersion: 'candidate-thresholds-v1',
    },
    sources: review.sources.map((source) => ({
      partitionId: source.partitionId,
      id: source.id,
      sourceSha256: source.sourceSha256,
      status: 'complete',
      detections: source.verdicts
        .filter(({ verdict }) => verdict === 'audible')
        .map(({ instrumentId }) => ({
          instrumentId,
          state: 'possible',
          confidence: 0.9,
        })),
    })),
  };
}

test('genre-diverse evaluation plan binds exact real mixes, isolated controls, and coverage targets', () => {
  const plan = loadInstrumentEvaluationPlan(repositoryRoot);
  const summary = summarizeInstrumentEvaluationPlan(plan);
  assert.equal(plan.version, 'v3.2-genre-diverse-evaluation-v1');
  assert.deepEqual(summary.sourcesByKind, {
    'real-mix': 11,
    'isolated-control': 8,
    'synthetic-stem': 0,
  });
  assert.deepEqual(summary.realMixSourcesByGenre, {
    electronic: 4,
    'folk-traditional': 1,
    'hip-hop': 1,
    jazz: 1,
    'orchestral-chamber': 1,
    rock: 1,
    'sparse-acoustic': 2,
  });
  assert.deepEqual(plan.requiredCoverage.instrumentFamilies, [
    'voice',
    'bowed-strings',
    'plucked-strings',
    'brass',
    'woodwind',
    'keys',
    'electronic',
    'percussion',
    'free-reed',
    'traditional',
  ]);
  assert.equal(summary.promotionEligible, false);
  assert.deepEqual(summary.blockers, [
    'exhaustive-deidentified-review-missing',
    'candidate-observations-missing',
    'candidate-quality-floor-not-selected',
    'candidate-selection-decision-missing',
    'railway-shadow-evidence-missing',
  ]);
});

test('evaluation plan fails closed on manifest, source, ontology, and reporting drift', () => {
  const original = JSON.parse(readFileSync(INSTRUMENT_EVALUATION_PLAN_PATH, 'utf8'));
  for (const mutate of [
    (value: any) => { value.partitions[0].manifestSha256 = '0'.repeat(64); },
    (value: any) => { value.partitions[0].sources[0].sourceSha256 = '0'.repeat(64); },
    (value: any) => { value.vocabulary.reviewOntologyVersion = 'floating-ontology'; },
    (value: any) => { value.reporting.aggregateOnlyPromotionForbidden = false; },
    (value: any) => { value.requiredCoverage.realMixGenreFamilies.pop(); },
    (value: any) => { value.requiredCoverage.instrumentFamilies.pop(); },
    (value: any) => { value.partitions[1].sources.reverse(); },
  ]) {
    const candidate = structuredClone(original);
    mutate(candidate);
    assert.throws(
      () => validateInstrumentEvaluationPlan(candidate, repositoryRoot),
      /drifted|does not cover|policy|identity/
    );
  }
});

test('deidentified review must cover every pinned label and cannot carry reviewer or raw feedback fields', () => {
  const plan = loadInstrumentEvaluationPlan(repositoryRoot);
  const planSha256 = instrumentEvaluationPlanSha256(repositoryRoot);
  const review = completeReview(plan);
  assert.equal(validateInstrumentEvaluationReview(review, plan, planSha256).sources.length, 19);

  const incomplete = structuredClone(review) as any;
  incomplete.sources[0].verdicts.pop();
  assert.throws(
    () => validateInstrumentEvaluationReview(incomplete, plan, planSha256),
    /complete vocabulary/
  );
  const identified = structuredClone(review) as any;
  identified.reviewer = 'teacher-a';
  assert.throws(
    () => validateInstrumentEvaluationReview(identified, plan, planSha256),
    /does not match the evaluation schema/
  );
  const rawFeedback = structuredClone(review) as any;
  rawFeedback.rawTeacherFeedbackIncluded = true;
  assert.throws(
    () => validateInstrumentEvaluationReview(rawFeedback, plan, planSha256),
    /policy/
  );
});

test('candidate observations require exact pins, exact source order, and honest degraded state', () => {
  const plan = loadInstrumentEvaluationPlan(repositoryRoot);
  const planSha256 = instrumentEvaluationPlanSha256(repositoryRoot);
  const review = validateInstrumentEvaluationReview(
    completeReview(plan),
    plan,
    planSha256
  );
  const candidate = perfectCandidate(plan, review);
  assert.equal(
    validateInstrumentCandidateObservations(candidate, plan, planSha256).sources.length,
    19
  );

  const drifted = structuredClone(candidate) as any;
  drifted.candidate.vocabularySha256 = '0'.repeat(64);
  assert.throws(
    () => validateInstrumentCandidateObservations(drifted, plan, planSha256),
    /vocabulary drifted/
  );
  const reordered = structuredClone(candidate) as any;
  reordered.sources.reverse();
  assert.throws(
    () => validateInstrumentCandidateObservations(reordered, plan, planSha256),
    /pinned source plan/
  );
  const degradedWithDetection = structuredClone(candidate) as any;
  degradedWithDetection.sources[0].status = 'degraded';
  assert.throws(
    () => validateInstrumentCandidateObservations(degradedWithDetection, plan, planSha256),
    /cannot report detections/
  );
  const unknown = structuredClone(candidate) as any;
  unknown.sources[0].detections.push({
    instrumentId: 'floating-label',
    state: 'possible',
    confidence: 0.9,
  });
  assert.throws(
    () => validateInstrumentCandidateObservations(unknown, plan, planSha256),
    /unknown, duplicated, or invalid/
  );
});

test('metrics stay separated by genre, family, kind, and corpus instead of promoting one aggregate', () => {
  const plan = loadInstrumentEvaluationPlan(repositoryRoot);
  const planSha256 = instrumentEvaluationPlanSha256(repositoryRoot);
  const review = validateInstrumentEvaluationReview(
    completeReview(plan),
    plan,
    planSha256
  );
  const candidate = validateInstrumentCandidateObservations(
    perfectCandidate(plan, review),
    plan,
    planSha256
  );
  const metrics = evaluateInstrumentCandidate(plan, review, candidate);
  assert.equal(metrics.coverageReady, true);
  assert.deepEqual(metrics.coverageBlockers, []);
  assert.equal(metrics.promotionEligible, false);
  assert.deepEqual(metrics.promotionBlockers, [
    'candidate-quality-floor-not-selected',
    'candidate-selection-decision-missing',
    'railway-shadow-evidence-missing',
  ]);
  assert.equal(metrics.diagnosticAllLabels.promotionUse, 'forbidden-overlapping-label-kinds');
  assert.equal(
    metrics.diagnosticAllLabels.evaluated,
    planSources(plan).length * INSTRUMENT_REVIEW_OPTIONS.length
  );
  for (const genre of plan.requiredCoverage.realMixGenreFamilies) {
    assert.equal(metrics.byGenre[genre]?.precisionBasisPoints, 10_000);
    assert.equal(metrics.byGenre[genre]?.recallBasisPoints, 10_000);
  }
  for (const family of plan.requiredCoverage.instrumentFamilies) {
    assert.equal(metrics.byInstrumentFamily[family]?.precisionBasisPoints, 10_000);
    assert.equal(metrics.byInstrumentFamily[family]?.recallBasisPoints, 10_000);
  }
  assert.equal(metrics.byCorpusKind['real-mix']?.recallBasisPoints, 10_000);
  assert.equal(metrics.byCorpusKind['isolated-control']?.recallBasisPoints, 10_000);
  assert.equal(metrics.byKind['specific-instrument-or-voice'].recallBasisPoints, 10_000);
});

test('parent labels remain separate and uncertainty, false alerts, and outages stay visible', () => {
  const plan = loadInstrumentEvaluationPlan(repositoryRoot);
  const planSha256 = instrumentEvaluationPlanSha256(repositoryRoot);
  const reviewValue = completeReview(plan);
  const trumpetSource = reviewValue.sources.find(({ id }) => id === 'trumpet-an1')!;
  trumpetSource.verdicts.find(({ instrumentId }) => instrumentId === 'brass')!.verdict = 'audible';
  const firstSource = reviewValue.sources[0];
  firstSource.verdicts.find(({ instrumentId }) => instrumentId === 'classical-guitar')!.verdict =
    'uncertain';
  const review = validateInstrumentEvaluationReview(reviewValue, plan, planSha256);
  const candidateValue = perfectCandidate(plan, review);
  candidateValue.sources[0].detections.push({
    instrumentId: 'tuba',
    state: 'possible',
    confidence: 0.6,
  });
  const voice = candidateValue.sources[0].detections.find(({ instrumentId }) => instrumentId === 'voice')!;
  voice.state = 'uncertain';
  candidateValue.sources[1].status = 'degraded';
  candidateValue.sources[1].detections = [];
  const candidate = validateInstrumentCandidateObservations(
    candidateValue,
    plan,
    planSha256
  );
  const metrics = evaluateInstrumentCandidate(plan, review, candidate);

  assert.equal(metrics.byInstrument.brass.truePositive, 1);
  assert.equal(metrics.byKind['family-or-ensemble'].truePositive, 1);
  assert.equal(
    metrics.byInstrumentFamily.brass.truePositive,
    metrics.byInstrument.trumpet.truePositive +
      metrics.byInstrument.trombone.truePositive +
      metrics.byInstrument.horn.truePositive +
      metrics.byInstrument.tuba.truePositive,
    'the brass parent label must not be counted as another specific brass instrument'
  );
  assert.equal(metrics.byInstrument.tuba.falsePositive, 1);
  assert.ok(metrics.diagnosticAllLabels.candidateUncertain >= 1);
  assert.ok(metrics.diagnosticAllLabels.serviceFailureDecisions > 0);
  assert.deepEqual(metrics.coverage.degradedSources, [
    'authorized-classroom-mixes-v1/orchestral',
  ]);
  assert.ok(metrics.coverageBlockers.includes('review-uncertainty-present'));
  assert.ok(metrics.coverageBlockers.includes('candidate-service-failure-present'));
  assert.equal(metrics.promotionEligible, false);
});
