import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export const VCSL_EXACT_CONTROL_MANIFEST_PATH =
  'tests/corpus/vcsl-exact-control-manifest.json' as const;
export const VCSL_EXACT_CONTROL_MANIFEST_SHA256 =
  'e173e8ac6f28d95c6745601167d14cc46122fbb164f604abfcb9de2c99fe2716' as const;
export const VCSL_EXACT_CONTROL_SCHEMA =
  'stem-splitter.vcsl-exact-control-corpus.v1' as const;
export const VCSL_EXACT_CONTROL_VERSION = 'vcsl-c1ea7bc-exact-controls-v1' as const;
export const VCSL_EXACT_CONTROL_REVIEW_STATUS =
  'repository-authored-exact-labels-awaiting-teacher-listening' as const;
export const VCSL_EXACT_CONTROL_OUTPUT_DIRECTORY =
  'tests/corpus/audio/vcsl-exact-controls-v1' as const;
export const VCSL_COMMIT = 'c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e' as const;

const VOCABULARY_PATH = 'instrument-discovery/vocabulary.json' as const;
const VOCABULARY_VERSION = 'classroom-instruments-v1' as const;
const VOCABULARY_SHA256 =
  '72b7ab09cc188bf5cb8b47acf55145c45703cd4368e94c372cce8130f96ba140' as const;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA1 = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface VcslEvidenceObject {
  sourcePath: 'LICENSE' | 'README.md';
  url: string;
  gitBlobSha1: string;
  bytes: number;
  sha256: string;
  contentType: 'text/plain';
}

export interface VcslControlMedia {
  bytes: number;
  sha256: string;
  riffBytes: number;
  formatTag: 1;
  sampleRate: 44_100;
  channels: 1 | 2;
  bitsPerSample: 24;
  byteRate: 132_300 | 264_600;
  blockAlign: 3 | 6;
  dataBytes: number;
  frameCount: number;
  codec: 'pcm_s24le';
  chunks: Array<{ id: string; bytes: number }>;
}

export interface VcslExactControl {
  id: 'vcsl-harmonica-special20-c4-normal' | 'vcsl-xylophone-medium-c4-ff';
  sourceInstrument: 'Harmonica' | 'Xylophone';
  vocabularyId: 'harmonica' | 'mallet-percussion';
  coverageGroup: 'harmonica' | 'pitched-percussion';
  sourcePath: string;
  sourceUrl: string;
  gitBlobSha1: string;
  localFile: string;
  sourceMetadata: Record<string, string | number>;
  response: {
    contentType: 'audio/wav';
    contentDisposition: string;
  };
  media: VcslControlMedia;
}

