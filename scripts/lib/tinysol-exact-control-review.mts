import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import {
  TINYSOL_EXACT_CONTROL_MANIFEST_PATH,
  TINYSOL_EXACT_CONTROL_MANIFEST_SHA256,
  TINYSOL_EXACT_CONTROL_OUTPUT_DIRECTORY,
  TINYSOL_EXACT_CONTROL_VERSION,
  tinySolExactControlPath,
  type TinySolExactControl,
  type TinySolExactControlManifest,
} from './tinysol-exact-control-corpus.mts';

export const PRIVATE_TINYSOL_EXACT_CONTROL_REVIEW_SCHEMA =
  'stem-splitter.private-tinysol-exact-control-review.v1' as const;
export const TINYSOL_EXACT_CONTROL_REVIEW_SCHEMA =
  'stem-splitter.tinysol-exact-control-review.v1' as const;
export const TINYSOL_EXACT_CONTROL_REVIEW_PROTOCOL =
  'tinysol-exact-control-listening-v1' as const;
export const TINYSOL_EXACT_CONTROL_REVIEW_ATTESTATION =
  'I listened to every TinySOL control in full, judged whether its dataset-authored instrument label matches the audio, and reviewed its proposed vocabulary mapping; any uncertainty is explicit.' as const;

const PRIVATE_REVIEW_STATUS = 'pending-private-review' as const;
const PUBLIC_REVIEW_STATUS = 'reviewed-deidentified-exact-control-evidence' as const;
const SOURCE_LABEL_VERDICTS = ['matches-audio', 'does-not-match-audio', 'uncertain'] as const;
const VOCABULARY_MAPPING_VERDICTS = ['approved', 'rejected', 'uncertain'] as const;
const SAFE_REVIEWER = /^[A-Za-z0-9][A-Za-z0-9 ._'()-]{0,119}$/;
const SHA256 = /^[a-f0-9]{64}$/;

const PRIVATE_CLAIM_BOUNDARY = Object.freeze({
  datasetGroundTruth: 'dataset-authored-source-label-only',
  humanSourceLabelReviewStatus: 'pending',
  vocabularyMappingReviewStatus: 'pending',
  candidateNegativeReviewStatus: 'not-collected',
  evaluationPlanIntegration: 'not-integrated',
  candidateMetricUse: 'forbidden-until-versioned-integration',
  classifierSelectionUse: 'forbidden',
  promotionEligible: false,
} as const);

const PUBLIC_CLAIM_BOUNDARY = Object.freeze({
  datasetGroundTruth: 'dataset-authored-source-label-only',
  humanSourceLabelReviewStatus: 'complete',
  vocabularyMappingReviewStatus: 'complete',
  candidateNegativeReviewStatus: 'not-collected',
  evaluationPlanIntegration: 'not-integrated',
  candidateMetricUse: 'forbidden-until-versioned-integration',
  classifierSelectionUse: 'forbidden',
  promotionEligible: false,
} as const);

const FIXED_BLOCKERS = Object.freeze([
  'evaluation-plan-integration-missing',
  'candidate-observations-for-expanded-plan-missing',
  'candidate-quality-floor-not-selected',
  'human-candidate-selection-missing',
  'railway-shadow-evidence-missing',
] as const);

type SourceLabelVerdict = (typeof SOURCE_LABEL_VERDICTS)[number];
type PrivateSourceLabelVerdict = SourceLabelVerdict | 'unreviewed';
type VocabularyMappingVerdict = (typeof VOCABULARY_MAPPING_VERDICTS)[number];
type PrivateVocabularyMappingVerdict = VocabularyMappingVerdict | 'unreviewed';
type JsonRecord = Record<string, unknown>;

export interface VerifiedTinySolExactControlAudio {
  id: string;
  audioPath: string;
  bytes: number;
  sha256: string;
}

export interface PrivateTinySolExactControlReviewV1 {
  $schema: typeof PRIVATE_TINYSOL_EXACT_CONTROL_REVIEW_SCHEMA;
  manifestPath: typeof TINYSOL_EXACT_CONTROL_MANIFEST_PATH;
  manifestVersion: typeof TINYSOL_EXACT_CONTROL_VERSION;
  manifestSha256: string;
  status: typeof PRIVATE_REVIEW_STATUS;
  reviewProtocolVersion: typeof TINYSOL_EXACT_CONTROL_REVIEW_PROTOCOL;
  reviewer: string;
  reviewedAt: string;
  attestation: string;
  claimBoundary: typeof PRIVATE_CLAIM_BOUNDARY;
  controls: Array<{
    id: string;
    sourceSha256: string;
    datasetInstrument: TinySolExactControl['datasetInstrument'];
    proposedVocabularyId: TinySolExactControl['vocabularyId'];
    audioPath: string;
    wholeSourceListened: boolean;
    sourceLabelVerdict: PrivateSourceLabelVerdict;
    vocabularyMappingVerdict: PrivateVocabularyMappingVerdict;
  }>;
}

export interface TinySolExactControlReviewSummary {
  controlCount: 5;
  sourceLabelVerdicts: {
    matchesAudio: number;
    doesNotMatchAudio: number;
    uncertain: number;
  };
  vocabularyMappingVerdicts: {
    approved: number;
    rejected: number;
    uncertain: number;
  };
  allSourceLabelsConfirmed: boolean;
  allVocabularyMappingsApproved: boolean;
  contrabassToDoubleBassApproved: boolean;
}

export interface TinySolExactControlReviewV1 {
  $schema: typeof TINYSOL_EXACT_CONTROL_REVIEW_SCHEMA;
  manifestPath: typeof TINYSOL_EXACT_CONTROL_MANIFEST_PATH;
  manifestVersion: typeof TINYSOL_EXACT_CONTROL_VERSION;
  manifestSha256: string;
  status: typeof PUBLIC_REVIEW_STATUS;
  reviewProtocolVersion: typeof TINYSOL_EXACT_CONTROL_REVIEW_PROTOCOL;
  privateReviewSha256: string;
  curatedAt: string;
  reviewAuthority: 'teacher-or-domain-reviewer';
  deidentified: true;
  rawTeacherFeedbackIncluded: false;
  attestation: typeof TINYSOL_EXACT_CONTROL_REVIEW_ATTESTATION;
  claimBoundary: typeof PUBLIC_CLAIM_BOUNDARY;
  reviewSummary: TinySolExactControlReviewSummary;
  blockers: string[];
  controls: Array<{
    id: string;
    sourceSha256: string;
    datasetInstrument: TinySolExactControl['datasetInstrument'];
    proposedVocabularyId: TinySolExactControl['vocabularyId'];
    wholeSourceListened: true;
    sourceLabelVerdict: SourceLabelVerdict;
    vocabularyMappingVerdict: VocabularyMappingVerdict;
  }>;
}

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const pinned = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(pinned)) {
    throw new Error(`${context} does not match the pinned schema`);
  }
}

