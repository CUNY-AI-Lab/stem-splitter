import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INSTRUMENT_CONTROL_MANIFEST_PATH =
  'tests/corpus/instrument-control-manifest.json';
export const INSTRUMENT_CONTROL_SCHEMA =
  'stem-splitter.instrument-control-corpus.v1';
export const INSTRUMENT_CONTROL_VERSION = 'choralebricks-wind-controls-v1';
export const INSTRUMENT_CONTROL_REVIEW_STATUS =
  'dataset-authored-awaiting-teacher-listening';
export const INSTRUMENT_CONTROL_OUTPUT_DIRECTORY =
  'tests/corpus/audio/instrument-controls-v1';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VOCABULARY_PATH = 'instrument-discovery/vocabulary.json';
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_PIECE_ID = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/;
const SAFE_TRACK_FILE = /^\d{2}_[a-z0-9]+\.m4a$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EXPECTED_CONTROL_IDS = [
  'flute-an1',
  'oboe-ba1',
  'clarinet-cr1',
  'trumpet-an1',
  'horn-cr1',
  'trombone-ba1',
  'saxophone-cr1',
  'tuba-an1',
] as const;
const EXPECTED_CONTROL_PINS: Record<
  (typeof EXPECTED_CONTROL_IDS)[number],
  {
    pieceId: string;
    pieceCode: string;
    part: InstrumentControl['part'];
    instrument: string;
    trackFile: string;
    bytes: number;
    sha256: string;
    durationSeconds: number;
  }
> = {
  'flute-an1': {
    pieceId: 'Anonymous_AusMeinesHerzensGrunde',
    pieceCode: 'AN1',
    part: 'soprano',
    instrument: 'flute',
    trackFile: '01_fl.m4a',
    bytes: 1_063_644,
    sha256: 'bddb80b91627c35f8921924628de86709d239088cd6cc5199cff12c575b7d1e0',
    durationSeconds: 57.328005,
  },
  'oboe-ba1': {
    pieceId: 'Bach_IchStehAnDeinerKrippe',
    pieceCode: 'BA1',
    part: 'soprano',
    instrument: 'oboe',
    trackFile: '01_ob.m4a',
    bytes: 791_847,
    sha256: 'e0def2737a77dea90e237e41ab43012e5cb461b126df5909c55e7c73ad7b0ef7',
    durationSeconds: 44.880998,
  },
  'clarinet-cr1': {
    pieceId: 'Crueger_AufAufMeinHerzMitFreuden',
    pieceCode: 'CR1',
    part: 'soprano',
    instrument: 'clarinet',
    trackFile: '01_cl.m4a',
    bytes: 888_017,
    sha256: 'aa797937016741e79e9a6ca052fd7513e4b2c1745f7210e6ff2744f43e59d371',
    durationSeconds: 48.5,
  },
  'trumpet-an1': {
    pieceId: 'Anonymous_AusMeinesHerzensGrunde',
    pieceCode: 'AN1',
    part: 'soprano',
    instrument: 'trumpet',
    trackFile: '01_tp.m4a',
    bytes: 1_139_897,
    sha256: '4c92fdc32afa92bfc4628ec174e867efe6ac307aed456f48f99bf5331c5223ff',
    durationSeconds: 57.328005,
  },
  'horn-cr1': {
    pieceId: 'Crueger_AufAufMeinHerzMitFreuden',
    pieceCode: 'CR1',
    part: 'tenor',
    instrument: 'horn',
    trackFile: '03_fho.m4a',
    bytes: 875_571,
    sha256: 'cfcd66bb8336cc59f685a83a99c3a881b5152e6c991826eee7ef7626d8ef030f',
    durationSeconds: 48.5,
  },
  'trombone-ba1': {
    pieceId: 'Bach_IchStehAnDeinerKrippe',
    pieceCode: 'BA1',
    part: 'bass',
    instrument: 'trombone',
    trackFile: '04_tb.m4a',
    bytes: 901_952,
    sha256: '04934747ac767c1851c6be0fe79fbeb16328f9b2c2f5351a2b998c355da6f5c0',
    durationSeconds: 44.880998,
  },
  'saxophone-cr1': {
    pieceId: 'Crueger_AufAufMeinHerzMitFreuden',
    pieceCode: 'CR1',
    part: 'soprano',
    instrument: 'saxophone',
    trackFile: '01_as.m4a',
    bytes: 889_719,
    sha256: '77a481093761682d392e6eb839aa43a4b8d93e2ad20477718c524a159c78951a',
    durationSeconds: 48.5,
  },
  'tuba-an1': {
    pieceId: 'Anonymous_AusMeinesHerzensGrunde',
    pieceCode: 'AN1',
    part: 'bass',
    instrument: 'tuba',
    trackFile: '04_tba.m4a',
    bytes: 1_131_045,
    sha256: 'db6b8f063b31014d5215833b261066ce02b01975c44228f161d51645ca15c011',
    durationSeconds: 57.328005,
  },
};

