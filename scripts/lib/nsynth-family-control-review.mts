import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { INSTRUMENT_REVIEW_OPTIONS } from '../../src/analysis/instrument-review.ts';
import { INSTRUMENT_EVALUATION_REVIEW_ATTESTATION } from './instrument-evaluation.mts';
import {
  NSYNTH_FAMILY_CONTROL_MANIFEST_PATH,
  NSYNTH_FAMILY_CONTROL_OUTPUT_DIRECTORY,
  NSYNTH_FAMILY_CONTROL_VERSION,
  nsynthFamilyControlPath,
  type NsynthFamilyControl,
  type NsynthFamilyControlManifest,
} from './nsynth-family-control-corpus.mts';

export const PRIVATE_NSYNTH_FAMILY_CONTROL_REVIEW_SCHEMA =
  'stem-splitter.private-nsynth-family-control-review.v1' as const;
export const NSYNTH_FAMILY_CONTROL_REVIEW_SCHEMA =
  'stem-splitter.nsynth-family-control-review.v1' as const;
export const NSYNTH_FAMILY_CONTROL_REVIEW_PROTOCOL =
  'instrument-evaluation-listening-v1' as const;

const PRIVATE_REVIEW_STATUS = 'pending-private-review' as const;
const PUBLIC_REVIEW_STATUS = 'reviewed-deidentified-family-control-evidence' as const;
const VERDICTS = ['audible', 'absent', 'uncertain'] as const;
const SAFE_REVIEWER = /^[A-Za-z0-9][A-Za-z0-9 ._'()-]{0,119}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PRIVATE_CLAIM_BOUNDARY = Object.freeze({
  datasetGroundTruth: 'family-and-source-only',
  exactInstrumentClaims: false,
  vocabularyVerdictStatus: 'pending-human-source-review',
  evaluationPlanIntegration: 'not-integrated',
  candidateMetricUse: 'forbidden-until-versioned-integration',
  promotionEligible: false,
} as const);
const PUBLIC_CLAIM_BOUNDARY = Object.freeze({
  datasetGroundTruth: 'family-and-source-only',
  exactInstrumentClaims: false,
  vocabularyVerdictStatus: 'complete-human-source-review',
  evaluationPlanIntegration: 'not-integrated',
  candidateMetricUse: 'forbidden-until-versioned-integration',
  promotionEligible: false,
  blockers: Object.freeze([
    'evaluation-plan-integration-missing',
    'candidate-observations-for-expanded-plan-missing',
    'candidate-quality-floor-not-selected',
    'human-candidate-selection-missing',
    'railway-shadow-evidence-missing',
  ] as const),
} as const);

type ReviewVerdict = (typeof VERDICTS)[number];
type PrivateReviewVerdict = ReviewVerdict | 'unreviewed';
type JsonRecord = Record<string, unknown>;
type DatasetFamily = NsynthFamilyControl['metadata']['family'];
type DatasetSource = NsynthFamilyControl['metadata']['source'];

export interface VerifiedNsynthFamilyControlAudio {
  id: string;
  audioPath: string;
  bytes: number;
  sha256: string;
}

export interface PrivateNsynthFamilyControlReviewV1 {
  $schema: typeof PRIVATE_NSYNTH_FAMILY_CONTROL_REVIEW_SCHEMA;
  manifestPath: typeof NSYNTH_FAMILY_CONTROL_MANIFEST_PATH;
  manifestVersion: typeof NSYNTH_FAMILY_CONTROL_VERSION;
  manifestSha256: string;
  status: typeof PRIVATE_REVIEW_STATUS;
  reviewProtocolVersion: typeof NSYNTH_FAMILY_CONTROL_REVIEW_PROTOCOL;
  reviewer: string;
  reviewedAt: string;
  attestation: string;
  claimBoundary: typeof PRIVATE_CLAIM_BOUNDARY;
  controls: Array<{
    id: string;
    noteStr: string;
    sourceSha256: string;
    datasetFamily: DatasetFamily;
    datasetSource: DatasetSource;
    audioPath: string;
    wholeSourceListened: boolean;
    verdicts: Array<{ instrumentId: string; verdict: PrivateReviewVerdict }>;
  }>;
}