function exactJson(value: unknown, expected: unknown, context: string): void {
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(`${context} drifted from the non-promotion boundary`);
  }
}

function canonicalIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifestPath(repositoryRoot: string): string {
  const root = realpathSync(resolve(repositoryRoot));
  const path = resolve(root, TINYSOL_EXACT_CONTROL_MANIFEST_PATH);
  if (!path.startsWith(`${root}${sep}`)) {
    throw new Error('TinySOL review manifest path escaped the repository');
  }
  return path;
}

export function tinySolExactControlManifestSha256(repositoryRoot = process.cwd()): string {
  const path = manifestPath(repositoryRoot);
  const metadata = lstatSync(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size < 2 ||
    metadata.size > 256 * 1024 ||
    realpathSync(path) !== path
  ) {
    throw new Error('TinySOL review manifest is not a bounded regular repository file');
  }
  return sha256(readFileSync(path));
}

export function verifyHydratedTinySolExactControls(
  repositoryRoot: string,
  manifest: TinySolExactControlManifest
): VerifiedTinySolExactControlAudio[] {
  const root = realpathSync(resolve(repositoryRoot));
  return manifest.controls.map((control) => {
    const path = tinySolExactControlPath(root, manifest, control);
    let metadata;
    let bytes: Buffer;
    try {
      metadata = lstatSync(path);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        metadata.size !== control.media.bytes ||
        (metadata.mode & 0o077) !== 0 ||
        realpathSync(path) !== path
      ) {
        throw new Error('identity mismatch');
      }
      bytes = readFileSync(path);
    } catch {
      throw new Error(
        `${control.id}: hydrate the pinned owner-only TinySOL WAV before preparing or finalizing review`
      );
    }
    if (sha256(bytes) !== control.media.sha256) {
      throw new Error(`${control.id}: hydrated TinySOL review audio drifted from its SHA-256 pin`);
    }
    return {
      id: control.id,
      audioPath: `${manifest.archive.outputDirectory}/${control.localFile}`,
      bytes: bytes.byteLength,
      sha256: control.media.sha256,
    };
  });
}