export interface VcslExactControlManifest {
  $schema: typeof VCSL_EXACT_CONTROL_SCHEMA;
  version: typeof VCSL_EXACT_CONTROL_VERSION;
  reviewStatus: typeof VCSL_EXACT_CONTROL_REVIEW_STATUS;
  reviewVocabulary: {
    path: typeof VOCABULARY_PATH;
    version: typeof VOCABULARY_VERSION;
    sha256: typeof VOCABULARY_SHA256;
  };
  repository: {
    name: 'Versilian Community Sample Library';
    shortName: 'VCSL';
    owner: 'sgossner';
    repositoryUrl: 'https://github.com/sgossner/VCSL';
    commit: typeof VCSL_COMMIT;
    commitUrl: string;
    committedAt: '2026-01-14T20:39:38Z';
    treeApiUrl: string;
    treeEntryCount: 4550;
    treeTruncated: false;
    recordingType: 'isolated-single-instrument-samples';
    license: 'CC0-1.0';
    licenseCanonicalUrl: 'https://creativecommons.org/publicdomain/zero/1.0/';
    licenseEvidence: VcslEvidenceObject;
    readmeEvidence: VcslEvidenceObject;
    citation: string;
    verifiedAt: '2026-08-10';
  };
  hydration: {
    requestTimeoutMs: 120_000;
    maximumResponseBytes: 1_048_576;
    outputDirectory: typeof VCSL_EXACT_CONTROL_OUTPUT_DIRECTORY;
  };
  selectionPolicy: {
    controlsPerCoverageGroup: 1;
    harmonica: 'Hohner Special 20 in C, normal C4 sustain';
    pitchedPercussion: 'xylophone, medium mallet, C4, ff, round robin 01, far microphone';
    selectionAuthority: 'immutable-repository-path-and-blob';
    teacherMustReviewTypicality: true;
  };
  coverage: {
    filledExactPositiveGroups: ['harmonica', 'pitched-percussion'];
    remainingExactPositiveGroups: ['traditional-instruments'];
  };
  claimPolicy: {
    groundTruthLevel: 'repository-authored-instrument-directory-and-filename';
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
  controls: VcslExactControl[];
}

interface EvidencePin {
  sourcePath: VcslEvidenceObject['sourcePath'];
  url: string;
  gitBlobSha1: string;
  bytes: number;
  sha256: string;
}

interface ControlPin {
  id: VcslExactControl['id'];
  sourceInstrument: VcslExactControl['sourceInstrument'];
  vocabularyId: VcslExactControl['vocabularyId'];
  coverageGroup: VcslExactControl['coverageGroup'];
  sourcePath: string;
  sourceUrl: string;
  gitBlobSha1: string;
  localFile: string;
  sourceMetadata: Record<string, string | number>;
  contentDisposition: string;
  media: VcslControlMedia;
}

export const VCSL_LICENSE_EVIDENCE_PIN: Readonly<EvidencePin> = {
  sourcePath: 'LICENSE',
  url: `https://raw.githubusercontent.com/sgossner/VCSL/${VCSL_COMMIT}/LICENSE`,
  gitBlobSha1: '0e259d42c996742e9e3cba14c677129b2c1b6311',
  bytes: 7_048,
  sha256: 'a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499',
};

export const VCSL_README_EVIDENCE_PIN: Readonly<EvidencePin> = {
  sourcePath: 'README.md',
  url: `https://raw.githubusercontent.com/sgossner/VCSL/${VCSL_COMMIT}/README.md`,
  gitBlobSha1: '655eaa2be2a415dfa526bf6e7729aa40590ac0e8',
  bytes: 4_365,
  sha256: '6f7214a188f106c917d6503748485413c3e47cf56bce69f82beb9d16aa0894a9',
};

const CONTROL_PINS: readonly ControlPin[] = [
  {
    id: 'vcsl-harmonica-special20-c4-normal',
    sourceInstrument: 'Harmonica',
    vocabularyId: 'harmonica',
    coverageGroup: 'harmonica',
    sourcePath:
      'Aerophones/Free Aerophones/Harmonica-Hohner-Special20-C/Sustains/Normal/Hohner-Special20_Normal_C4.wav',
    sourceUrl:
      `https://raw.githubusercontent.com/sgossner/VCSL/${VCSL_COMMIT}/Aerophones/Free%20Aerophones/Harmonica-Hohner-Special20-C/Sustains/Normal/Hohner-Special20_Normal_C4.wav`,
    gitBlobSha1: 'fd3b6a0d917520b051e9ea64f5901ed195c27dc3',
    localFile: 'vcsl-harmonica-special20-c4-normal.wav',
    sourceMetadata: {
      instrumentModel: 'Hohner Special 20', instrumentKey: 'C',
      articulation: 'sustain-normal', pitch: 'C4',
    },
    contentDisposition:
      'attachment; filename=Aerophones/Free Aerophones/Harmonica-Hohner-Special20-C/Sustains/Normal/Hohner-Special20_Normal_C4.wav',
    media: {
      bytes: 678_192,
      sha256: 'ffb181bf9db1e30eb1b4824a9e923c6c81bd0c411143996639fe829131a47744',
      riffBytes: 678_184,
      formatTag: 1,
      sampleRate: 44_100,
      channels: 1,
      bitsPerSample: 24,
      byteRate: 132_300,
      blockAlign: 3,
      dataBytes: 678_147,
      frameCount: 226_049,
      codec: 'pcm_s24le',
      chunks: [{ id: 'fmt ', bytes: 16 }, { id: 'data', bytes: 678_147 }],
    },
  },
  {
    id: 'vcsl-xylophone-medium-c4-ff',
    sourceInstrument: 'Xylophone',
    vocabularyId: 'mallet-percussion',
    coverageGroup: 'pitched-percussion',
    sourcePath:
      'Idiophones/Struck Idiophones/Xylophone/Medium Mallets/Xylo_Medium_C4_ff_01_far.wav',
    sourceUrl:
      `https://raw.githubusercontent.com/sgossner/VCSL/${VCSL_COMMIT}/Idiophones/Struck%20Idiophones/Xylophone/Medium%20Mallets/Xylo_Medium_C4_ff_01_far.wav`,
    gitBlobSha1: 'af5c4ea6431fc38aa5049cd202dde9e58102e6b7',
    localFile: 'vcsl-xylophone-medium-c4-ff.wav',
    sourceMetadata: {
      mallet: 'medium', pitch: 'C4', dynamic: 'ff', roundRobin: 1, microphone: 'far',
    },
    contentDisposition:
      'attachment; filename=Idiophones/Struck Idiophones/Xylophone/Medium Mallets/Xylo_Medium_C4_ff_01_far.wav',
    media: {
      bytes: 897_126,
      sha256: 'ef8650516f0734369c5f409f726315db13544e508f59cb82cf46f4206c10518d',
      riffBytes: 897_118,
      formatTag: 1,
      sampleRate: 44_100,
      channels: 2,
      bitsPerSample: 24,
      byteRate: 264_600,
      blockAlign: 6,
      dataBytes: 892_044,
      frameCount: 148_674,
      codec: 'pcm_s24le',
      chunks: [
        { id: 'fmt ', bytes: 18 }, { id: 'data', bytes: 892_044 }, { id: '_PMX', bytes: 5_028 },
      ],
    },
  },
] as const;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
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

function exactUrl(value: unknown, expected: string, context: string): void {
  if (value !== expected) throw new Error(`${context} drifted`);
  const parsed = new URL(expected);
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
    parsed.hash || (parsed.search && context !== 'VCSL tree API URL')
  ) {
    throw new Error(`${context} is unsafe`);
  }
}

