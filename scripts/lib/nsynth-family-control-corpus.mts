import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export const NSYNTH_FAMILY_CONTROL_MANIFEST_PATH =
  'tests/corpus/nsynth-family-control-manifest.json' as const;
export const NSYNTH_FAMILY_CONTROL_SCHEMA =
  'stem-splitter.nsynth-family-control-corpus.v1' as const;
export const NSYNTH_FAMILY_CONTROL_VERSION =
  'nsynth-test-family-source-controls-v1' as const;
export const NSYNTH_FAMILY_CONTROL_REVIEW_STATUS =
  'dataset-family-labels-awaiting-teacher-listening' as const;
export const NSYNTH_FAMILY_CONTROL_OUTPUT_DIRECTORY =
  'tests/corpus/audio/nsynth-family-controls-v1' as const;

export const NSYNTH_ARCHIVE_URL =
  'https://storage.googleapis.com/download.magenta.tensorflow.org/datasets/nsynth/nsynth-test.jsonwav.tar.gz' as const;
export const NSYNTH_ARCHIVE_BYTES = 349_501_546;
export const NSYNTH_ARCHIVE_SHA256 =
  '0f9ba5d62beba9ec4612f918d19f5e87a681822f1c566124f05fe8b27a51934c' as const;

const VOCABULARY_PATH = 'instrument-discovery/vocabulary.json' as const;
const VOCABULARY_VERSION = 'classroom-instruments-v1' as const;
const VOCABULARY_SHA256 =
  '72b7ab09cc188bf5cb8b47acf55145c45703cd4368e94c372cce8130f96ba140' as const;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NOTE_STR = /^[a-z]+_(?:acoustic|electronic|synthetic)_\d{3}-\d{3}-\d{3}$/;
const QUALITY_IDS = [
  'bright',
  'dark',
  'distortion',
  'fast_decay',
  'long_release',
  'multiphonic',
  'nonlinear_env',
  'percussive',
  'reverb',
  'tempo-synced',
] as const;
const AVAILABLE_FAMILIES = [
  'bass',
  'brass',
  'flute',
  'guitar',
  'keyboard',
  'mallet',
  'organ',
  'reed',
  'string',
  'vocal',
] as const;
const SOURCE_NAMES = ['acoustic', 'electronic', 'synthetic'] as const;

type NsynthFamily = (typeof AVAILABLE_FAMILIES)[number];
type NsynthSource = (typeof SOURCE_NAMES)[number];
type JsonRecord = Record<string, unknown>;

interface ControlPin {
  id: string;
  noteStr: string;
  note: number;
  instrument: number;
  instrumentStr: string;
  familyIndex: number;
  family: NsynthFamily;
  sourceIndex: number;
  source: NsynthSource;
  pitch: number;
  velocity: number;
  qualityVector: number[];
  qualityIds: string[];
  sha256: string;
}