export interface InstrumentControlMedia {
  bytes: number;
  sha256: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  codec: 'aac';
}

export interface InstrumentControl {
  id: string;
  pieceId: string;
  pieceCode: string;
  part: 'soprano' | 'alto' | 'tenor' | 'bass';
  instrument: string;
  trackFile: string;
  sourceUrl: string;
  localFile: string;
  media: InstrumentControlMedia;
  positiveIds: string[];
}

export interface InstrumentControlManifest {
  $schema: typeof INSTRUMENT_CONTROL_SCHEMA;
  version: typeof INSTRUMENT_CONTROL_VERSION;
  reviewStatus: typeof INSTRUMENT_CONTROL_REVIEW_STATUS;
  vocabularyVersion: 'classroom-instruments-v1';
  vocabularySha256: string;
  dataset: {
    name: 'ChoraleBricks';
    version: '1.1.0';
    recordingType: 'isolated-performed-wind-instrument-tracks';
    landingPage: string;
    paperUrl: string;
    paperDoi: '10.5334/tismir.252';
    zenodoConceptDoi: '10.5281/zenodo.15081740';
    zenodoRecordId: '20849469';
    license: 'CC BY 4.0';
    licenseUrl: string;
    citation: string;
    verifiedAt: string;
  };
  downloadPolicy: {
    sourceOrigin: 'https://www.audiolabs-erlangen.de';
    sourcePathPrefix: '/resources/MIR/2025-ChoraleBricks/';
    redirectStatus: 307;
    redirectOrigin: 'https://www.audiolabs-erlangen.de';
    redirectPathPrefix: '/media/pages/resources/MIR/2025-ChoraleBricks/';
    maximumRedirects: 1;
    maximumBytesPerFile: number;
    contentType: 'audio/mp4';
    requestTimeoutMs: number;
    outputDirectory: typeof INSTRUMENT_CONTROL_OUTPUT_DIRECTORY;
  };
  negativePolicy: {
    basis: 'all-vocabulary-ids-except-positive-ids';
    reviewStatus: 'candidate-only-awaiting-teacher-listening';
    precisionClaim: 'none';
  };
  controls: InstrumentControl[];
}

export interface VocabularyBinding {
  version: string;
  sha256: string;
  familyById: Map<string, string>;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  context: string
): void {
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error(`${context} does not match the pinned schema`);
  }
}

function safeString(value: unknown, pattern: RegExp, context: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function safeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  context: string
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${context} is invalid`);
  }
  return value as number;
}

function finiteNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  context: string
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function exactUrl(value: unknown, expected: string, context: string): string {
  if (value !== expected) throw new Error(`${context} is invalid`);
  const parsed = new URL(expected);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${context} is invalid`);
  }
  return expected;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function loadVocabularyBinding(repositoryRoot: string): VocabularyBinding {
  const bytes = readFileSync(resolve(repositoryRoot, VOCABULARY_PATH));
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!record(value) || !Array.isArray(value.instruments) || typeof value.version !== 'string') {
    throw new Error('instrument vocabulary is invalid');
  }
  const familyById = new Map<string, string>();
  for (const item of value.instruments) {
    if (
      !record(item) ||
      typeof item.id !== 'string' ||
      !SAFE_ID.test(item.id) ||
      typeof item.family !== 'string' ||
      !SAFE_ID.test(item.family) ||
      familyById.has(item.id)
    ) {
      throw new Error('instrument vocabulary item is invalid');
    }
    familyById.set(item.id, item.family);
  }
  return { version: value.version, sha256: sha256(bytes), familyById };
}