function validateVocabulary(value: unknown, repositoryRoot: string): void {
  if (!record(value)) throw new Error('VCSL review vocabulary is invalid');
  exactKeys(value, ['path', 'version', 'sha256'], 'VCSL review vocabulary');
  exactJson(value, {
    path: VOCABULARY_PATH, version: VOCABULARY_VERSION, sha256: VOCABULARY_SHA256,
  }, 'VCSL review vocabulary');
  const bytes = readFileSync(resolve(repositoryRoot, VOCABULARY_PATH));
  if (sha256(bytes) !== VOCABULARY_SHA256) throw new Error('VCSL review vocabulary bytes drifted');
  const vocabulary = JSON.parse(bytes.toString('utf8')) as { instruments?: Array<{ id?: string }> };
  const ids = new Set(vocabulary.instruments?.map(({ id }) => id));
  for (const pin of CONTROL_PINS) {
    if (!ids.has(pin.vocabularyId)) throw new Error(`${pin.id}: vocabulary label is unavailable`);
  }
}

function validateEvidence(value: unknown, pin: EvidencePin, context: string): VcslEvidenceObject {
  if (!record(value)) throw new Error(`${context} is invalid`);
  exactKeys(value, ['sourcePath', 'url', 'gitBlobSha1', 'bytes', 'sha256', 'contentType'], context);
  exactJson(value, { ...pin, contentType: 'text/plain' }, context);
  exactUrl(value.url, pin.url, `${context} URL`);
  if (!GIT_SHA1.test(pin.gitBlobSha1) || !SHA256.test(pin.sha256)) {
    throw new Error(`${context} digest pin is invalid`);
  }
  return value as unknown as VcslEvidenceObject;
}