const EXPECTED_CONTROLS: readonly ControlPin[] = [
  {
    id: 'nsynth-bass-synthetic',
    noteStr: 'bass_synthetic_098-061-075',
    note: 72_193,
    instrument: 803,
    instrumentStr: 'bass_synthetic_098',
    familyIndex: 0,
    family: 'bass',
    sourceIndex: 2,
    source: 'synthetic',
    pitch: 61,
    velocity: 75,
    qualityVector: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    qualityIds: [],
    sha256: 'b9035e6e94968ce852c47c0ddcf2727bf8617ba7ccfbca560f2b80f550532338',
  },
  {
    id: 'nsynth-brass-acoustic',
    noteStr: 'brass_acoustic_016-057-100',
    note: 52_362,
    instrument: 128,
    instrumentStr: 'brass_acoustic_016',
    familyIndex: 1,
    family: 'brass',
    sourceIndex: 0,
    source: 'acoustic',
    pitch: 57,
    velocity: 100,
    qualityVector: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    qualityIds: [],
    sha256: 'd1840b6bef2efae2ee0d96e0eee6d560199dce79cc6efc050f9c5f0790620ed2',
  },
  {
    id: 'nsynth-flute-synthetic',
    noteStr: 'flute_synthetic_000-061-075',
    note: 18_775,
    instrument: 82,
    instrumentStr: 'flute_synthetic_000',
    familyIndex: 2,
    family: 'flute',
    sourceIndex: 2,
    source: 'synthetic',
    pitch: 61,
    velocity: 75,
    qualityVector: [0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    qualityIds: ['distortion'],
    sha256: 'b0832a2bee25c3d3537830764ad0e7efc95a40546eba26ace9969d878a9ae2e7',
  },
  {
    id: 'nsynth-guitar-electronic',
    noteStr: 'guitar_electronic_022-063-075',
    note: 240_175,
    instrument: 378,
    instrumentStr: 'guitar_electronic_022',
    familyIndex: 3,
    family: 'guitar',
    sourceIndex: 1,
    source: 'electronic',
    pitch: 63,
    velocity: 75,
    qualityVector: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    qualityIds: [],
    sha256: '09ec5452eccb54685a748f0ebc34012c7d7845dd5b8e1e9dc9e286500bad4f5b',
  },
  {
    id: 'nsynth-keyboard-electronic',
    noteStr: 'keyboard_electronic_003-060-075',
    note: 145_325,
    instrument: 65,
    instrumentStr: 'keyboard_electronic_003',
    familyIndex: 4,
    family: 'keyboard',
    sourceIndex: 1,
    source: 'electronic',
    pitch: 60,
    velocity: 75,
    qualityVector: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    qualityIds: [],
    sha256: '271d33eef42c4a488f56fed883985ea98873bda34968b8ef7d3a378edb55c2c7',
  },
  {
    id: 'nsynth-mallet-acoustic',
    noteStr: 'mallet_acoustic_056-090-075',
    note: 27_648,
    instrument: 590,
    instrumentStr: 'mallet_acoustic_056',
    familyIndex: 5,
    family: 'mallet',
    sourceIndex: 0,
    source: 'acoustic',
    pitch: 90,
    velocity: 75,
    qualityVector: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    qualityIds: [],
    sha256: '6cbf38487a75a2cecd2e5675efdec90f2b2d4957f3359e149170f193512daa02',
  },
  {
    id: 'nsynth-organ-electronic',
    noteStr: 'organ_electronic_104-060-075',
    note: 79_210,
    instrument: 921,
    instrumentStr: 'organ_electronic_104',
    familyIndex: 6,
    family: 'organ',
    sourceIndex: 1,
    source: 'electronic',
    pitch: 60,
    velocity: 75,
    qualityVector: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    qualityIds: [],
    sha256: '39484448903cbcdfa10d0d9dcf12be662ea8c5c7e38e8ed9af02086d52a1adf1',
  },
  {
    id: 'nsynth-reed-acoustic',
    noteStr: 'reed_acoustic_011-060-075',
    note: 24_598,
    instrument: 104,
    instrumentStr: 'reed_acoustic_011',
    familyIndex: 7,
    family: 'reed',
    sourceIndex: 0,
    source: 'acoustic',
    pitch: 60,
    velocity: 75,
    qualityVector: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    qualityIds: [],
    sha256: '70434f0007db4f2e9a953789c3dbe66ea375c10dd930ba32b90068112d50d89b',
  },
  {
    id: 'nsynth-string-acoustic',
    noteStr: 'string_acoustic_056-060-075',
    note: 38_914,
    instrument: 436,
    instrumentStr: 'string_acoustic_056',
    familyIndex: 8,
    family: 'string',
    sourceIndex: 0,
    source: 'acoustic',
    pitch: 60,
    velocity: 75,
    qualityVector: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0],
    qualityIds: ['reverb'],
    sha256: 'dd87dd80ecd11f28117c339d2e9e92e799266dafbd7cf6832fba5e2f5b54692d',
  },
  {
    id: 'nsynth-vocal-synthetic',
    noteStr: 'vocal_synthetic_003-090-075',
    note: 10_959,
    instrument: 37,
    instrumentStr: 'vocal_synthetic_003',
    familyIndex: 10,
    family: 'vocal',
    sourceIndex: 2,
    source: 'synthetic',
    pitch: 90,
    velocity: 75,
    qualityVector: [0, 0, 0, 0, 1, 0, 1, 0, 0, 0],
    qualityIds: ['long_release', 'nonlinear_env'],
    sha256: '3aa8f6b431a0714eb104528243801288ce344174d9c6177b160327301132752b',
  },
];

