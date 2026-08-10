import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export const TINYSOL_EXACT_CONTROL_MANIFEST_PATH =
  'tests/corpus/tinysol-exact-control-manifest.json' as const;
export const TINYSOL_EXACT_CONTROL_MANIFEST_SHA256 =
  'ddfc18f7f28d34813f22daecd2d42d78844f1f7b3f530f33c637106d31d80fbc' as const;
export const TINYSOL_EXACT_CONTROL_SCHEMA =
  'stem-splitter.tinysol-exact-control-corpus.v1' as const;
export const TINYSOL_EXACT_CONTROL_VERSION = 'tinysol-v6-exact-controls-v1' as const;
export const TINYSOL_EXACT_CONTROL_REVIEW_STATUS =
  'dataset-authored-exact-labels-awaiting-teacher-listening' as const;
export const TINYSOL_EXACT_CONTROL_OUTPUT_DIRECTORY =
  'tests/corpus/audio/tinysol-exact-controls-v1' as const;

export const TINYSOL_ARCHIVE_URL =
  'https://zenodo.org/api/records/3685367/files/TinySOL.tar.gz/content' as const;
export const TINYSOL_ARCHIVE_BYTES = 1_026_917_185 as const;
export const TINYSOL_ARCHIVE_MD5 = '36030a7fe389da86c3419e5ee48e3b7f' as const;
export const TINYSOL_ARCHIVE_SHA256 =
  'a537e5de4f64edf0a56032369f66fc76adcb67db875e466f54cad2999e00364c' as const;
export const TINYSOL_METADATA_URL =
  'https://zenodo.org/api/records/3685367/files/TinySOL_metadata.csv/content' as const;
export const TINYSOL_METADATA_BYTES = 317_576 as const;
export const TINYSOL_METADATA_MD5 = 'a86c9bb115f69e61f2f25872e397fc4a' as const;
export const TINYSOL_METADATA_SHA256 =
  '925727f1036cb3d574856470be6b04af5c9961102902a23cc8eafc7907d040da' as const;

const VOCABULARY_PATH = 'instrument-discovery/vocabulary.json' as const;
const VOCABULARY_VERSION = 'classroom-instruments-v1' as const;
const VOCABULARY_SHA256 =
  '72b7ab09cc188bf5cb8b47acf55145c45703cd4368e94c372cce8130f96ba140' as const;
