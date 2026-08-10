import { createHash } from 'node:crypto';

import {
  INSTRUMENT_EVALUATION_PLAN_PATH,
  evaluateInstrumentCandidate,
  validateInstrumentCandidateObservations,
  validateInstrumentEvaluationReview,
  type InstrumentCandidateObservationsV3,
  type InstrumentEvaluationMetricsV3,
  type InstrumentEvaluationPlanV1,
} from './instrument-evaluation.mts';

export const INSTRUMENT_CANDIDATE_COMPARISON_SCHEMA =
  'stem-splitter.instrument-candidate-comparison.v1' as const;

const SHA256 = /^[a-f0-9]{64}$/;
export const INSTRUMENT_CANDIDATE_COMPARISON_MAX_REVIEW_BYTES = 2 * 1024 * 1024;
export const INSTRUMENT_CANDIDATE_COMPARISON_MAX_CANDIDATE_BYTES = 16 * 1024 * 1024;
export const INSTRUMENT_CANDIDATE_COMPARISON_MAX_CANDIDATES = 8;

type JsonRecord = Record<string, unknown>;

export interface InstrumentCandidateComparisonV1 {
  $schema: typeof INSTRUMENT_CANDIDATE_COMPARISON_SCHEMA;
  planPath: typeof INSTRUMENT_EVALUATION_PLAN_PATH;
  planVersion: string;
  planSha256: string;
  review: {
    artifactSha256: string;
    privateReviewSha256: string;
    curatedAt: string;
    status: 'reviewed-deidentified-ground-truth';
  };
  comparisonUse: 'comparison-only-no-selection';
  candidates: Array<{
    artifactSha256: string;
    identitySha256: string;
    metrics: InstrumentEvaluationMetricsV3;
  }>;
  comparable: boolean;
  comparisonBlockers: string[];
  selection: {
    selectedClassifierVersion: null;
    qualityFloorVersion: null;
    licenseEvidenceBound: false;
    calibrationEvidenceBound: false;
    latencyMemoryEvidenceBound: false;
    railwayShadowEvidenceBound: false;
    eligible: false;
    blockers: string[];
  };
  caveat: string;
}

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (record(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('candidate identity contains an unsupported value');
  return encoded;
}

function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseJsonBytes(bytes: Uint8Array, maximumBytes: number, context: string): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > maximumBytes) {
    throw new Error(`${context} is not a bounded JSON artifact`);
  }
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error(`${context} is not valid JSON`);
  }
}

function candidateIdentitySha256(
  candidate: InstrumentCandidateObservationsV3['candidate']
): string {
  return sha256Bytes(stableJson(candidate));
}

function assertVersionContentIdentity(
  candidates: readonly InstrumentCandidateObservationsV3[]
): void {
  const classifierVersions = new Map<string, string>();
  const componentVersions = {
    preprocessing: new Map<string, string>(),
    'classifier-policy': new Map<string, string>(),
    'threshold-policy': new Map<string, string>(),
  };

  for (const observation of candidates) {
    const candidate = observation.candidate;
    const identitySha256 = candidateIdentitySha256(candidate);
    const existingClassifier = classifierVersions.get(candidate.classifierVersion);
    if (existingClassifier) {
      if (existingClassifier !== identitySha256) {
        throw new Error(
          `classifier version ${candidate.classifierVersion} was reused after its candidate identity changed`
        );
      }
      throw new Error(`candidate cohort repeats classifier version ${candidate.classifierVersion}`);
    }
    classifierVersions.set(candidate.classifierVersion, identitySha256);

    const components = [
      {
        kind: 'preprocessing' as const,
        version: candidate.preprocessingVersion,
        sha256: candidate.preprocessingSha256,
      },
      {
        kind: 'classifier-policy' as const,
        version: candidate.classifierPolicyVersion,
        sha256: candidate.classifierPolicySha256,
      },
      {
        kind: 'threshold-policy' as const,
        version: candidate.thresholdPolicyVersion,
        sha256: candidate.thresholdPolicySha256,
      },
    ];
    for (const component of components) {
      const versions = componentVersions[component.kind];
      const existingSha256 = versions.get(component.version);
      if (existingSha256 && existingSha256 !== component.sha256) {
        throw new Error(
          `${component.kind} version ${component.version} was reused with different content`
        );
      }
      versions.set(component.version, component.sha256);
    }
  }
}