function validateRepository(value: unknown): VcslExactControlManifest['repository'] {
  if (!record(value)) throw new Error('VCSL repository metadata is invalid');
  exactKeys(value, [
    'name', 'shortName', 'owner', 'repositoryUrl', 'commit', 'commitUrl', 'committedAt',
    'treeApiUrl', 'treeEntryCount', 'treeTruncated', 'recordingType', 'license',
    'licenseCanonicalUrl', 'licenseEvidence', 'readmeEvidence', 'citation', 'verifiedAt',
  ], 'VCSL repository metadata');
  const commitUrl = `https://github.com/sgossner/VCSL/commit/${VCSL_COMMIT}`;
  const treeApiUrl = `https://api.github.com/repos/sgossner/VCSL/git/trees/${VCSL_COMMIT}?recursive=1`;
  const expected = {
    name: 'Versilian Community Sample Library', shortName: 'VCSL', owner: 'sgossner',
    repositoryUrl: 'https://github.com/sgossner/VCSL', commit: VCSL_COMMIT, commitUrl,
    committedAt: '2026-01-14T20:39:38Z', treeApiUrl, treeEntryCount: 4550,
    treeTruncated: false, recordingType: 'isolated-single-instrument-samples',
    license: 'CC0-1.0',
    licenseCanonicalUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    verifiedAt: '2026-08-10',
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) throw new Error(`VCSL repository ${key} drifted`);
  }
  exactUrl(value.repositoryUrl, expected.repositoryUrl, 'VCSL repository URL');
  exactUrl(value.commitUrl, commitUrl, 'VCSL commit URL');
  exactUrl(value.treeApiUrl, treeApiUrl, 'VCSL tree API URL');
  exactUrl(value.licenseCanonicalUrl, expected.licenseCanonicalUrl, 'VCSL canonical license URL');
  validateEvidence(value.licenseEvidence, VCSL_LICENSE_EVIDENCE_PIN, 'VCSL license evidence');
  validateEvidence(value.readmeEvidence, VCSL_README_EVIDENCE_PIN, 'VCSL README evidence');
  if (
    typeof value.citation !== 'string' || value.citation.length < 160 ||
    !value.citation.includes(VCSL_COMMIT) || !value.citation.includes('CC0 1.0 Universal')
  ) {
    throw new Error('VCSL citation drifted');
  }
  return value as unknown as VcslExactControlManifest['repository'];
}

function validatePolicies(value: JsonRecord): void {
  exactJson(value.hydration, {
    requestTimeoutMs: 120_000, maximumResponseBytes: 1_048_576,
    outputDirectory: VCSL_EXACT_CONTROL_OUTPUT_DIRECTORY,
  }, 'VCSL hydration policy');
  exactJson(value.selectionPolicy, {
    controlsPerCoverageGroup: 1,
    harmonica: 'Hohner Special 20 in C, normal C4 sustain',
    pitchedPercussion: 'xylophone, medium mallet, C4, ff, round robin 01, far microphone',
    selectionAuthority: 'immutable-repository-path-and-blob', teacherMustReviewTypicality: true,
  }, 'VCSL selection policy');
  exactJson(value.coverage, {
    filledExactPositiveGroups: ['harmonica', 'pitched-percussion'],
    remainingExactPositiveGroups: ['traditional-instruments'],
  }, 'VCSL exact-positive coverage');
  exactJson(value.claimPolicy, {
    groundTruthLevel: 'repository-authored-instrument-directory-and-filename',
    exactInstrumentClaims: 'source-label-only',
    vocabularyPositiveClaims: 'candidate-awaiting-teacher-listening',
    candidateNegativeClaims: 'none', teacherMustReviewEveryControl: true,
    mixedTrackUse: 'forbidden', currentEvaluationPlanUse: 'forbidden',
    reportingPartition: 'isolated-exact-control',
    classifierSelectionUse: 'forbidden-until-reviewed-and-plan-integrated',
    promotionUse: 'forbidden-until-reviewed-and-plan-integrated',
  }, 'VCSL claim policy');
}