function validateDataset(value: unknown): InstrumentControlManifest['dataset'] {
  if (!record(value)) throw new Error('instrument control dataset is invalid');
  exactKeys(
    value,
    [
      'name',
      'version',
      'recordingType',
      'landingPage',
      'paperUrl',
      'paperDoi',
      'zenodoConceptDoi',
      'zenodoRecordId',
      'license',
      'licenseUrl',
      'citation',
      'verifiedAt',
    ],
    'instrument control dataset'
  );
  if (
    value.name !== 'ChoraleBricks' ||
    value.version !== '1.1.0' ||
    value.recordingType !== 'isolated-performed-wind-instrument-tracks' ||
    value.paperDoi !== '10.5334/tismir.252' ||
    value.zenodoConceptDoi !== '10.5281/zenodo.15081740' ||
    value.zenodoRecordId !== '20849469' ||
    value.license !== 'CC BY 4.0' ||
    typeof value.citation !== 'string' ||
    value.citation.length < 100 ||
    typeof value.verifiedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.verifiedAt) ||
    !Number.isFinite(Date.parse(`${value.verifiedAt}T00:00:00Z`))
  ) {
    throw new Error('instrument control dataset identity is invalid');
  }
  exactUrl(
    value.landingPage,
    'https://www.audiolabs-erlangen.de/resources/MIR/2025-ChoraleBricks',
    'instrument control landing page'
  );
  exactUrl(
    value.paperUrl,
    'https://transactions.ismir.net/articles/10.5334/tismir.252',
    'instrument control paper URL'
  );
  exactUrl(
    value.licenseUrl,
    'https://creativecommons.org/licenses/by/4.0/',
    'instrument control license URL'
  );
  return value as unknown as InstrumentControlManifest['dataset'];
}

function validateDownloadPolicy(value: unknown): InstrumentControlManifest['downloadPolicy'] {
  if (!record(value)) throw new Error('instrument control download policy is invalid');
  exactKeys(
    value,
    [
      'sourceOrigin',
      'sourcePathPrefix',
      'redirectStatus',
      'redirectOrigin',
      'redirectPathPrefix',
      'maximumRedirects',
      'maximumBytesPerFile',
      'contentType',
      'requestTimeoutMs',
      'outputDirectory',
    ],
    'instrument control download policy'
  );
  if (
    value.sourceOrigin !== 'https://www.audiolabs-erlangen.de' ||
    value.sourcePathPrefix !== '/resources/MIR/2025-ChoraleBricks/' ||
    value.redirectStatus !== 307 ||
    value.redirectOrigin !== 'https://www.audiolabs-erlangen.de' ||
    value.redirectPathPrefix !== '/media/pages/resources/MIR/2025-ChoraleBricks/' ||
    value.maximumRedirects !== 1 ||
    value.contentType !== 'audio/mp4' ||
    value.outputDirectory !== INSTRUMENT_CONTROL_OUTPUT_DIRECTORY
  ) {
    throw new Error('instrument control download policy identity is invalid');
  }
  safeInteger(value.maximumBytesPerFile, 1_000_000, 2_097_152, 'maximum control bytes');
  safeInteger(value.requestTimeoutMs, 5_000, 60_000, 'control request timeout');
  return value as unknown as InstrumentControlManifest['downloadPolicy'];
}