export interface NsynthFamilyControlReviewV1 {
  $schema: typeof NSYNTH_FAMILY_CONTROL_REVIEW_SCHEMA;
  manifestPath: typeof NSYNTH_FAMILY_CONTROL_MANIFEST_PATH;
  manifestVersion: typeof NSYNTH_FAMILY_CONTROL_VERSION;
  manifestSha256: string;
  status: typeof PUBLIC_REVIEW_STATUS;
  reviewProtocolVersion: typeof NSYNTH_FAMILY_CONTROL_REVIEW_PROTOCOL;
  privateReviewSha256: string;
  curatedAt: string;
  reviewAuthority: 'teacher-or-domain-reviewer';
  deidentified: true;
  rawTeacherFeedbackIncluded: false;
  attestation: typeof INSTRUMENT_EVALUATION_REVIEW_ATTESTATION;
  claimBoundary: typeof PUBLIC_CLAIM_BOUNDARY;
  controls: Array<{
    id: string;
    noteStr: string;
    sourceSha256: string;
    datasetFamily: DatasetFamily;
    datasetSource: DatasetSource;
    wholeSourceListened: true;
    verdicts: Array<{ instrumentId: string; verdict: ReviewVerdict }>;
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
  const path = resolve(root, NSYNTH_FAMILY_CONTROL_MANIFEST_PATH);
  if (!path.startsWith(`${root}${sep}`)) {
    throw new Error('NSynth review manifest path escaped the repository');
  }
  return path;
}

export function nsynthFamilyControlManifestSha256(repositoryRoot = process.cwd()): string {
  const path = manifestPath(repositoryRoot);
  const metadata = lstatSync(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size < 2 ||
    metadata.size > 256 * 1024 ||
    realpathSync(path) !== path
  ) {
    throw new Error('NSynth review manifest is not a bounded regular repository file');
  }
  return sha256(readFileSync(path));
}

export function verifyHydratedNsynthFamilyControls(
  repositoryRoot: string,
  manifest: NsynthFamilyControlManifest
): VerifiedNsynthFamilyControlAudio[] {
  const root = realpathSync(resolve(repositoryRoot));
  return manifest.controls.map((control) => {
    const path = nsynthFamilyControlPath(root, manifest, control);
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
        `${control.id}: hydrate the pinned owner-only NSynth WAV before preparing or finalizing review`
      );
    }
    if (sha256(bytes) !== control.media.sha256) {
      throw new Error(`${control.id}: hydrated NSynth review audio drifted from its SHA-256 pin`);
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
  manifest: NsynthFamilyControlManifest,
  manifestSha256: string
): void {
  if (
    manifest.version !== NSYNTH_FAMILY_CONTROL_VERSION ||
    !SHA256.test(manifestSha256) ||
    manifest.controls.length !== 10
  ) {
    throw new Error('NSynth review manifest identity is invalid');
  }
}

function privateControl(
  control: NsynthFamilyControl
): PrivateNsynthFamilyControlReviewV1['controls'][number] {
  return {
    id: control.id,
    noteStr: control.noteStr,
    sourceSha256: control.media.sha256,
    datasetFamily: control.metadata.family,
    datasetSource: control.metadata.source,
    audioPath: `${NSYNTH_FAMILY_CONTROL_OUTPUT_DIRECTORY}/${control.localFile}`,
    wholeSourceListened: false,
    verdicts: INSTRUMENT_REVIEW_OPTIONS.map(({ id }) => ({
      instrumentId: id,
      verdict: 'unreviewed',
    })),
  };
}

export function createPrivateNsynthFamilyControlReviewTemplate(
  manifest: NsynthFamilyControlManifest,
  manifestSha256: string
): PrivateNsynthFamilyControlReviewV1 {
  assertReviewIdentity(manifest, manifestSha256);
  return {
    $schema: PRIVATE_NSYNTH_FAMILY_CONTROL_REVIEW_SCHEMA,
    manifestPath: NSYNTH_FAMILY_CONTROL_MANIFEST_PATH,
    manifestVersion: NSYNTH_FAMILY_CONTROL_VERSION,
    manifestSha256,
    status: PRIVATE_REVIEW_STATUS,
    reviewProtocolVersion: NSYNTH_FAMILY_CONTROL_REVIEW_PROTOCOL,
    reviewer: '',
    reviewedAt: '',
    attestation: '',
    claimBoundary: { ...PRIVATE_CLAIM_BOUNDARY },
    controls: manifest.controls.map(privateControl),
  };
}

function validateVerdicts(
  value: unknown,
  context: string
): Array<{ instrumentId: string; verdict: ReviewVerdict }> {
  if (!Array.isArray(value) || value.length !== INSTRUMENT_REVIEW_OPTIONS.length) {
    throw new Error(`${context} verdict coverage is incomplete`);
  }
  return value.map((rawVerdict, index) => {
    if (!record(rawVerdict)) throw new Error(`${context} verdict is invalid`);
    exactKeys(rawVerdict, ['instrumentId', 'verdict'], `${context} verdict`);
    if (
      rawVerdict.instrumentId !== INSTRUMENT_REVIEW_OPTIONS[index].id ||
      typeof rawVerdict.verdict !== 'string' ||
      !(VERDICTS as readonly string[]).includes(rawVerdict.verdict)
    ) {
      throw new Error(`${context} contains an unreviewed or reordered verdict`);
    }
    return {
      instrumentId: rawVerdict.instrumentId,
      verdict: rawVerdict.verdict as ReviewVerdict,
    };
  });
}

function validatePrivateControl(
  value: unknown,
  control: NsynthFamilyControl,
  index: number
): NsynthFamilyControlReviewV1['controls'][number] {
  const context = `private NSynth review control ${index + 1}`;
  if (!record(value)) throw new Error(`${context} is invalid`);
  exactKeys(
    value,
    [
      'id',
      'noteStr',
      'sourceSha256',
      'datasetFamily',
      'datasetSource',
      'audioPath',
      'wholeSourceListened',
      'verdicts',
    ],
    context
  );
  if (
    value.id !== control.id ||
    value.noteStr !== control.noteStr ||
    value.sourceSha256 !== control.media.sha256 ||
    value.datasetFamily !== control.metadata.family ||
    value.datasetSource !== control.metadata.source ||
    value.audioPath !== `${NSYNTH_FAMILY_CONTROL_OUTPUT_DIRECTORY}/${control.localFile}` ||
    value.wholeSourceListened !== true
  ) {
    throw new Error(`${context} is incomplete or drifted from the pinned source`);
  }
  return {
    id: control.id,
    noteStr: control.noteStr,
    sourceSha256: control.media.sha256,
    datasetFamily: control.metadata.family,
    datasetSource: control.metadata.source,
    wholeSourceListened: true,
    verdicts: validateVerdicts(value.verdicts, context),
  };
}

export function finalizePrivateNsynthFamilyControlReview(
  value: unknown,
  serializedPrivateReview: string,
  manifest: NsynthFamilyControlManifest,
  manifestSha256: string
): NsynthFamilyControlReviewV1 {
  assertReviewIdentity(manifest, manifestSha256);
  if (!record(value)) throw new Error('private NSynth family control review is invalid');
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
    'private NSynth family control review'
  );
  if (
    value.$schema !== PRIVATE_NSYNTH_FAMILY_CONTROL_REVIEW_SCHEMA ||
    value.manifestPath !== NSYNTH_FAMILY_CONTROL_MANIFEST_PATH ||
    value.manifestVersion !== NSYNTH_FAMILY_CONTROL_VERSION ||
    value.manifestSha256 !== manifestSha256 ||
    value.status !== PRIVATE_REVIEW_STATUS ||
    value.reviewProtocolVersion !== NSYNTH_FAMILY_CONTROL_REVIEW_PROTOCOL ||
    typeof value.reviewer !== 'string' ||
    !SAFE_REVIEWER.test(value.reviewer) ||
    !canonicalIso(value.reviewedAt) ||
    value.attestation !== INSTRUMENT_EVALUATION_REVIEW_ATTESTATION ||
    !Array.isArray(value.controls) ||
    value.controls.length !== manifest.controls.length
  ) {
    throw new Error('private NSynth family control review is incomplete or drifted');
  }
  exactJson(value.claimBoundary, PRIVATE_CLAIM_BOUNDARY, 'private NSynth claim boundary');
  let reparsed: unknown;
  try {
    reparsed = JSON.parse(serializedPrivateReview);
  } catch {
    throw new Error('private NSynth family control review bytes are not JSON');
  }
  if (JSON.stringify(reparsed) !== JSON.stringify(value)) {
    throw new Error('private NSynth family control review bytes do not match the reviewed value');
  }
  const controls = value.controls.map((rawControl, index) =>
    validatePrivateControl(rawControl, manifest.controls[index], index)
  );
  const review: NsynthFamilyControlReviewV1 = {
    $schema: NSYNTH_FAMILY_CONTROL_REVIEW_SCHEMA,
    manifestPath: NSYNTH_FAMILY_CONTROL_MANIFEST_PATH,
    manifestVersion: NSYNTH_FAMILY_CONTROL_VERSION,
    manifestSha256,
    status: PUBLIC_REVIEW_STATUS,
    reviewProtocolVersion: NSYNTH_FAMILY_CONTROL_REVIEW_PROTOCOL,
    privateReviewSha256: sha256(Buffer.from(serializedPrivateReview)),
    curatedAt: value.reviewedAt,
    reviewAuthority: 'teacher-or-domain-reviewer',
    deidentified: true,
    rawTeacherFeedbackIncluded: false,
    attestation: INSTRUMENT_EVALUATION_REVIEW_ATTESTATION,
    claimBoundary: {
      ...PUBLIC_CLAIM_BOUNDARY,
      blockers: [...PUBLIC_CLAIM_BOUNDARY.blockers],
    },
    controls,
  };
  return validateNsynthFamilyControlReview(review, manifest, manifestSha256);
}

function validatePublicControl(
  value: unknown,
  control: NsynthFamilyControl,
  index: number
): NsynthFamilyControlReviewV1['controls'][number] {
  const context = `public NSynth review control ${index + 1}`;
  if (!record(value)) throw new Error(`${context} is invalid`);
  exactKeys(
    value,
    [
      'id',
      'noteStr',
      'sourceSha256',
      'datasetFamily',
      'datasetSource',
      'wholeSourceListened',
      'verdicts',
    ],
    context
  );
  if (
    value.id !== control.id ||
    value.noteStr !== control.noteStr ||
    value.sourceSha256 !== control.media.sha256 ||
    value.datasetFamily !== control.metadata.family ||
    value.datasetSource !== control.metadata.source ||
    value.wholeSourceListened !== true
  ) {
    throw new Error(`${context} drifted from the pinned source`);
  }
  return {
    id: control.id,
    noteStr: control.noteStr,
    sourceSha256: control.media.sha256,
    datasetFamily: control.metadata.family,
    datasetSource: control.metadata.source,
    wholeSourceListened: true,
    verdicts: validateVerdicts(value.verdicts, context),
  };
}

export function validateNsynthFamilyControlReview(
  value: unknown,
  manifest: NsynthFamilyControlManifest,
  manifestSha256: string
): NsynthFamilyControlReviewV1 {
  assertReviewIdentity(manifest, manifestSha256);
  if (!record(value)) throw new Error('public NSynth family control review is invalid');
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
      'controls',
    ],
    'public NSynth family control review'
  );
  if (
    value.$schema !== NSYNTH_FAMILY_CONTROL_REVIEW_SCHEMA ||
    value.manifestPath !== NSYNTH_FAMILY_CONTROL_MANIFEST_PATH ||
    value.manifestVersion !== NSYNTH_FAMILY_CONTROL_VERSION ||
    value.manifestSha256 !== manifestSha256 ||
    value.status !== PUBLIC_REVIEW_STATUS ||
    value.reviewProtocolVersion !== NSYNTH_FAMILY_CONTROL_REVIEW_PROTOCOL ||
    typeof value.privateReviewSha256 !== 'string' ||
    !SHA256.test(value.privateReviewSha256) ||
    !canonicalIso(value.curatedAt) ||
    value.reviewAuthority !== 'teacher-or-domain-reviewer' ||
    value.deidentified !== true ||
    value.rawTeacherFeedbackIncluded !== false ||
    value.attestation !== INSTRUMENT_EVALUATION_REVIEW_ATTESTATION ||
    !Array.isArray(value.controls) ||
    value.controls.length !== manifest.controls.length
  ) {
    throw new Error('public NSynth family control review is incomplete or drifted');
  }
  exactJson(value.claimBoundary, PUBLIC_CLAIM_BOUNDARY, 'public NSynth claim boundary');
  const controls = value.controls.map((rawControl, index) =>
    validatePublicControl(rawControl, manifest.controls[index], index)
  );
  return { ...value, controls } as unknown as NsynthFamilyControlReviewV1;
}
