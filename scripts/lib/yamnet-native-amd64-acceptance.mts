import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const YAMNET_NATIVE_AMD64_ACCEPTANCE_PATH =
  'docs/acceptance/2026-08-31-yamnet-native-amd64/evidence.json' as const;
export const YAMNET_NATIVE_AMD64_ACCEPTANCE_SCHEMA =
  'stem-splitter.yamnet-native-amd64-acceptance.v1' as const;

const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_SHA256 = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const DECIMAL_ID = /^[1-9][0-9]*$/;
const EXPECTED_FILES = new Map([
  ['yamnet-native-amd64-corpus.json', 'stem-splitter.yamnet-comparator-evaluation.v2'],
  ['yamnet-native-amd64-controls.json', 'stem-splitter.yamnet-control-evaluation.v1'],
  ['yamnet-native-amd64-source-report.json', 'stem-splitter.yamnet-candidate-source-report.v1'],
  ['yamnet-native-amd64-candidate.json', 'stem-splitter.instrument-candidate-observations.v3'],
]);

type JsonRecord = Record<string, unknown>;

function record(value: unknown, context: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${context} does not match the pinned schema`);
  }
}

function string(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${context} must be a string`);
  return value;
}

function integer(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${context} must be a non-negative integer`);
  }
  return value as number;
}

function sha256(value: unknown, context: string): string {
  const parsed = string(value, context);
  if (!SHA256.test(parsed)) throw new Error(`${context} must be a SHA-256`);
  return parsed;
}

function canonicalIso(value: unknown, context: string): string {
  const parsed = string(value, context);
  if (!Number.isFinite(Date.parse(parsed)) || new Date(parsed).toISOString() !== parsed) {
    throw new Error(`${context} must be a canonical UTC timestamp`);
  }
  return parsed;
}

function requireFalse(value: unknown, context: string): void {
  if (value !== false) throw new Error(`${context} must remain false`);
}

export function validateYamnetNativeAmd64Acceptance(value: unknown): JsonRecord {
  const root = record(value, 'YAMNet native acceptance');
  exactKeys(root, [
    '$schema', 'status', 'capturedAt', 'source', 'artifact', 'execution', 'candidate',
    'corpus', 'controls', 'candidateEnvelope', 'humanReview', 'safety', 'remainingBlockers',
  ], 'YAMNet native acceptance');
  if (root.$schema !== YAMNET_NATIVE_AMD64_ACCEPTANCE_SCHEMA) throw new Error('YAMNet native acceptance schema drifted');
  if (root.status !== 'passed-comparison-only') throw new Error('YAMNet native acceptance status drifted');
  const capturedAt = canonicalIso(root.capturedAt, 'capturedAt');

  const source = record(root.source, 'source');
  exactKeys(source, ['commit', 'branch', 'workflow', 'workflowPath', 'workflowSha256', 'runId', 'runUrl', 'jobId', 'job', 'conclusion', 'sourceGateRunId', 'sourceGateConclusion'], 'source');
  const commit = string(source.commit, 'source commit');
  if (!COMMIT.test(commit) || source.branch !== 'main' || source.conclusion !== 'success' || source.sourceGateConclusion !== 'success') {
    throw new Error('source run identity is not accepted');
  }
  const runId = string(source.runId, 'run id');
  if (!DECIMAL_ID.test(runId) || source.runUrl !== `https://github.com/CUNY-AI-Lab/stem-splitter/actions/runs/${runId}`) {
    throw new Error('source run URL does not match the run id');
  }
  if (!DECIMAL_ID.test(string(source.jobId, 'job id')) || !DECIMAL_ID.test(string(source.sourceGateRunId, 'source gate run id'))) {
    throw new Error('GitHub identifiers are invalid');
  }
  sha256(source.workflowSha256, 'workflow SHA-256');

  const artifact = record(root.artifact, 'artifact');
  exactKeys(artifact, ['id', 'name', 'compressedBytes', 'uncompressedBytes', 'expiresAt', 'containsAudio', 'files'], 'artifact');
  if (!DECIMAL_ID.test(string(artifact.id, 'artifact id')) || artifact.name !== `yamnet-native-amd64-${commit}`) {
    throw new Error('artifact identity does not match the source commit');
  }
  if (artifact.containsAudio !== false) throw new Error('native evidence artifact must not contain audio');
  if (Date.parse(canonicalIso(artifact.expiresAt, 'artifact expiry')) <= Date.parse(capturedAt)) {
    throw new Error('artifact expiry must follow capture');
  }
  integer(artifact.compressedBytes, 'artifact compressed bytes');
  const files = Array.isArray(artifact.files) ? artifact.files : [];
  if (files.length !== EXPECTED_FILES.size) throw new Error('artifact must contain exactly four JSON reports');
  let uncompressedBytes = 0;
  const seen = new Set<string>();
  for (const [index, rawFile] of files.entries()) {
    const file = record(rawFile, `artifact file ${index}`);
    exactKeys(file, ['name', 'schema', 'bytes', 'sha256'], `artifact file ${index}`);
    const name = string(file.name, `artifact file ${index} name`);
    if (seen.has(name) || file.schema !== EXPECTED_FILES.get(name)) throw new Error('artifact file surface drifted');
    seen.add(name);
    const bytes = integer(file.bytes, `artifact file ${name} bytes`);
    if (bytes < 2) throw new Error(`artifact file ${name} is empty`);
    uncompressedBytes += bytes;
    sha256(file.sha256, `artifact file ${name} SHA-256`);
  }
  if (uncompressedBytes !== integer(artifact.uncompressedBytes, 'artifact uncompressed bytes')) {
    throw new Error('artifact uncompressed byte count drifted');
  }

  const execution = record(root.execution, 'execution');
  exactKeys(execution, ['imageId', 'imagePlatform', 'hostPlatform', 'emulated', 'imageBytes', 'dependencyLockSha256', 'node', 'ffmpeg', 'ffprobe'], 'execution');
  if (!IMAGE_SHA256.test(string(execution.imageId, 'image id')) || execution.imagePlatform !== 'linux/amd64' || execution.hostPlatform !== 'linux/amd64' || execution.emulated !== false) {
    throw new Error('execution is not native linux/amd64');
  }
  if (integer(execution.imageBytes, 'image bytes') > 805_306_368) throw new Error('image exceeds the accepted ceiling');
  sha256(execution.dependencyLockSha256, 'dependency lock SHA-256');

  const candidate = record(root.candidate, 'candidate');
  exactKeys(candidate, ['classifierVersion', 'officialLicense', 'modelSha256', 'classMapSha256', 'mappingSha256', 'vocabularyVersion', 'vocabularySha256', 'thresholdSelected', 'precisionClaim', 'promotionEligible'], 'candidate');
  for (const key of ['modelSha256', 'classMapSha256', 'mappingSha256', 'vocabularySha256']) sha256(candidate[key], `candidate ${key}`);
  if (candidate.thresholdSelected !== null || candidate.precisionClaim !== 'none-review-pending') throw new Error('candidate must remain threshold-free and review-pending');
  requireFalse(candidate.promotionEligible, 'candidate promotion eligibility');

  const corpus = record(root.corpus, 'corpus');
  if (integer(corpus.sources, 'corpus sources') !== 11 || integer(corpus.eligibleExpectedGroups, 'eligible corpus groups') !== 40 || integer(corpus.top5ExpectedGroups, 'corpus top-five groups') > 40 || corpus.thresholdSelected !== null) {
    throw new Error('corpus summary drifted');
  }
  requireFalse(corpus.promotionEligible, 'corpus promotion eligibility');

  const controls = record(root.controls, 'controls');
  if (integer(controls.sources, 'control sources') !== 8 || integer(controls.eligibleSpecificPositives, 'eligible control positives') !== 6 || integer(controls.candidateNegativeAnnotations, 'candidate negative annotations') !== 278 || controls.thresholdSelected !== null || controls.precisionClaim !== 'none-review-pending') {
    throw new Error('control summary drifted');
  }
  requireFalse(controls.promotionEligible, 'control promotion eligibility');

  const envelope = record(root.candidateEnvelope, 'candidate envelope');
  if (envelope.schema !== 'stem-splitter.instrument-candidate-observations.v3' || integer(envelope.sources, 'candidate sources') !== 19 || integer(envelope.classified, 'classified sources') !== 0 || integer(envelope.abstained, 'abstained sources') !== 19 || integer(envelope.degraded, 'degraded sources') !== 0 || integer(envelope.detections, 'detections') !== 0 || envelope.abstentionReason !== 'no-label-cleared-threshold') {
    throw new Error('candidate envelope must remain abstention-only');
  }
  sha256(envelope.planSha256, 'candidate plan SHA-256');
  requireFalse(envelope.promotionEligible, 'candidate envelope promotion eligibility');

  const review = record(root.humanReview, 'human review');
  if (review.coreListeningAccepted !== true || review.instrumentReviewAccepted !== false || integer(review.instrumentReviewCompletedSources, 'completed instrument-review sources') !== 0 || integer(review.instrumentReviewTotalSources, 'instrument-review source total') !== 19 || review.isolatedControlReviewAccepted !== false) {
    throw new Error('human-review boundaries drifted');
  }
  sha256(review.coreListeningArtifactSha256, 'core listening artifact SHA-256');
  canonicalIso(review.coreReviewedAt, 'core review timestamp');

  const safety = record(root.safety, 'safety');
  exactKeys(safety, ['audioCommitted', 'railwayServiceCreated', 'featureFlagChanged', 'thresholdSelected', 'precisionClaimMade', 'promotionAuthorized'], 'safety');
  for (const [key, value] of Object.entries(safety)) requireFalse(value, `safety ${key}`);

  const blockers = Array.isArray(root.remainingBlockers) ? root.remainingBlockers : [];
  const requiredBlockers = ['exhaustive-instrument-label-review-missing', 'second-license-cleared-classifier-missing', 'reviewed-threshold-policy-missing', 'railway-discovery-shadow-missing'];
  if (!requiredBlockers.every((blocker) => blockers.includes(blocker))) throw new Error('required rollout blockers are missing');
  return root;
}

export function loadYamnetNativeAmd64Acceptance(repositoryRoot = process.cwd()): JsonRecord {
  const bytes = readFileSync(resolve(repositoryRoot, YAMNET_NATIVE_AMD64_ACCEPTANCE_PATH));
  const value = JSON.parse(bytes.toString('utf8')) as unknown;
  const validated = validateYamnetNativeAmd64Acceptance(value);

  const source = record(validated.source, 'source');
  const review = record(validated.humanReview, 'human review');
  const expectedFiles = [
    [string(source.workflowPath, 'workflow path'), string(source.workflowSha256, 'workflow SHA-256')],
    [string(review.coreListeningArtifact, 'core listening artifact'), string(review.coreListeningArtifactSha256, 'core listening SHA-256')],
  ] as const;
  for (const [path, expected] of expectedFiles) {
    const actual = createHash('sha256').update(readFileSync(resolve(repositoryRoot, path))).digest('hex');
    if (actual !== expected) throw new Error(`${path} drifted from native-amd64 acceptance`);
  }
  return validated;
}