function validateControl(
  value: unknown,
  policy: InstrumentControlManifest['downloadPolicy'],
  vocabulary: VocabularyBinding
): InstrumentControl {
  if (!record(value)) throw new Error('instrument control is invalid');
  exactKeys(
    value,
    [
      'id',
      'pieceId',
      'pieceCode',
      'part',
      'instrument',
      'trackFile',
      'sourceUrl',
      'localFile',
      'media',
      'positiveIds',
    ],
    'instrument control'
  );
  const id = safeString(value.id, SAFE_ID, 'instrument control id');
  const pieceId = safeString(value.pieceId, SAFE_PIECE_ID, `${id} piece id`);
  const pieceCode = safeString(value.pieceCode, /^[A-Z]{2}\d$/, `${id} piece code`);
  const instrument = safeString(value.instrument, SAFE_ID, `${id} instrument`);
  const trackFile = safeString(value.trackFile, SAFE_TRACK_FILE, `${id} track file`);
  if (!['soprano', 'alto', 'tenor', 'bass'].includes(value.part as string)) {
    throw new Error(`${id} part is invalid`);
  }
  if (value.localFile !== `${id}.m4a`) throw new Error(`${id} local filename is invalid`);
  const expectedUrl = `${policy.sourceOrigin}${policy.sourcePathPrefix}${pieceId}/tracks/${trackFile}`;
  exactUrl(value.sourceUrl, expectedUrl, `${id} source URL`);

  if (!record(value.media)) throw new Error(`${id} media identity is invalid`);
  exactKeys(
    value.media,
    ['bytes', 'sha256', 'durationSeconds', 'sampleRate', 'channels', 'codec'],
    `${id} media identity`
  );
  const media: InstrumentControlMedia = {
    bytes: safeInteger(value.media.bytes, 100_000, policy.maximumBytesPerFile, `${id} byte count`),
    sha256: safeString(value.media.sha256, SHA256, `${id} SHA-256`),
    durationSeconds: finiteNumber(value.media.durationSeconds, 10, 120, `${id} duration`),
    sampleRate: safeInteger(value.media.sampleRate, 44_100, 44_100, `${id} sample rate`),
    channels: safeInteger(value.media.channels, 1, 1, `${id} channel count`),
    codec: value.media.codec === 'aac' ? 'aac' : (() => { throw new Error(`${id} codec is invalid`); })(),
  };
  if (!Array.isArray(value.positiveIds) || value.positiveIds.length < 1 || value.positiveIds.length > 2) {
    throw new Error(`${id} positive labels are invalid`);
  }
  const positiveIds = value.positiveIds.map((candidate) =>
    safeString(candidate, SAFE_ID, `${id} positive label`)
  );
  if (
    new Set(positiveIds).size !== positiveIds.length ||
    !positiveIds.includes(instrument) ||
    positiveIds.some((candidate) => !vocabulary.familyById.has(candidate))
  ) {
    throw new Error(`${id} positive labels are invalid`);
  }
  const family = vocabulary.familyById.get(instrument);
  const expectedPositives = family === 'brass' ? ['brass', instrument] : [instrument];
  if (JSON.stringify(positiveIds) !== JSON.stringify(expectedPositives)) {
    throw new Error(`${id} positive labels do not match the vocabulary hierarchy`);
  }
  const pin = EXPECTED_CONTROL_PINS[id as keyof typeof EXPECTED_CONTROL_PINS];
  if (
    !pin ||
    pieceId !== pin.pieceId ||
    pieceCode !== pin.pieceCode ||
    value.part !== pin.part ||
    instrument !== pin.instrument ||
    trackFile !== pin.trackFile ||
    media.bytes !== pin.bytes ||
    media.sha256 !== pin.sha256 ||
    media.durationSeconds !== pin.durationSeconds
  ) {
    throw new Error(`${id} does not match the frozen control pin`);
  }
  return {
    id,
    pieceId,
    pieceCode,
    part: value.part as InstrumentControl['part'],
    instrument,
    trackFile,
    sourceUrl: expectedUrl,
    localFile: value.localFile as string,
    media,
    positiveIds,
  };
}