const SHA256 = /^[a-f0-9]{64}$/;
const MD5 = /^[a-f0-9]{32}$/;
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_SOURCE_PATH = /^(?:Keyboards|Strings)\/[A-Za-z]+\/ordinario\/[A-Za-z0-9#-]+\.wav$/;

export const TINYSOL_METADATA_COLUMNS = [
  'Path',
  'Fold',
  'Family',
  'Instrument (abbr.)',
  'Instrument (in full)',
  'Technique (abbr.)',
  'Technique (in full)',
  'Pitch',
  'Pitch ID',
  'Dynamics',
  'Dynamics ID',
  'Instance ID',
  'String ID (if applicable)',
  'Needed digital retuning',
] as const;

export interface TinySolControlMetadata {
  fold: number;
  family: 'Keyboards' | 'Strings';
  instrumentAbbreviation: string;
  techniqueAbbreviation: 'ord';
  technique: 'ordinario';
  pitch: 'C4';
  pitchId: 60;
  dynamics: 'mf';
  dynamicsId: 2;
  instanceId: number;
  stringId: number | null;
  neededDigitalRetuning: false;
}

export interface TinySolControlMedia {
  bytes: number;
  sha256: string;
  dataBytes: number;
  frameCount: number;
  sampleRate: 44_100;
  channels: 1;
  bitsPerSample: 16;
  codec: 'pcm_s16le';
}

export interface TinySolExactControl {
  id: string;
  datasetInstrument: 'Accordion' | 'Cello' | 'Contrabass' | 'Viola' | 'Violin';
  vocabularyId: 'accordion' | 'cello' | 'double-bass' | 'viola' | 'violin';
  sourcePath: string;
  archiveMember: string;
  localFile: string;
  metadata: TinySolControlMetadata;
  media: TinySolControlMedia;
}

export interface TinySolExactControlManifest {
  $schema: typeof TINYSOL_EXACT_CONTROL_SCHEMA;
  version: typeof TINYSOL_EXACT_CONTROL_VERSION;
  reviewStatus: typeof TINYSOL_EXACT_CONTROL_REVIEW_STATUS;
  reviewVocabulary: {
    path: typeof VOCABULARY_PATH;
    version: typeof VOCABULARY_VERSION;
    sha256: typeof VOCABULARY_SHA256;
  };
  dataset: {
    name: 'TinySOL';
    version: '6.0';
    zenodoRecordId: '3685367';
    zenodoRecordDoi: '10.5281/zenodo.3685367';
    zenodoConceptDoi: '10.5281/zenodo.3632192';
    recordingType: 'isolated-single-instrument-ordinary-note';
    landingPage: 'https://zenodo.org/records/3685367';
    license: 'CC BY 4.0';
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/';
    sampleCount: 2913;
    sampleRate: 44_100;
    channels: 1;
    bitsPerSample: 16;
    citation: string;
    verifiedAt: '2026-08-10';
  };
  metadata: {
    url: typeof TINYSOL_METADATA_URL;
    bytes: typeof TINYSOL_METADATA_BYTES;
    md5: typeof TINYSOL_METADATA_MD5;
    sha256: typeof TINYSOL_METADATA_SHA256;
    contentType: 'text/plain';
    contentDisposition: 'inline';
    rowCount: 2913;
    columns: string[];
  };
  archive: {
    url: typeof TINYSOL_ARCHIVE_URL;
    bytes: typeof TINYSOL_ARCHIVE_BYTES;
    md5: typeof TINYSOL_ARCHIVE_MD5;
    sha256: typeof TINYSOL_ARCHIVE_SHA256;
    contentType: 'application/octet-stream';
    contentDisposition: 'attachment; filename=TinySOL.tar.gz';
    decodedBytes: 1_717_391_360;
    memberCount: 2952;
    directoryMemberCount: 33;
    wavMemberCount: 2913;
    auxiliaryFileCount: 6;
    surfaceSha256: 'a60ee083ad1ff13c887cf690e798104d10bcd403b9a9438510c55ea311ca82f0';
    requestTimeoutMs: 1_800_000;
    outputDirectory: typeof TINYSOL_EXACT_CONTROL_OUTPUT_DIRECTORY;
  };
  selectionPolicy: {
    datasetInstruments: TinySolExactControl['datasetInstrument'][];
    techniqueAbbreviation: 'ord';
    technique: 'ordinario';
    neededDigitalRetuning: false;
    dynamics: 'mf';
    dynamicsId: 2;
    pitch: 'C4';
    pitchId: 60;
    tieBreak: 'lowest-instance-id-then-path';
    controlsPerInstrument: 1;
  };
  coverage: {
    freeReedDatasetInstruments: ['Accordion'];
    soloStringDatasetInstruments: ['Cello', 'Contrabass', 'Viola', 'Violin'];
    unfilledExactPositiveGroups: ['harmonica', 'pitched-percussion', 'traditional-instruments'];
  };
  claimPolicy: {
    groundTruthLevel: 'dataset-authored-exact-instrument-label';
    exactInstrumentClaims: 'source-label-only';
    vocabularyPositiveClaims: 'candidate-awaiting-teacher-listening';
    candidateNegativeClaims: 'none';
    teacherMustReviewEveryControl: true;
    mixedTrackUse: 'forbidden';
    currentEvaluationPlanUse: 'forbidden';
    reportingPartition: 'isolated-exact-control';
    classifierSelectionUse: 'forbidden-until-reviewed-and-plan-integrated';
    promotionUse: 'forbidden-until-reviewed-and-plan-integrated';
  };
  controls: TinySolExactControl[];
}

interface ControlPin {
  id: TinySolExactControl['id'];
  datasetInstrument: TinySolExactControl['datasetInstrument'];
  vocabularyId: TinySolExactControl['vocabularyId'];
  sourcePath: string;
  fold: number;
  family: TinySolControlMetadata['family'];
  abbreviation: string;
  instanceId: number;
  stringId: number | null;
  bytes: number;
  sha256: string;
  dataBytes: number;
  frameCount: number;
}

const CONTROL_PINS: readonly ControlPin[] = [
  {
    id: 'tinysol-accordion-c4-mf', datasetInstrument: 'Accordion', vocabularyId: 'accordion',
    sourcePath: 'Keyboards/Accordion/ordinario/Acc-ord-C4-mf-N-N.wav', fold: 3,
    family: 'Keyboards', abbreviation: 'Acc', instanceId: 0, stringId: null,
    bytes: 507_996, sha256: '069fa76c1019a4301e8290b8061bc8946a5e9675a09cead75d34a99690d0b7c3',
    dataBytes: 507_952, frameCount: 253_976,
  },
  {
    id: 'tinysol-cello-c4-mf', datasetInstrument: 'Cello', vocabularyId: 'cello',
    sourcePath: 'Strings/Violoncello/ordinario/Vc-ord-C4-mf-1c-N.wav', fold: 1,
    family: 'Strings', abbreviation: 'Vc', instanceId: 0, stringId: 1,
    bytes: 791_194, sha256: '70f6876d1189afc3a70226d4951fe5ae80c18de2e2fd9e68c8a585cddfe9d6a2',
    dataBytes: 791_150, frameCount: 395_575,
  },
  {
    id: 'tinysol-contrabass-c4-mf', datasetInstrument: 'Contrabass', vocabularyId: 'double-bass',
    sourcePath: 'Strings/Contrabass/ordinario/Cb-ord-C4-mf-1c-N.wav', fold: 1,
    family: 'Strings', abbreviation: 'Cb', instanceId: 0, stringId: 1,
    bytes: 398_530, sha256: '8ff5a100eb8e1af593f02f4f9be36051d2ae3b5f6b2b3f2c1eb64e0b96ec803e',
    dataBytes: 398_486, frameCount: 199_243,
  },
  {
    id: 'tinysol-viola-c4-mf', datasetInstrument: 'Viola', vocabularyId: 'viola',
    sourcePath: 'Strings/Viola/ordinario/Va-ord-C4-mf-3c-N.wav', fold: 2,
    family: 'Strings', abbreviation: 'Va', instanceId: 2, stringId: 3,
    bytes: 666_408, sha256: '578f0ea888cd461c8e154784c3cb424557541dc412b581949d5b44d04c5fc52d',
    dataBytes: 666_364, frameCount: 333_182,
  },
  {
    id: 'tinysol-violin-c4-mf', datasetInstrument: 'Violin', vocabularyId: 'violin',
    sourcePath: 'Strings/Violin/ordinario/Vn-ord-C4-mf-4c-N.wav', fold: 3,
    family: 'Strings', abbreviation: 'Vn', instanceId: 3, stringId: 4,
    bytes: 646_856, sha256: '8df04ee583bf9a454e1dde9840ab9de374a24ce94b75cfe758191d72e8d83a7f',
    dataBytes: 646_812, frameCount: 323_406,
  },
] as const;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, keys: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${context} does not match the pinned schema`);
  }
}

function exactJson(value: unknown, expected: unknown, context: string): void {
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(`${context} drifted from the pinned value`);
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactUrl(value: unknown, expected: string, context: string): void {
  if (value !== expected) throw new Error(`${context} drifted`);
  const parsed = new URL(expected);
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
    parsed.search || parsed.hash
  ) {
    throw new Error(`${context} is unsafe`);
  }
}

function validateVocabulary(value: unknown, repositoryRoot: string): void {
  if (!record(value)) throw new Error('TinySOL review vocabulary is invalid');
  exactKeys(value, ['path', 'version', 'sha256'], 'TinySOL review vocabulary');
  exactJson(
    value,
    { path: VOCABULARY_PATH, version: VOCABULARY_VERSION, sha256: VOCABULARY_SHA256 },
    'TinySOL review vocabulary'
  );
  const bytes = readFileSync(resolve(repositoryRoot, VOCABULARY_PATH));
  if (sha256(bytes) !== VOCABULARY_SHA256) throw new Error('TinySOL review vocabulary bytes drifted');
  const vocabulary = JSON.parse(bytes.toString('utf8')) as { instruments?: Array<{ id?: string }> };
  const ids = new Set(vocabulary.instruments?.map(({ id }) => id));
  for (const pin of CONTROL_PINS) {
    if (!ids.has(pin.vocabularyId)) throw new Error(`${pin.id}: vocabulary label is unavailable`);
  }
}

function validateDataset(value: unknown): void {
  if (!record(value)) throw new Error('TinySOL dataset metadata is invalid');
  exactKeys(value, [
    'name', 'version', 'zenodoRecordId', 'zenodoRecordDoi', 'zenodoConceptDoi',
    'recordingType', 'landingPage', 'license', 'licenseUrl', 'sampleCount', 'sampleRate',
    'channels', 'bitsPerSample', 'citation', 'verifiedAt',
  ], 'TinySOL dataset metadata');
  if (
    value.name !== 'TinySOL' || value.version !== '6.0' || value.zenodoRecordId !== '3685367' ||
    value.zenodoRecordDoi !== '10.5281/zenodo.3685367' ||
    value.zenodoConceptDoi !== '10.5281/zenodo.3632192' ||
    value.recordingType !== 'isolated-single-instrument-ordinary-note' ||
    value.license !== 'CC BY 4.0' || value.sampleCount !== 2913 || value.sampleRate !== 44_100 ||
    value.channels !== 1 || value.bitsPerSample !== 16 || value.verifiedAt !== '2026-08-10' ||
    typeof value.citation !== 'string' || value.citation.length < 180 ||
    !value.citation.includes('10.5281/zenodo.3685367')
  ) {
    throw new Error('TinySOL dataset identity drifted');
  }
  exactUrl(value.landingPage, 'https://zenodo.org/records/3685367', 'TinySOL landing page');
  exactUrl(value.licenseUrl, 'https://creativecommons.org/licenses/by/4.0/', 'TinySOL license URL');
}

function validateMetadataSource(value: unknown): void {
  if (!record(value)) throw new Error('TinySOL metadata object is invalid');
  exactKeys(value, [
    'url', 'bytes', 'md5', 'sha256', 'contentType', 'contentDisposition', 'rowCount', 'columns',
  ], 'TinySOL metadata object');
  exactUrl(value.url, TINYSOL_METADATA_URL, 'TinySOL metadata URL');
  const expected = {
    bytes: TINYSOL_METADATA_BYTES, md5: TINYSOL_METADATA_MD5, sha256: TINYSOL_METADATA_SHA256,
    contentType: 'text/plain', contentDisposition: 'inline', rowCount: 2913,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) throw new Error(`TinySOL metadata ${key} drifted`);
  }
  if (!MD5.test(value.md5 as string) || !SHA256.test(value.sha256 as string)) {
    throw new Error('TinySOL metadata digest is invalid');
  }
  exactJson(value.columns, TINYSOL_METADATA_COLUMNS, 'TinySOL metadata columns');
}

function validateArchive(value: unknown): void {
  if (!record(value)) throw new Error('TinySOL archive object is invalid');
  exactKeys(value, [
    'url', 'bytes', 'md5', 'sha256', 'contentType', 'contentDisposition', 'decodedBytes',
    'memberCount', 'directoryMemberCount', 'wavMemberCount', 'auxiliaryFileCount',
    'surfaceSha256', 'requestTimeoutMs', 'outputDirectory',
  ], 'TinySOL archive object');
  exactUrl(value.url, TINYSOL_ARCHIVE_URL, 'TinySOL archive URL');
  const expected = {
    bytes: TINYSOL_ARCHIVE_BYTES, md5: TINYSOL_ARCHIVE_MD5, sha256: TINYSOL_ARCHIVE_SHA256,
    contentType: 'application/octet-stream',
    contentDisposition: 'attachment; filename=TinySOL.tar.gz', decodedBytes: 1_717_391_360,
    memberCount: 2952, directoryMemberCount: 33, wavMemberCount: 2913,
    auxiliaryFileCount: 6,
    surfaceSha256: 'a60ee083ad1ff13c887cf690e798104d10bcd403b9a9438510c55ea311ca82f0',
    requestTimeoutMs: 1_800_000, outputDirectory: TINYSOL_EXACT_CONTROL_OUTPUT_DIRECTORY,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) throw new Error(`TinySOL archive ${key} drifted`);
  }
  if (!MD5.test(value.md5 as string) || !SHA256.test(value.sha256 as string)) {
    throw new Error('TinySOL archive digest is invalid');
  }
}

function validatePolicies(value: JsonRecord): void {
  exactJson(value.selectionPolicy, {
    datasetInstruments: ['Accordion', 'Cello', 'Contrabass', 'Viola', 'Violin'],
    techniqueAbbreviation: 'ord', technique: 'ordinario', neededDigitalRetuning: false,
    dynamics: 'mf', dynamicsId: 2, pitch: 'C4', pitchId: 60,
    tieBreak: 'lowest-instance-id-then-path', controlsPerInstrument: 1,
  }, 'TinySOL selection policy');
  exactJson(value.coverage, {
    freeReedDatasetInstruments: ['Accordion'],
    soloStringDatasetInstruments: ['Cello', 'Contrabass', 'Viola', 'Violin'],
    unfilledExactPositiveGroups: ['harmonica', 'pitched-percussion', 'traditional-instruments'],
  }, 'TinySOL exact-positive coverage');
  exactJson(value.claimPolicy, {
    groundTruthLevel: 'dataset-authored-exact-instrument-label',
    exactInstrumentClaims: 'source-label-only',
    vocabularyPositiveClaims: 'candidate-awaiting-teacher-listening',
    candidateNegativeClaims: 'none', teacherMustReviewEveryControl: true,
    mixedTrackUse: 'forbidden', currentEvaluationPlanUse: 'forbidden',
    reportingPartition: 'isolated-exact-control',
    classifierSelectionUse: 'forbidden-until-reviewed-and-plan-integrated',
    promotionUse: 'forbidden-until-reviewed-and-plan-integrated',
  }, 'TinySOL claim policy');
}

function validateControl(value: unknown, pin: ControlPin, index: number): TinySolExactControl {
  const context = `TinySOL control ${index + 1}`;
  if (!record(value)) throw new Error(`${context} is invalid`);
  exactKeys(value, [
    'id', 'datasetInstrument', 'vocabularyId', 'sourcePath', 'archiveMember', 'localFile',
    'metadata', 'media',
  ], context);
  if (
    value.id !== pin.id || !SAFE_ID.test(pin.id) || value.datasetInstrument !== pin.datasetInstrument ||
    value.vocabularyId !== pin.vocabularyId || value.sourcePath !== pin.sourcePath ||
    !SAFE_SOURCE_PATH.test(pin.sourcePath) || value.archiveMember !== `./${pin.sourcePath}` ||
    value.localFile !== `${pin.id}.wav`
  ) {
    throw new Error(`${context} identity drifted`);
  }
  exactJson(value.metadata, {
    fold: pin.fold, family: pin.family, instrumentAbbreviation: pin.abbreviation,
    techniqueAbbreviation: 'ord', technique: 'ordinario', pitch: 'C4', pitchId: 60,
    dynamics: 'mf', dynamicsId: 2, instanceId: pin.instanceId, stringId: pin.stringId,
    neededDigitalRetuning: false,
  }, `${context} metadata`);
  exactJson(value.media, {
    bytes: pin.bytes, sha256: pin.sha256, dataBytes: pin.dataBytes, frameCount: pin.frameCount,
    sampleRate: 44_100, channels: 1, bitsPerSample: 16, codec: 'pcm_s16le',
  }, `${context} media`);
  if (!SHA256.test(pin.sha256) || pin.dataBytes !== pin.frameCount * 2 || pin.bytes !== pin.dataBytes + 44) {
    throw new Error(`${context} WAV pin is inconsistent`);
  }
  return value as unknown as TinySolExactControl;
}

export function validateTinySolExactControlManifestForRepository(
  value: unknown,
  repositoryRoot = process.cwd()
): TinySolExactControlManifest {
  if (!record(value)) throw new Error('TinySOL exact control manifest is invalid');
  exactKeys(value, [
    '$schema', 'version', 'reviewStatus', 'reviewVocabulary', 'dataset', 'metadata', 'archive',
    'selectionPolicy', 'coverage', 'claimPolicy', 'controls',
  ], 'TinySOL exact control manifest');
  if (
    value.$schema !== TINYSOL_EXACT_CONTROL_SCHEMA ||
    value.version !== TINYSOL_EXACT_CONTROL_VERSION ||
    value.reviewStatus !== TINYSOL_EXACT_CONTROL_REVIEW_STATUS
  ) {
    throw new Error('TinySOL exact control manifest identity drifted');
  }
  validateVocabulary(value.reviewVocabulary, repositoryRoot);
  validateDataset(value.dataset);
  validateMetadataSource(value.metadata);
  validateArchive(value.archive);
  validatePolicies(value);
  if (!Array.isArray(value.controls) || value.controls.length !== CONTROL_PINS.length) {
    throw new Error('TinySOL exact controls must preserve the selected tranche');
  }
  const controls = value.controls.map((control, index) => validateControl(control, CONTROL_PINS[index], index));
  for (const field of ['id', 'datasetInstrument', 'vocabularyId', 'sourcePath', 'archiveMember', 'localFile'] as const) {
    if (new Set(controls.map((control) => control[field])).size !== controls.length) {
      throw new Error(`TinySOL control ${field} values must be unique`);
    }
  }
  return { ...value, controls } as unknown as TinySolExactControlManifest;
}

export function loadTinySolExactControlManifest(
  repositoryRoot = process.cwd(),
  manifestPath = TINYSOL_EXACT_CONTROL_MANIFEST_PATH
): TinySolExactControlManifest {
  const root = realpathSync(resolve(repositoryRoot));
  const path = resolve(root, manifestPath);
  const metadata = lstatSync(path);
  if (
    !path.startsWith(`${root}${sep}`) || metadata.isSymbolicLink() || !metadata.isFile() ||
    metadata.size < 2 || metadata.size > 256 * 1024 || realpathSync(path) !== path
  ) {
    throw new Error('TinySOL exact control manifest is not a bounded repository file');
  }
  const bytes = readFileSync(path);
  if (sha256(bytes) !== TINYSOL_EXACT_CONTROL_MANIFEST_SHA256) {
    throw new Error('TinySOL exact control manifest bytes drifted');
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('TinySOL exact control manifest is not valid JSON');
  }
  return validateTinySolExactControlManifestForRepository(value, root);
}

export function tinySolExactControlPath(
  repositoryRoot: string,
  manifest: TinySolExactControlManifest,
  control: TinySolExactControl
): string {
  const root = resolve(repositoryRoot);
  const path = resolve(root, manifest.archive.outputDirectory, control.localFile);
  if (!path.startsWith(`${root}${sep}`)) throw new Error('TinySOL control path escaped the repository');
  return path;
}