export interface NsynthFamilyControlMetadata {
  note: number;
  instrument: number;
  instrumentStr: string;
  familyIndex: number;
  family: NsynthFamily;
  sourceIndex: number;
  source: NsynthSource;
  pitch: number;
  velocity: number;
  sampleRate: 16_000;
  qualityVector: number[];
  qualityIds: string[];
}

export interface NsynthFamilyControl {
  id: string;
  noteStr: string;
  archiveMember: string;
  localFile: string;
  metadata: NsynthFamilyControlMetadata;
  media: {
    bytes: 128_044;
    sha256: string;
    durationSeconds: 4;
    sampleRate: 16_000;
    channels: 1;
    bitsPerSample: 16;
    codec: 'pcm_s16le';
  };
}

export interface NsynthFamilyControlManifest {
  $schema: typeof NSYNTH_FAMILY_CONTROL_SCHEMA;
  version: typeof NSYNTH_FAMILY_CONTROL_VERSION;
  reviewStatus: typeof NSYNTH_FAMILY_CONTROL_REVIEW_STATUS;
  reviewVocabulary: {
    path: typeof VOCABULARY_PATH;
    version: typeof VOCABULARY_VERSION;
    sha256: typeof VOCABULARY_SHA256;
  };
  dataset: {
    name: 'NSynth';
    split: 'test';
    recordingType: 'isolated-four-second-monophonic-note';
    landingPage: 'https://magenta.tensorflow.org/datasets/nsynth';
    paperUrl: 'https://arxiv.org/abs/1704.01279';
    license: 'CC BY 4.0';
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/';
    citation: string;
    verifiedAt: string;
  };
  archive: {
    url: typeof NSYNTH_ARCHIVE_URL;
    bytes: typeof NSYNTH_ARCHIVE_BYTES;
    sha256: typeof NSYNTH_ARCHIVE_SHA256;
    contentType: 'application/gzip';
    storageGeneration: '1491603911045000';
    etag: '5e6f8719bf7e16ad0a00d518b78af77d';
    lastModified: 'Fri, 07 Apr 2017 22:25:10 GMT';
    memberRoot: 'nsynth-test';
    memberCount: 4099;
    audioMemberCount: 4096;
    examplesMember: 'nsynth-test/examples.json';
    examplesBytes: 2_855_979;
    examplesSha256: '74df2dd960c156cd5e8757d8afb1fe30e6a233aa99043a29037e7b54cde6908f';
    requestTimeoutMs: 180_000;
    outputDirectory: typeof NSYNTH_FAMILY_CONTROL_OUTPUT_DIRECTORY;
  };
  coverage: {
    availableTestFamilies: NsynthFamily[];
    unavailableTestFamilies: ['synth_lead'];
    testFamilyCounts: Record<NsynthFamily, number>;
    testSourceCounts: Record<NsynthSource, number>;
    selectedSourceCounts: Record<NsynthSource, number>;
  };
  claimPolicy: {
    groundTruthLevel: 'dataset-family-and-source-only';
    exactInstrumentClaims: false;
    vocabularyPositiveClaims: 'none-before-teacher-listening';
    candidateNegativeClaims: 'none';
    teacherMustReviewEveryVocabularyLabel: true;
    mixedTrackUse: 'forbidden';
    reportingPartition: 'isolated-family-source-control';
    promotionUse: 'forbidden-until-reviewed-and-integrated';
  };
  controls: NsynthFamilyControl[];
}

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

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactJson(value: unknown, expected: unknown, context: string): void {
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(`${context} drifted from the pinned value`);
  }
}