export function validateInstrumentControlManifest(
  value: unknown,
  vocabulary: VocabularyBinding
): InstrumentControlManifest {
  if (!record(value)) throw new Error('instrument control manifest is invalid');
  exactKeys(
    value,
    [
      '$schema',
      'version',
      'reviewStatus',
      'vocabularyVersion',
      'vocabularySha256',
      'dataset',
      'downloadPolicy',
      'negativePolicy',
      'controls',
    ],
    'instrument control manifest'
  );
  if (
    value.$schema !== INSTRUMENT_CONTROL_SCHEMA ||
    value.version !== INSTRUMENT_CONTROL_VERSION ||
    value.reviewStatus !== INSTRUMENT_CONTROL_REVIEW_STATUS ||
    value.vocabularyVersion !== 'classroom-instruments-v1' ||
    value.vocabularyVersion !== vocabulary.version ||
    value.vocabularySha256 !== vocabulary.sha256 ||
    !SHA256.test(value.vocabularySha256 as string)
  ) {
    throw new Error('instrument control manifest identity is invalid');
  }
  const dataset = validateDataset(value.dataset);
  const downloadPolicy = validateDownloadPolicy(value.downloadPolicy);
  if (!record(value.negativePolicy)) throw new Error('instrument control negative policy is invalid');
  exactKeys(
    value.negativePolicy,
    ['basis', 'reviewStatus', 'precisionClaim'],
    'instrument control negative policy'
  );
  if (
    value.negativePolicy.basis !== 'all-vocabulary-ids-except-positive-ids' ||
    value.negativePolicy.reviewStatus !== 'candidate-only-awaiting-teacher-listening' ||
    value.negativePolicy.precisionClaim !== 'none'
  ) {
    throw new Error('instrument control negative policy identity is invalid');
  }
  if (!Array.isArray(value.controls) || value.controls.length !== EXPECTED_CONTROL_IDS.length) {
    throw new Error('instrument control surface is incomplete');
  }
  const controls = value.controls.map((control) =>
    validateControl(control, downloadPolicy, vocabulary)
  );
  const ids = controls.map((control) => control.id);
  if (
    new Set(ids).size !== ids.length ||
    JSON.stringify(ids) !== JSON.stringify(EXPECTED_CONTROL_IDS) ||
    new Set(controls.map((control) => control.sourceUrl)).size !== controls.length ||
    new Set(controls.map((control) => control.localFile)).size !== controls.length ||
    new Set(controls.map((control) => control.media.sha256)).size !== controls.length
  ) {
    throw new Error('instrument control identity is incomplete or duplicated');
  }
  const familyCounts = controls.reduce<Record<string, number>>((counts, control) => {
    const family = vocabulary.familyById.get(control.instrument) ?? 'unknown';
    counts[family] = (counts[family] ?? 0) + 1;
    return counts;
  }, {});
  if (familyCounts.woodwind !== 4 || familyCounts.brass !== 4 || Object.keys(familyCounts).length !== 2) {
    throw new Error('instrument control family coverage drifted');
  }
  return {
    $schema: INSTRUMENT_CONTROL_SCHEMA,
    version: INSTRUMENT_CONTROL_VERSION,
    reviewStatus: INSTRUMENT_CONTROL_REVIEW_STATUS,
    vocabularyVersion: 'classroom-instruments-v1',
    vocabularySha256: vocabulary.sha256,
    dataset,
    downloadPolicy,
    negativePolicy: {
      basis: 'all-vocabulary-ids-except-positive-ids',
      reviewStatus: 'candidate-only-awaiting-teacher-listening',
      precisionClaim: 'none',
    },
    controls,
  };
}

export function loadInstrumentControlManifest(
  repositoryRoot = REPOSITORY_ROOT
): InstrumentControlManifest {
  const value: unknown = JSON.parse(
    readFileSync(resolve(repositoryRoot, INSTRUMENT_CONTROL_MANIFEST_PATH), 'utf8')
  );
  return validateInstrumentControlManifestForRepository(value, repositoryRoot);
}

export function validateInstrumentControlManifestForRepository(
  value: unknown,
  repositoryRoot = REPOSITORY_ROOT
): InstrumentControlManifest {
  return validateInstrumentControlManifest(value, loadVocabularyBinding(repositoryRoot));
}

export function instrumentControlPath(
  repositoryRoot: string,
  manifest: InstrumentControlManifest,
  control: InstrumentControl
): string {
  if (manifest.downloadPolicy.outputDirectory !== INSTRUMENT_CONTROL_OUTPUT_DIRECTORY) {
    throw new Error('instrument control output directory drifted');
  }
  const outputRoot = resolve(repositoryRoot, manifest.downloadPolicy.outputDirectory);
  const result = resolve(outputRoot, control.localFile);
  if (!result.startsWith(`${outputRoot}${sep}`)) throw new Error('instrument control path escaped');
  return result;
}