function assertReviewIdentity(
  manifest: TinySolExactControlManifest,
  manifestSha256: string
): void {
  if (
    manifest.version !== TINYSOL_EXACT_CONTROL_VERSION ||
    manifestSha256 !== TINYSOL_EXACT_CONTROL_MANIFEST_SHA256 ||
    !SHA256.test(manifestSha256) ||
    manifest.controls.length !== 5 ||
    manifest.claimPolicy.exactInstrumentClaims !== 'source-label-only' ||
    manifest.claimPolicy.currentEvaluationPlanUse !== 'forbidden'
  ) {
    throw new Error('TinySOL review manifest identity is invalid');
  }
}

function privateControl(
  control: TinySolExactControl
): PrivateTinySolExactControlReviewV1['controls'][number] {
  return {
    id: control.id,
    sourceSha256: control.media.sha256,
    datasetInstrument: control.datasetInstrument,
    proposedVocabularyId: control.vocabularyId,
    audioPath: `${TINYSOL_EXACT_CONTROL_OUTPUT_DIRECTORY}/${control.localFile}`,
    wholeSourceListened: false,
    sourceLabelVerdict: 'unreviewed',
    vocabularyMappingVerdict: 'unreviewed',
  };
}

export function createPrivateTinySolExactControlReviewTemplate(
  manifest: TinySolExactControlManifest,
  manifestSha256: string
): PrivateTinySolExactControlReviewV1 {
  assertReviewIdentity(manifest, manifestSha256);
  return {
    $schema: PRIVATE_TINYSOL_EXACT_CONTROL_REVIEW_SCHEMA,
    manifestPath: TINYSOL_EXACT_CONTROL_MANIFEST_PATH,
    manifestVersion: TINYSOL_EXACT_CONTROL_VERSION,
    manifestSha256,
    status: PRIVATE_REVIEW_STATUS,
    reviewProtocolVersion: TINYSOL_EXACT_CONTROL_REVIEW_PROTOCOL,
    reviewer: '',
    reviewedAt: '',
    attestation: '',
    claimBoundary: { ...PRIVATE_CLAIM_BOUNDARY },
    controls: manifest.controls.map(privateControl),
  };
}

function sourceLabelVerdict(value: unknown, context: string): SourceLabelVerdict {
  if (typeof value !== 'string' || !(SOURCE_LABEL_VERDICTS as readonly string[]).includes(value)) {
    throw new Error(`${context} source-label verdict is unreviewed or invalid`);
  }
  return value as SourceLabelVerdict;
}

function vocabularyMappingVerdict(value: unknown, context: string): VocabularyMappingVerdict {
  if (
    typeof value !== 'string' ||
    !(VOCABULARY_MAPPING_VERDICTS as readonly string[]).includes(value)
  ) {
    throw new Error(`${context} vocabulary-mapping verdict is unreviewed or invalid`);
  }
  return value as VocabularyMappingVerdict;
}

function validatePrivateControl(
  value: unknown,
  control: TinySolExactControl,
  index: number
): TinySolExactControlReviewV1['controls'][number] {
  const context = `private TinySOL review control ${index + 1}`;
  if (!record(value)) throw new Error(`${context} is invalid`);
  exactKeys(
    value,
    [
      'id',
      'sourceSha256',
      'datasetInstrument',
      'proposedVocabularyId',
      'audioPath',
      'wholeSourceListened',
      'sourceLabelVerdict',
      'vocabularyMappingVerdict',
    ],
    context
  );
  if (
    value.id !== control.id ||
    value.sourceSha256 !== control.media.sha256 ||
    value.datasetInstrument !== control.datasetInstrument ||
    value.proposedVocabularyId !== control.vocabularyId ||
    value.audioPath !== `${TINYSOL_EXACT_CONTROL_OUTPUT_DIRECTORY}/${control.localFile}` ||
    value.wholeSourceListened !== true
  ) {
    throw new Error(`${context} is incomplete or drifted from the pinned source`);
  }
  return {
    id: control.id,
    sourceSha256: control.media.sha256,
    datasetInstrument: control.datasetInstrument,
    proposedVocabularyId: control.vocabularyId,
    wholeSourceListened: true,
    sourceLabelVerdict: sourceLabelVerdict(value.sourceLabelVerdict, context),
    vocabularyMappingVerdict: vocabularyMappingVerdict(
      value.vocabularyMappingVerdict,
      context
    ),
  };
}