export function compareInstrumentCandidateArtifacts(
  plan: InstrumentEvaluationPlanV1,
  planSha256: string,
  reviewArtifactBytes: Uint8Array,
  candidateArtifactBytes: readonly Uint8Array[]
): InstrumentCandidateComparisonV1 {
  if (!SHA256.test(planSha256)) throw new Error('instrument evaluation plan SHA-256 is invalid');
  if (
    candidateArtifactBytes.length < 1 ||
    candidateArtifactBytes.length > INSTRUMENT_CANDIDATE_COMPARISON_MAX_CANDIDATES
  ) {
    throw new Error(
      `candidate comparison requires between 1 and ${INSTRUMENT_CANDIDATE_COMPARISON_MAX_CANDIDATES} artifacts`
    );
  }

  const reviewBytes = Buffer.from(reviewArtifactBytes);
  const review = validateInstrumentEvaluationReview(
    parseJsonBytes(
      reviewBytes,
      INSTRUMENT_CANDIDATE_COMPARISON_MAX_REVIEW_BYTES,
      'instrument review artifact'
    ),
    plan,
    planSha256
  );
  const candidateArtifacts = candidateArtifactBytes.map((rawBytes, index) => {
    const bytes = Buffer.from(rawBytes);
    const observations = validateInstrumentCandidateObservations(
      parseJsonBytes(
        bytes,
        INSTRUMENT_CANDIDATE_COMPARISON_MAX_CANDIDATE_BYTES,
        `instrument candidate artifact ${index + 1}`
      ),
      plan,
      planSha256
    );
    return {
      artifactSha256: sha256Bytes(bytes),
      observations,
    };
  });

  assertVersionContentIdentity(candidateArtifacts.map(({ observations }) => observations));

  const candidates = candidateArtifacts
    .map(({ artifactSha256, observations }) => ({
      artifactSha256,
      identitySha256: candidateIdentitySha256(observations.candidate),
      metrics: evaluateInstrumentCandidate(plan, review, observations),
    }))
    .sort((left, right) =>
      left.metrics.candidate.classifierVersion.localeCompare(
        right.metrics.candidate.classifierVersion
      )
    );

  const comparisonBlockers: string[] = [];
  if (candidates.length < 2) comparisonBlockers.push('minimum-two-candidates-missing');
  for (const candidate of candidates) {
    const classifierVersion = candidate.metrics.candidate.classifierVersion;
    if (!candidate.metrics.coverageReady) {
      comparisonBlockers.push(`candidate-coverage-incomplete:${classifierVersion}`);
    }
    if (candidate.metrics.diagnosticAllLabels.classifiedDecisions === 0) {
      comparisonBlockers.push(`candidate-no-classified-decisions:${classifierVersion}`);
    }
  }

  const selectionBlockers = [
    ...comparisonBlockers,
    'candidate-quality-floor-not-bound',
    'candidate-license-evidence-not-bound',
    'candidate-calibration-evidence-not-bound',
    'candidate-latency-memory-evidence-not-bound',
    'human-selection-decision-missing',
    'railway-shadow-evidence-missing',
  ];

  return {
    $schema: INSTRUMENT_CANDIDATE_COMPARISON_SCHEMA,
    planPath: INSTRUMENT_EVALUATION_PLAN_PATH,
    planVersion: plan.version,
    planSha256,
    review: {
      artifactSha256: sha256Bytes(reviewBytes),
      privateReviewSha256: review.privateReviewSha256,
      curatedAt: review.curatedAt,
      status: review.status,
    },
    comparisonUse: 'comparison-only-no-selection',
    candidates,
    comparable: comparisonBlockers.length === 0,
    comparisonBlockers,
    selection: {
      selectedClassifierVersion: null,
      qualityFloorVersion: null,
      licenseEvidenceBound: false,
      calibrationEvidenceBound: false,
      latencyMemoryEvidenceBound: false,
      railwayShadowEvidenceBound: false,
      eligible: false,
      blockers: selectionBlockers,
    },
    caveat:
      'Comparability means that at least two pin-complete candidates produced classified decisions against one exact reviewed plan. It is not a quality, license, calibration, Railway, or model-selection decision, and it cannot change core 2/4/6 routing.',
  };
}

export function summarizeInstrumentCandidateComparison(
  plan: InstrumentEvaluationPlanV1,
  planSha256: string
) {
  if (!SHA256.test(planSha256)) throw new Error('instrument evaluation plan SHA-256 is invalid');
  return {
    schema: INSTRUMENT_CANDIDATE_COMPARISON_SCHEMA,
    planPath: INSTRUMENT_EVALUATION_PLAN_PATH,
    planVersion: plan.version,
    planSha256,
    status: 'inputs-missing-no-comparison-claim',
    requiredInputs: {
      deidentifiedReviewArtifacts: 1,
      minimumCandidateArtifacts: 2,
      maximumCandidateArtifacts: INSTRUMENT_CANDIDATE_COMPARISON_MAX_CANDIDATES,
    },
    comparable: false,
    blockers: [
      'exhaustive-deidentified-review-missing',
      'minimum-two-candidates-missing',
      'candidate-quality-floor-not-bound',
      'candidate-license-evidence-not-bound',
      'candidate-calibration-evidence-not-bound',
      'candidate-latency-memory-evidence-not-bound',
      'human-selection-decision-missing',
      'railway-shadow-evidence-missing',
    ],
  };
}
