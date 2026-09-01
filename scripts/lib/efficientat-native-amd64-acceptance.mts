import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const EFFICIENTAT_NATIVE_AMD64_ACCEPTANCE_PATH =
  'docs/acceptance/2026-08-31-efficientat-native-amd64/evidence.json' as const;
export const EFFICIENTAT_NATIVE_AMD64_ACCEPTANCE_SCHEMA =
  'stem-splitter.efficientat-native-amd64-acceptance.v1' as const;

const SOURCE_COMMIT = '4e6c6bc61d1c3f8195a8c0f277bf0df9331a6e7d';
const WORKFLOW_SHA256 = '56bfc08905faf1a0e27fa2ce1c6434129fded2a410a4328c88c9dee17f1f3d03';
const CORE_REVIEW_SHA256 = 'f96a81c9186ac6d3f27b99bac2cbf2bc3d73a12359b49d24c9398f46b9405ca7';
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_SHA256 = /^sha256:[a-f0-9]{64}$/;
const EXPECTED_FILES = new Map([
  [
    'efficientat-native-amd64-corpus.json',
    {
      schema: 'stem-splitter.efficientat-comparator-evaluation.v2',
      bytes: 137_909,
      sha256: '2ed33dddddff80804f0dd0eb06d84a921181ff571dad2c1ae587463518c1454c',
    },
  ],
  [
    'efficientat-native-amd64-controls.json',
    {
      schema: 'stem-splitter.efficientat-control-evaluation.v1',
      bytes: 54_300,
      sha256: '97094a86dd42b65dc6e80cbfa89c7bfeb4e9c36ae1bdf0993bba1a4a55c251dc',
    },
  ],
  [
    'instrument-classifier-comparison.json',
    {
      schema: 'stem-splitter.instrument-classifier-comparison.v1',
      bytes: 3_675,
      sha256: '0157b888f53acd644e79a5cc6af1c549bc6eb3f7c857a1cdd1c636516a8ea418',
    },
  ],
]);

type JsonRecord = Record<string, unknown>;

function record(value: unknown, context: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], context: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${context} does not match the pinned schema`);
  }
}

function integer(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${context} must be a non-negative integer`);
  }
  return value as number;
}