function summarizeControls(
  controls: TinySolExactControlReviewV1['controls']
): TinySolExactControlReviewSummary {
  const sourceLabelVerdicts = {
    matchesAudio: controls.filter(({ sourceLabelVerdict: verdict }) => verdict === 'matches-audio').length,
    doesNotMatchAudio: controls.filter(
      ({ sourceLabelVerdict: verdict }) => verdict === 'does-not-match-audio'
    ).length,
    uncertain: controls.filter(({ sourceLabelVerdict: verdict }) => verdict === 'uncertain').length,
  };
  const vocabularyMappingVerdicts = {
    approved: controls.filter(
      ({ vocabularyMappingVerdict: verdict }) => verdict === 'approved'
    ).length,
    rejected: controls.filter(
      ({ vocabularyMappingVerdict: verdict }) => verdict === 'rejected'
    ).length,
    uncertain: controls.filter(
      ({ vocabularyMappingVerdict: verdict }) => verdict === 'uncertain'
    ).length,
  };
  const contrabass = controls.find(({ datasetInstrument }) => datasetInstrument === 'Contrabass');
  if (!contrabass || contrabass.proposedVocabularyId !== 'double-bass') {
    throw new Error('TinySOL Contrabass mapping identity is unavailable');
  }
  return {
    controlCount: 5,
    sourceLabelVerdicts,
    vocabularyMappingVerdicts,
    allSourceLabelsConfirmed: sourceLabelVerdicts.matchesAudio === controls.length,
    allVocabularyMappingsApproved: vocabularyMappingVerdicts.approved === controls.length,
    contrabassToDoubleBassApproved: contrabass.vocabularyMappingVerdict === 'approved',
  };
}

function blockersFor(summary: TinySolExactControlReviewSummary): string[] {
  const blockers: string[] = [];
  if (!summary.allSourceLabelsConfirmed) blockers.push('source-label-confirmation-incomplete');
  if (!summary.allVocabularyMappingsApproved) blockers.push('vocabulary-mapping-approval-incomplete');
  if (!summary.contrabassToDoubleBassApproved) {
    blockers.push('contrabass-double-bass-mapping-approval-missing');
  }
  blockers.push(...FIXED_BLOCKERS);
  return blockers;
}

export function finalizePrivateTinySolExactControlReview(
  value: unknown,
  serializedPrivateReview: string,
  manifest: TinySolExactControlManifest,
  manifestSha256: string
): TinySolExactControlReviewV1 {
  assertReviewIdentity(manifest, manifestSha256);
  if (!record(value)) throw new Error('private TinySOL exact control review is invalid');
  exactKeys(
    value,
    [
      '$schema',
      'manifestPath',
      'manifestVersion',
      'manifestSha256',
      'status',
      'reviewProtocolVersion',
      'reviewer',
      'reviewedAt',
      'attestation',
      'claimBoundary',
      'controls',
    ],
    'private TinySOL exact control review'
  );
  if (
    value.$schema !== PRIVATE_TINYSOL_EXACT_CONTROL_REVIEW_SCHEMA ||
    value.manifestPath !== TINYSOL_EXACT_CONTROL_MANIFEST_PATH ||
    value.manifestVersion !== TINYSOL_EXACT_CONTROL_VERSION ||
    value.manifestSha256 !== manifestSha256 ||
    value.status !== PRIVATE_REVIEW_STATUS ||
    value.reviewProtocolVersion !== TINYSOL_EXACT_CONTROL_REVIEW_PROTOCOL ||
    typeof value.reviewer !== 'string' ||
    !SAFE_REVIEWER.test(value.reviewer) ||
    !canonicalIso(value.reviewedAt) ||
    value.attestation !== TINYSOL_EXACT_CONTROL_REVIEW_ATTESTATION ||
    !Array.isArray(value.controls) ||
    value.controls.length !== manifest.controls.length
  ) {
    throw new Error('private TinySOL exact control review is incomplete or drifted');
  }
  exactJson(value.claimBoundary, PRIVATE_CLAIM_BOUNDARY, 'private TinySOL claim boundary');
  let reparsed: unknown;
  try {
    reparsed = JSON.parse(serializedPrivateReview);
  } catch {
    throw new Error('private TinySOL exact control review bytes are not JSON');
  }
  if (JSON.stringify(reparsed) !== JSON.stringify(value)) {
    throw new Error('private TinySOL exact control review bytes do not match the reviewed value');
  }
  const controls = value.controls.map((rawControl, index) =>
    validatePrivateControl(rawControl, manifest.controls[index], index)
  );
  const reviewSummary = summarizeControls(controls);
  const review: TinySolExactControlReviewV1 = {
    $schema: TINYSOL_EXACT_CONTROL_REVIEW_SCHEMA,
    manifestPath: TINYSOL_EXACT_CONTROL_MANIFEST_PATH,
    manifestVersion: TINYSOL_EXACT_CONTROL_VERSION,
    manifestSha256,
    status: PUBLIC_REVIEW_STATUS,
    reviewProtocolVersion: TINYSOL_EXACT_CONTROL_REVIEW_PROTOCOL,
    privateReviewSha256: sha256(Buffer.from(serializedPrivateReview)),
    curatedAt: value.reviewedAt,
    reviewAuthority: 'teacher-or-domain-reviewer',
    deidentified: true,
    rawTeacherFeedbackIncluded: false,
    attestation: TINYSOL_EXACT_CONTROL_REVIEW_ATTESTATION,
    claimBoundary: { ...PUBLIC_CLAIM_BOUNDARY },
    reviewSummary,
    blockers: blockersFor(reviewSummary),
    controls,
  };
  return validateTinySolExactControlReview(review, manifest, manifestSha256);
}