function exactUrl(value: unknown, expected: string, context: string): void {
  if (value !== expected) throw new Error(`${context} drifted`);
  const parsed = new URL(expected);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${context} is unsafe`);
  }
}

function validateVocabulary(value: unknown, repositoryRoot: string): void {
  if (!record(value)) throw new Error('NSynth review vocabulary is invalid');
  exactKeys(value, ['path', 'version', 'sha256'], 'NSynth review vocabulary');
  if (
    value.path !== VOCABULARY_PATH ||
    value.version !== VOCABULARY_VERSION ||
    value.sha256 !== VOCABULARY_SHA256
  ) {
    throw new Error('NSynth review vocabulary identity drifted');
  }
  const vocabularyBytes = readFileSync(resolve(repositoryRoot, VOCABULARY_PATH));
  if (sha256Bytes(vocabularyBytes) !== VOCABULARY_SHA256) {
    throw new Error('NSynth review vocabulary bytes drifted');
  }
}

function validateDataset(value: unknown): void {
  if (!record(value)) throw new Error('NSynth dataset metadata is invalid');
  exactKeys(
    value,
    [
      'name',
      'split',
      'recordingType',
      'landingPage',
      'paperUrl',
      'license',
      'licenseUrl',
      'citation',
      'verifiedAt',
    ],
    'NSynth dataset metadata'
  );
  if (
    value.name !== 'NSynth' ||
    value.split !== 'test' ||
    value.recordingType !== 'isolated-four-second-monophonic-note' ||
    value.license !== 'CC BY 4.0' ||
    typeof value.citation !== 'string' ||
    value.citation.length < 180 ||
    value.verifiedAt !== '2026-08-10'
  ) {
    throw new Error('NSynth dataset identity drifted');
  }
  exactUrl(value.landingPage, 'https://magenta.tensorflow.org/datasets/nsynth', 'NSynth landing page');
  exactUrl(value.paperUrl, 'https://arxiv.org/abs/1704.01279', 'NSynth paper URL');
  exactUrl(
    value.licenseUrl,
    'https://creativecommons.org/licenses/by/4.0/',
    'NSynth license URL'
  );
}

function validateArchive(value: unknown): void {
  if (!record(value)) throw new Error('NSynth archive metadata is invalid');
  exactKeys(
    value,
    [
      'url',
      'bytes',
      'sha256',
      'contentType',
      'storageGeneration',
      'etag',
      'lastModified',
      'memberRoot',
      'memberCount',
      'audioMemberCount',
      'examplesMember',
      'examplesBytes',
      'examplesSha256',
      'requestTimeoutMs',
      'outputDirectory',
    ],
    'NSynth archive metadata'
  );
  exactUrl(value.url, NSYNTH_ARCHIVE_URL, 'NSynth archive URL');
  const expected = {
    bytes: NSYNTH_ARCHIVE_BYTES,
    sha256: NSYNTH_ARCHIVE_SHA256,
    contentType: 'application/gzip',
    storageGeneration: '1491603911045000',
    etag: '5e6f8719bf7e16ad0a00d518b78af77d',
    lastModified: 'Fri, 07 Apr 2017 22:25:10 GMT',
    memberRoot: 'nsynth-test',
    memberCount: 4099,
    audioMemberCount: 4096,
    examplesMember: 'nsynth-test/examples.json',
    examplesBytes: 2_855_979,
    examplesSha256: '74df2dd960c156cd5e8757d8afb1fe30e6a233aa99043a29037e7b54cde6908f',
    requestTimeoutMs: 180_000,
    outputDirectory: NSYNTH_FAMILY_CONTROL_OUTPUT_DIRECTORY,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) throw new Error(`NSynth archive ${key} drifted`);
  }
}

function validateCoverage(value: unknown): void {
  if (!record(value)) throw new Error('NSynth control coverage is invalid');
  exactKeys(
    value,
    [
      'availableTestFamilies',
      'unavailableTestFamilies',
      'testFamilyCounts',
      'testSourceCounts',
      'selectedSourceCounts',
    ],
    'NSynth control coverage'
  );
  exactJson(value.availableTestFamilies, AVAILABLE_FAMILIES, 'NSynth available family order');
  exactJson(value.unavailableTestFamilies, ['synth_lead'], 'NSynth unavailable family list');
  exactJson(
    value.testFamilyCounts,
    {
      bass: 843,
      brass: 269,
      flute: 180,
      guitar: 652,
      keyboard: 766,
      mallet: 202,
      organ: 502,
      reed: 235,
      string: 306,
      vocal: 141,
    },
    'NSynth test family counts'
  );
  exactJson(
    value.testSourceCounts,
    { acoustic: 1689, electronic: 1372, synthetic: 1035 },
    'NSynth test source counts'
  );
  exactJson(
    value.selectedSourceCounts,
    { acoustic: 4, electronic: 3, synthetic: 3 },
    'NSynth selected source counts'
  );
}

function validateClaimPolicy(value: unknown): void {
  if (!record(value)) throw new Error('NSynth claim policy is invalid');
  exactKeys(
    value,
    [
      'groundTruthLevel',
      'exactInstrumentClaims',
      'vocabularyPositiveClaims',
      'candidateNegativeClaims',
      'teacherMustReviewEveryVocabularyLabel',
      'mixedTrackUse',
      'reportingPartition',
      'promotionUse',
    ],
    'NSynth claim policy'
  );
  exactJson(
    value,
    {
      groundTruthLevel: 'dataset-family-and-source-only',
      exactInstrumentClaims: false,
      vocabularyPositiveClaims: 'none-before-teacher-listening',
      candidateNegativeClaims: 'none',
      teacherMustReviewEveryVocabularyLabel: true,
      mixedTrackUse: 'forbidden',
      reportingPartition: 'isolated-family-source-control',
      promotionUse: 'forbidden-until-reviewed-and-integrated',
    },
    'NSynth claim policy'
  );
}

function validateControl(value: unknown, pin: ControlPin, index: number): NsynthFamilyControl {
  const context = `NSynth control ${index + 1}`;
  if (!record(value)) throw new Error(`${context} is invalid`);
  exactKeys(value, ['id', 'noteStr', 'archiveMember', 'localFile', 'metadata', 'media'], context);
  if (
    value.id !== pin.id ||
    !SAFE_ID.test(pin.id) ||
    value.noteStr !== pin.noteStr ||
    !NOTE_STR.test(pin.noteStr) ||
    value.archiveMember !== `nsynth-test/audio/${pin.noteStr}.wav` ||
    value.localFile !== `${pin.id}.wav`
  ) {
    throw new Error(`${context} identity drifted`);
  }
  if (!record(value.metadata)) throw new Error(`${context} metadata is invalid`);
  exactKeys(
    value.metadata,
    [
      'note',
      'instrument',
      'instrumentStr',
      'familyIndex',
      'family',
      'sourceIndex',
      'source',
      'pitch',
      'velocity',
      'sampleRate',
      'qualityVector',
      'qualityIds',
    ],
    `${context} metadata`
  );
  exactJson(
    value.metadata,
    {
      note: pin.note,
      instrument: pin.instrument,
      instrumentStr: pin.instrumentStr,
      familyIndex: pin.familyIndex,
      family: pin.family,
      sourceIndex: pin.sourceIndex,
      source: pin.source,
      pitch: pin.pitch,
      velocity: pin.velocity,
      sampleRate: 16_000,
      qualityVector: pin.qualityVector,
      qualityIds: pin.qualityIds,
    },
    `${context} metadata`
  );
  if (
    !pin.qualityVector.every((item) => item === 0 || item === 1) ||
    pin.qualityVector.length !== QUALITY_IDS.length ||
    JSON.stringify(
      pin.qualityVector.flatMap((present, qualityIndex) =>
        present ? [QUALITY_IDS[qualityIndex]] : []
      )
    ) !== JSON.stringify(pin.qualityIds)
  ) {
    throw new Error(`${context} quality labels are inconsistent`);
  }
  if (!record(value.media)) throw new Error(`${context} media is invalid`);
  exactKeys(
    value.media,
    ['bytes', 'sha256', 'durationSeconds', 'sampleRate', 'channels', 'bitsPerSample', 'codec'],
    `${context} media`
  );
  exactJson(
    value.media,
    {
      bytes: 128_044,
      sha256: pin.sha256,
      durationSeconds: 4,
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
      codec: 'pcm_s16le',
    },
    `${context} media`
  );
  if (!SHA256.test(pin.sha256)) throw new Error(`${context} SHA-256 is invalid`);
  return value as unknown as NsynthFamilyControl;
}

export function validateNsynthFamilyControlManifestForRepository(
  value: unknown,
  repositoryRoot = process.cwd()
): NsynthFamilyControlManifest {
  if (!record(value)) throw new Error('NSynth family control manifest is invalid');
  exactKeys(
    value,
    [
      '$schema',
      'version',
      'reviewStatus',
      'reviewVocabulary',
      'dataset',
      'archive',
      'coverage',
      'claimPolicy',
      'controls',
    ],
    'NSynth family control manifest'
  );
  if (
    value.$schema !== NSYNTH_FAMILY_CONTROL_SCHEMA ||
    value.version !== NSYNTH_FAMILY_CONTROL_VERSION ||
    value.reviewStatus !== NSYNTH_FAMILY_CONTROL_REVIEW_STATUS
  ) {
    throw new Error('NSynth family control manifest identity drifted');
  }
  validateVocabulary(value.reviewVocabulary, repositoryRoot);
  validateDataset(value.dataset);
  validateArchive(value.archive);
  validateCoverage(value.coverage);
  validateClaimPolicy(value.claimPolicy);
  if (!Array.isArray(value.controls) || value.controls.length !== EXPECTED_CONTROLS.length) {
    throw new Error('NSynth family controls must preserve the exact selected tranche');
  }
  const controls = value.controls.map((control, index) =>
    validateControl(control, EXPECTED_CONTROLS[index], index)
  );
  if (
    new Set(controls.map(({ id }) => id)).size !== controls.length ||
    new Set(controls.map(({ archiveMember }) => archiveMember)).size !== controls.length ||
    new Set(controls.map(({ media }) => media.sha256)).size !== controls.length
  ) {
    throw new Error('NSynth family control identities must be unique');
  }
  const sourceCounts = Object.fromEntries(SOURCE_NAMES.map((source) => [source, 0])) as Record<
    NsynthSource,
    number
  >;
  for (const control of controls) sourceCounts[control.metadata.source] += 1;
  const coverage = value.coverage as NsynthFamilyControlManifest['coverage'];
  exactJson(sourceCounts, coverage.selectedSourceCounts, 'NSynth selected source totals');
  exactJson(
    controls.map(({ metadata }) => metadata.family),
    AVAILABLE_FAMILIES,
    'NSynth selected family order'
  );
  return { ...value, controls } as unknown as NsynthFamilyControlManifest;
}

export function loadNsynthFamilyControlManifest(
  repositoryRoot = process.cwd(),
  manifestPath = NSYNTH_FAMILY_CONTROL_MANIFEST_PATH
): NsynthFamilyControlManifest {
  const root = realpathSync(resolve(repositoryRoot));
  const path = resolve(root, manifestPath);
  const metadata = lstatSync(path);
  if (
    !path.startsWith(`${root}${sep}`) ||
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size < 2 ||
    metadata.size > 256 * 1024 ||
    realpathSync(path) !== path
  ) {
    throw new Error('NSynth family control manifest is not a bounded repository file');
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('NSynth family control manifest is not valid JSON');
  }
  return validateNsynthFamilyControlManifestForRepository(value, root);
}

export function nsynthFamilyControlPath(
  repositoryRoot: string,
  manifest: NsynthFamilyControlManifest,
  control: NsynthFamilyControl
): string {
  const root = resolve(repositoryRoot);
  const path = resolve(root, manifest.archive.outputDirectory, control.localFile);
  if (!path.startsWith(`${root}${sep}`)) {
    throw new Error('NSynth family control path escaped the repository');
  }
  return path;
}