function canonicalIso(value: unknown, context: string): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${context} must be a canonical UTC timestamp`);
  }
  return value;
}

function requireFalse(value: unknown, context: string): void {
  if (value !== false) throw new Error(`${context} must remain false`);
}

function fixedSummary(
  value: unknown,
  expected: Record<string, number>,
  context: string
): JsonRecord {
  const parsed = record(value, context);
  for (const [key, wanted] of Object.entries(expected)) {
    if (integer(parsed[key], `${context} ${key}`) !== wanted) {
      throw new Error(`${context} ${key} drifted`);
    }
  }
  if (parsed.thresholdSelected !== null) throw new Error(`${context} selected a threshold`);
  requireFalse(parsed.promotionEligible, `${context} promotion eligibility`);
  return parsed;
}

export function validateEfficientatNativeAmd64Acceptance(value: unknown): JsonRecord {
  const root = record(value, 'EfficientAT native acceptance');
  exactKeys(
    root,
    [
      '$schema', 'status', 'capturedAt', 'source', 'artifact', 'execution', 'candidate',
      'corpus', 'controls', 'comparison', 'humanReview', 'safety', 'remainingBlockers',
    ],
    'EfficientAT native acceptance'
  );
  if (
    root.$schema !== EFFICIENTAT_NATIVE_AMD64_ACCEPTANCE_SCHEMA ||
    root.status !== 'passed-comparison-only'
  ) {
    throw new Error('EfficientAT native acceptance identity drifted');
  }
  const capturedAt = canonicalIso(root.capturedAt, 'capturedAt');

  const source = record(root.source, 'source');
  exactKeys(
    source,
    [
      'commit', 'branch', 'workflow', 'workflowPath', 'workflowSha256', 'runId', 'runUrl',
      'jobId', 'job', 'conclusion', 'sourceGateRunId', 'sourceGateConclusion',
    ],
    'source'
  );
  if (
    source.commit !== SOURCE_COMMIT ||
    source.branch !== 'main' ||
    source.workflow !== 'EfficientAT comparator image' ||
    source.workflowPath !== '.github/workflows/efficientat-comparator-image.yml' ||
    source.workflowSha256 !== WORKFLOW_SHA256 ||
    source.runId !== '33453966641' ||
    source.runUrl !==
      'https://github.com/CUNY-AI-Lab/stem-splitter/actions/runs/33453966641' ||
    source.jobId !== '99689833333' ||
    source.job !== 'Pinned EfficientAT comparator (native amd64)' ||
    source.conclusion !== 'success' ||
    source.sourceGateRunId !== '33453966663' ||
    source.sourceGateConclusion !== 'success'
  ) {
    throw new Error('source run identity is not accepted');
  }

  const artifact = record(root.artifact, 'artifact');
  exactKeys(
    artifact,
    ['id', 'name', 'compressedBytes', 'uncompressedBytes', 'expiresAt', 'containsAudio', 'files'],
    'artifact'
  );
  if (
    artifact.id !== '9780824293' ||
    artifact.name !== `efficientat-native-amd64-${SOURCE_COMMIT}` ||
    integer(artifact.compressedBytes, 'artifact compressed bytes') !== 26_933 ||
    artifact.containsAudio !== false
  ) {
    throw new Error('artifact identity or safety boundary drifted');
  }
  if (Date.parse(canonicalIso(artifact.expiresAt, 'artifact expiry')) <= Date.parse(capturedAt)) {
    throw new Error('artifact expiry must follow capture');
  }
  const files = Array.isArray(artifact.files) ? artifact.files : [];
  if (files.length !== EXPECTED_FILES.size) throw new Error('artifact file count drifted');
  let uncompressedBytes = 0;
  const seen = new Set<string>();
  for (const rawFile of files) {
    const file = record(rawFile, 'artifact file');
    exactKeys(file, ['name', 'schema', 'bytes', 'sha256'], 'artifact file');
    const name = typeof file.name === 'string' ? file.name : '';
    const expected = EXPECTED_FILES.get(name);
    if (
      !expected ||
      seen.has(name) ||
      file.schema !== expected.schema ||
      file.bytes !== expected.bytes ||
      file.sha256 !== expected.sha256
    ) {
      throw new Error('artifact file surface drifted');
    }
    seen.add(name);
    uncompressedBytes += expected.bytes;
  }
  if (uncompressedBytes !== artifact.uncompressedBytes) {
    throw new Error('artifact uncompressed byte count drifted');
  }

  const execution = record(root.execution, 'execution');
  exactKeys(
    execution,
    [
      'imageId', 'imagePlatform', 'hostPlatform', 'emulated', 'imageBytes',
      'dependencyLockSha256', 'node', 'python', 'ffmpeg', 'ffprobe',
    ],
    'execution'
  );
  if (
    execution.imageId !==
      'sha256:f392155f2553ea8da35c24b7c096eda1c0a00c428c6d124d9bee55438c2748f9' ||
    !IMAGE_SHA256.test(execution.imageId as string) ||
    execution.imagePlatform !== 'linux/amd64' ||
    execution.hostPlatform !== 'linux/amd64' ||
    execution.emulated !== false ||
    integer(execution.imageBytes, 'image bytes') !== 1_066_431_830 ||
    execution.dependencyLockSha256 !==
      'f643d38b73c995fead2836f71867603657e3ff5de2459f07d114105384398112' ||
    execution.node !== 'v22.23.1' ||
    execution.python !== '3.12.13' ||
    execution.ffmpeg !== '6.1.1-3ubuntu5' ||
    execution.ffprobe !== '6.1.1-3ubuntu5'
  ) {
    throw new Error('execution is not the accepted native linux/amd64 run');
  }

  const candidate = record(root.candidate, 'candidate');
  exactKeys(
    candidate,
    [
      'classifierVersion', 'officialLicense', 'upstreamRepository', 'upstreamReleaseTag',
      'upstreamRevision', 'modelSha256', 'safeWeightsSha256', 'classMapSha256',
      'mappingSha256', 'vocabularyVersion', 'vocabularySha256', 'supportedLabels',
      'unsupportedLabels', 'thresholdSelected', 'precisionClaim', 'promotionEligible',
    ],
    'candidate'
  );
  if (
    candidate.classifierVersion !==
      'efficientat-mn10-audioset-527-pcm22050-sinc32k-upstream-mel-single-clip-sigmoid-second-window-v1@github-release-v0.0.1' ||
    candidate.officialLicense !== 'MIT' ||
    candidate.upstreamRepository !== 'fschmid56/EfficientAT' ||
    candidate.upstreamReleaseTag !== 'v0.0.1' ||
    candidate.upstreamRevision !== '7e30f2bbe85439c15feedd9ba5ad8bff0a600fee' ||
    candidate.modelSha256 !==
      '0bd7dc2443af498c289a2e739f02ebb515d6aa3fd3ab9db539c86123ae368a4e' ||
    candidate.safeWeightsSha256 !==
      '6082249d637adb6880ff8ecbe7bc917e515ee0fabe1268581f614dc56e5c71a9' ||
    candidate.classMapSha256 !==
      'cdd1049833c4b86127c2773ac0d14a2754b6a6d0d1798002ed5c66e699708429' ||
    candidate.mappingSha256 !==
      'b8aa419a47b612144655b2f3409fbb6eb27aabed79b49717a20f96a0f15ad50d' ||
    candidate.vocabularyVersion !== 'classroom-instruments-v1' ||
    candidate.vocabularySha256 !==
      '72b7ab09cc188bf5cb8b47acf55145c45703cd4368e94c372cce8130f96ba140' ||
    candidate.supportedLabels !== 37 ||
    candidate.unsupportedLabels !== 14 ||
    candidate.thresholdSelected !== null ||
    candidate.precisionClaim !== 'none-review-pending'
  ) {
    throw new Error('candidate identity or review boundary drifted');
  }
  requireFalse(candidate.promotionEligible, 'candidate promotion eligibility');

  const corpus = fixedSummary(root.corpus, {
    sources: 11,
    eligibleExpectedGroups: 40,
    unsupportedExpectedGroups: 2,
    top3ExpectedGroups: 20,
    top5ExpectedGroups: 28,
    top10ExpectedGroups: 30,
    meanReciprocalRankBasisPoints: 3_643,
    totalLoadMs: 1_214,
    totalInferenceMs: 2_144,
    totalComparatorMs: 4_751,
  }, 'corpus');
  exactKeys(
    corpus,
    [
      'sources', 'eligibleExpectedGroups', 'unsupportedExpectedGroups', 'top3ExpectedGroups',
      'top5ExpectedGroups', 'top10ExpectedGroups', 'meanReciprocalRankBasisPoints',
      'totalLoadMs', 'totalInferenceMs', 'totalComparatorMs', 'thresholdSelected',
      'promotionEligible',
    ],
    'corpus'
  );
  const controls = fixedSummary(root.controls, {
    sources: 8,
    eligibleSpecificPositives: 6,
    unsupportedSpecificPositives: 2,
    top1SpecificPositives: 4,
    top3SpecificPositives: 6,
    top5SpecificPositives: 6,
    top10SpecificPositives: 6,
    meanReciprocalRankBasisPoints: 8_056,
    candidateNegativeAnnotations: 286,
    totalLoadMs: 881,
    totalInferenceMs: 1_545,
    totalComparatorMs: 3_431,
  }, 'controls');
  exactKeys(
    controls,
    [
      'sources', 'eligibleSpecificPositives', 'unsupportedSpecificPositives',
      'top1SpecificPositives', 'top3SpecificPositives', 'top5SpecificPositives',
      'top10SpecificPositives', 'meanReciprocalRankBasisPoints',
      'candidateNegativeAnnotations', 'totalLoadMs', 'totalInferenceMs',
      'totalComparatorMs', 'thresholdSelected', 'precisionClaim', 'promotionEligible',
    ],
    'controls'
  );
  if (controls.precisionClaim !== 'none-review-pending') {
    throw new Error('controls made a precision claim');
  }

  const comparison = record(root.comparison, 'comparison');
  exactKeys(
    comparison,
    [
      'baselineClassifier', 'baselineAcceptanceRunId', 'nativeAmd64', 'sameCorpusManifest',
      'sameControlManifest', 'sameVocabulary', 'scoringPoliciesDiffer',
      'scoresDirectlyInterchangeable', 'supportedLabelDelta', 'addedDirectLabels',
      'corpusTop3Delta', 'corpusTop5Delta',
      'corpusMeanReciprocalRankBasisPointsDelta', 'controlTop3Delta',
      'controlMeanReciprocalRankBasisPointsDelta', 'selectedClassifier',
      'thresholdSelected', 'result', 'reason', 'promotionEligible',
    ],
    'comparison'
  );
  if (
    comparison.baselineAcceptanceRunId !== '33450445790' ||
    comparison.nativeAmd64 !== true ||
    comparison.sameCorpusManifest !== true ||
    comparison.sameControlManifest !== true ||
    comparison.sameVocabulary !== true ||
    comparison.scoringPoliciesDiffer !== true ||
    comparison.scoresDirectlyInterchangeable !== false ||
    comparison.supportedLabelDelta !== 1 ||
    JSON.stringify(comparison.addedDirectLabels) !== JSON.stringify(['ukulele']) ||
    comparison.corpusTop3Delta !== 4 ||
    comparison.corpusTop5Delta !== 4 ||
    comparison.corpusMeanReciprocalRankBasisPointsDelta !== 278 ||
    comparison.controlTop3Delta !== 0 ||
    comparison.controlMeanReciprocalRankBasisPointsDelta !== 0 ||
    comparison.selectedClassifier !== null ||
    comparison.thresholdSelected !== null ||
    comparison.result !== 'abstain' ||
    comparison.reason !== 'exhaustive-label-and-isolated-control-review-incomplete'
  ) {
    throw new Error('comparison must remain an exact abstention');
  }
  requireFalse(comparison.promotionEligible, 'comparison promotion eligibility');

  const review = record(root.humanReview, 'human review');
  exactKeys(
    review,
    [
      'coreListeningArtifact', 'coreListeningArtifactSha256', 'coreListeningAccepted',
      'coreReviewedAt', 'instrumentReviewAccepted', 'instrumentReviewCompletedSources',
      'instrumentReviewTotalSources', 'isolatedControlReviewAccepted',
    ],
    'human review'
  );
  if (
    review.coreListeningAccepted !== true ||
    review.coreListeningArtifactSha256 !== CORE_REVIEW_SHA256 ||
    canonicalIso(review.coreReviewedAt, 'core review timestamp') !==
      '2026-08-31T21:28:00.000Z' ||
    review.instrumentReviewAccepted !== false ||
    review.instrumentReviewCompletedSources !== 0 ||
    review.instrumentReviewTotalSources !== 19 ||
    review.isolatedControlReviewAccepted !== false
  ) {
    throw new Error('human-review boundaries drifted');
  }

  const safety = record(root.safety, 'safety');
  exactKeys(
    safety,
    [
      'audioCommitted', 'railwayServiceCreated', 'featureFlagChanged', 'thresholdSelected',
      'precisionClaimMade', 'classifierSelected', 'promotionAuthorized',
    ],
    'safety'
  );
  for (const [key, safetyValue] of Object.entries(safety)) {
    requireFalse(safetyValue, `safety ${key}`);
  }
  if (
    JSON.stringify(root.remainingBlockers) !==
    JSON.stringify([
      'exhaustive-instrument-label-review-missing',
      'isolated-control-review-missing',
      'reviewed-threshold-policy-missing',
      'classifier-selection-missing',
      'railway-discovery-shadow-missing',
    ])
  ) {
    throw new Error('remaining blockers drifted');
  }
  return root;
}

export function loadEfficientatNativeAmd64Acceptance(
  repositoryRoot = process.cwd()
): JsonRecord {
  const bytes = readFileSync(resolve(repositoryRoot, EFFICIENTAT_NATIVE_AMD64_ACCEPTANCE_PATH));
  const validated = validateEfficientatNativeAmd64Acceptance(JSON.parse(bytes.toString('utf8')));
  const files = [
    ['.github/workflows/efficientat-comparator-image.yml', WORKFLOW_SHA256],
    ['docs/acceptance/2026-08-10-v3.2-manual-listening/review.json', CORE_REVIEW_SHA256],
  ] as const;
  for (const [path, expected] of files) {
    const digest = createHash('sha256').update(readFileSync(resolve(repositoryRoot, path))).digest('hex');
    if (!SHA256.test(expected) || digest !== expected) {
      throw new Error(`${path} drifted from EfficientAT native-amd64 acceptance`);
    }
  }
  return validated;
}