function validateControl(value: unknown, pin: ControlPin, index: number): VcslExactControl {
  const context = `VCSL control ${index + 1}`;
  if (!record(value)) throw new Error(`${context} is invalid`);
  exactKeys(value, [
    'id', 'sourceInstrument', 'vocabularyId', 'coverageGroup', 'sourcePath', 'sourceUrl',
    'gitBlobSha1', 'localFile', 'sourceMetadata', 'response', 'media',
  ], context);
  for (const key of [
    'id', 'sourceInstrument', 'vocabularyId', 'coverageGroup', 'sourcePath', 'sourceUrl',
    'gitBlobSha1', 'localFile',
  ] as const) {
    if (value[key] !== pin[key]) throw new Error(`${context} ${key} drifted`);
  }
  if (!SAFE_ID.test(pin.id) || !GIT_SHA1.test(pin.gitBlobSha1)) {
    throw new Error(`${context} identity pin is invalid`);
  }
  exactUrl(value.sourceUrl, pin.sourceUrl, `${context} source URL`);
  exactJson(value.sourceMetadata, pin.sourceMetadata, `${context} source metadata`);
  exactJson(value.response, {
    contentType: 'audio/wav', contentDisposition: pin.contentDisposition,
  }, `${context} response contract`);
  exactJson(value.media, pin.media, `${context} media contract`);
  if (!SHA256.test(pin.media.sha256) || pin.media.riffBytes !== pin.media.bytes - 8) {
    throw new Error(`${context} media digest or RIFF pin is invalid`);
  }
  const calculatedBytes = 12 + pin.media.chunks.reduce(
    (total, chunk) => total + 8 + chunk.bytes + (chunk.bytes % 2), 0
  );
  if (
    calculatedBytes !== pin.media.bytes ||
    pin.media.byteRate !== pin.media.sampleRate * pin.media.blockAlign ||
    pin.media.blockAlign !== pin.media.channels * (pin.media.bitsPerSample / 8) ||
    pin.media.dataBytes !== pin.media.frameCount * pin.media.blockAlign
  ) {
    throw new Error(`${context} PCM or chunk pins are inconsistent`);
  }
  return value as unknown as VcslExactControl;
}

export function validateVcslExactControlManifestForRepository(
  value: unknown,
  repositoryRoot = process.cwd()
): VcslExactControlManifest {
  if (!record(value)) throw new Error('VCSL exact control manifest is invalid');
  exactKeys(value, [
    '$schema', 'version', 'reviewStatus', 'reviewVocabulary', 'repository', 'hydration',
    'selectionPolicy', 'coverage', 'claimPolicy', 'controls',
  ], 'VCSL exact control manifest');
  if (
    value.$schema !== VCSL_EXACT_CONTROL_SCHEMA || value.version !== VCSL_EXACT_CONTROL_VERSION ||
    value.reviewStatus !== VCSL_EXACT_CONTROL_REVIEW_STATUS
  ) {
    throw new Error('VCSL exact control manifest identity drifted');
  }
  validateVocabulary(value.reviewVocabulary, repositoryRoot);
  validateRepository(value.repository);
  validatePolicies(value);
  if (!Array.isArray(value.controls) || value.controls.length !== CONTROL_PINS.length) {
    throw new Error('VCSL exact controls must preserve the selected tranche');
  }
  const controls = value.controls.map((control, index) => validateControl(control, CONTROL_PINS[index], index));
  for (const field of [
    'id', 'sourcePath', 'sourceUrl', 'gitBlobSha1', 'localFile', 'coverageGroup',
  ] as const) {
    if (new Set(controls.map((control) => control[field])).size !== controls.length) {
      throw new Error(`VCSL control ${field} values must be unique`);
    }
  }
  return { ...value, controls } as unknown as VcslExactControlManifest;
}

export function loadVcslExactControlManifest(
  repositoryRoot = process.cwd(),
  manifestPath = VCSL_EXACT_CONTROL_MANIFEST_PATH
): VcslExactControlManifest {
  const root = realpathSync(resolve(repositoryRoot));
  const manifestFile = resolve(root, manifestPath);
  const metadata = lstatSync(manifestFile);
  if (
    !manifestFile.startsWith(`${root}${sep}`) || metadata.isSymbolicLink() || !metadata.isFile() ||
    metadata.size < 2 || metadata.size > 256 * 1024 || realpathSync(manifestFile) !== manifestFile
  ) {
    throw new Error('VCSL exact control manifest is not a bounded repository file');
  }
  const bytes = readFileSync(manifestFile);
  if (sha256(bytes) !== VCSL_EXACT_CONTROL_MANIFEST_SHA256) {
    throw new Error('VCSL exact control manifest bytes drifted');
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('VCSL exact control manifest is not valid JSON');
  }
  return validateVcslExactControlManifestForRepository(value, root);
}

export function vcslExactControlPath(
  repositoryRoot: string,
  manifest: VcslExactControlManifest,
  control: VcslExactControl
): string {
  const root = resolve(repositoryRoot);
  const controlFile = resolve(root, manifest.hydration.outputDirectory, control.localFile);
  if (!controlFile.startsWith(`${root}${sep}`)) throw new Error('VCSL control path escaped the repository');
  return controlFile;
}