function validatePublicControl(
  value: unknown,
  control: TinySolExactControl,
  index: number
): TinySolExactControlReviewV1['controls'][number] {
  const context = `public TinySOL review control ${index + 1}`;
  if (!record(value)) throw new Error(`${context} is invalid`);
  exactKeys(
    value,
    [
      'id',
      'sourceSha256',
      'datasetInstrument',
      'proposedVocabularyId',
      'wholeSourceListened',
      'sourceLabelVerdict',
      'vocabularyMappingVerdict',
    ],
    context
  );
  if (
    value.id !== control.id ||
    value.sourceSha256 !== control.media.sha256 ||
    value.datasetInstrument !== control.datasetInstrument ||
    value.proposedVocabularyId !== control.vocabularyId ||
    value.wholeSourceListened !== true
  ) {
    throw new Error(`${context} drifted from the pinned source`);
  }
  return {
    id: control.id,
    sourceSha256: control.media.sha256,
    datasetInstrument: control.datasetInstrument,
    proposedVocabularyId: control.vocabularyId,
    wholeSourceListened: true,
    sourceLabelVerdict: sourceLabelVerdict(value.sourceLabelVerdict, context),
    vocabularyMappingVerdict: vocabularyMappingVerdict(
      value.vocabularyMappingVerdict,
      context
    ),
  };
}

export function validateTinySolExactControlReview(
  value: unknown,
  manifest: TinySolExactControlManifest,
  manifestSha256: string
): TinySolExactControlReviewV1 {
  assertReviewIdentity(manifest, manifestSha256);
  if (!record(value)) throw new Error('public TinySOL exact control review is invalid');
  exactKeys(
    value,
    [
      '$schema',
      'manifestPath',
      'manifestVersion',
      'manifestSha256',
      'status',
      'reviewProtocolVersion',
      'privateReviewSha256',
      'curatedAt',
      'reviewAuthority',
      'deidentified',
      'rawTeacherFeedbackIncluded',
      'attestation',
      'claimBoundary',
      'reviewSummary',
      'blockers',
      'controls',
    ],
    'public TinySOL exact control review'
  );
  if (
    value.$schema !== TINYSOL_EXACT_CONTROL_REVIEW_SCHEMA ||
    value.manifestPath !== TINYSOL_EXACT_CONTROL_MANIFEST_PATH ||
    value.manifestVersion !== TINYSOL_EXACT_CONTROL_VERSION ||
    value.manifestSha256 !== manifestSha256 ||
    value.status !== PUBLIC_REVIEW_STATUS ||
    value.reviewProtocolVersion !== TINYSOL_EXACT_CONTROL_REVIEW_PROTOCOL ||
    typeof value.privateReviewSha256 !== 'string' ||
    !SHA256.test(value.privateReviewSha256) ||
    !canonicalIso(value.curatedAt) ||
    value.reviewAuthority !== 'teacher-or-domain-reviewer' ||
    value.deidentified !== true ||
    value.rawTeacherFeedbackIncluded !== false ||
    value.attestation !== TINYSOL_EXACT_CONTROL_REVIEW_ATTESTATION ||
    !Array.isArray(value.controls) ||
    value.controls.length !== manifest.controls.length
  ) {
    throw new Error('public TinySOL exact control review is incomplete or drifted');
  }
  exactJson(value.claimBoundary, PUBLIC_CLAIM_BOUNDARY, 'public TinySOL claim boundary');
  const controls = value.controls.map((rawControl, index) =>
    validatePublicControl(rawControl, manifest.controls[index], index)
  );
  const reviewSummary = summarizeControls(controls);
  exactJson(value.reviewSummary, reviewSummary, 'public TinySOL review summary');
  exactJson(value.blockers, blockersFor(reviewSummary), 'public TinySOL review blockers');
  return { ...value, reviewSummary, controls } as unknown as TinySolExactControlReviewV1;
}
