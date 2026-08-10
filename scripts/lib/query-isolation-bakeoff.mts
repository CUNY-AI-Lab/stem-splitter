import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INSTRUMENT_CONTROL_MANIFEST_PATH,
  INSTRUMENT_CONTROL_REVIEW_STATUS,
  INSTRUMENT_CONTROL_VERSION,
  loadInstrumentControlManifest,
  type InstrumentControl,
  type InstrumentControlManifest,
} from './instrument-control-corpus.mts';

export const QUERY_ISOLATION_BAKEOFF_SCHEMA =
  'stem-splitter.query-isolation-bakeoff.v1' as const;
export const QUERY_ISOLATION_BAKEOFF_VERSION = 'long-tail-query-isolation-v1' as const;
export const QUERY_ISOLATION_BAKEOFF_REVIEW_STATUS =
  'fixture-ready-provider-runs-blocked' as const;
export const QUERY_ISOLATION_BAKEOFF_MANIFEST_PATH =
  'tests/corpus/query-isolation-bakeoff.json' as const;
export const QUERY_ISOLATION_BAKEOFF_OUTPUT_DIRECTORY =
  'tests/corpus/audio/query-isolation-bakeoff-v1' as const;
export const QUERY_ISOLATION_OUTPUT_DURATION_TOLERANCE_SECONDS = 0.5 as const;

export const SAM_AUDIO_OFFICIAL_REPOSITORY_COMMIT =
  'bb4c6999d2677c7402360e426afc01ddfad6dce0' as const;
export const SAM_AUDIO_OFFICIAL_LICENSE_SHA256 =
  '4dea99bfaa016e21bc860d73f344236bd1e5c4977d1a9a8fd32f822b500ae1be' as const;
export const SAM_AUDIO_HUGGING_FACE_REPOSITORY_COMMIT =
  '5f2cd3a9471a08c7282c06036be6893e18de8b70' as const;
export const SAM_AUDIO_COMMUNITY_WRAPPER_COMMIT =
  '52920550f9db9661aa240477b8334fe2457bc399' as const;
export const SAM_AUDIO_REPLICATE_MODEL = 'geopti/sam-audio-large' as const;
export const SAM_AUDIO_REPLICATE_VERSION =
  'd8a8a4fcdcbf0bdc863f6d98cd2117ec0bc02224b576c7b98b2a009a8a1f83fa' as const;

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CORE_CORPUS_PATH = 'tests/corpus/corpus.json';
const AUTO_EXPECTATIONS_PATH = 'tests/corpus/autosplit-expectations.json';
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_PROMPT = /^[a-z0-9]+(?:[ -][a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const OBJECTIVE_MODES = ['audiosep-text', 'sam-audio-text', 'sam-audio-span'] as const;
const SUBJECTIVE_MODES = ['audiosep-text', 'sam-audio-text'] as const;
const SUBJECTIVE_SOURCE_SLUGS = [
  'folk-duet',
  'orchestral',
  'jazz-sax',
  'hip-hop',
  'bluegrass',
  'synthwave',
] as const;

export type QueryIsolationBakeoffMode =
  | (typeof OBJECTIVE_MODES)[number]
  | (typeof SUBJECTIVE_MODES)[number];

export interface QueryIsolationObjectiveCase {
  id: string;
  targetControlId: string;
  interfererControlIds: string[];
  textPrompt: string;
  modes: readonly (typeof OBJECTIVE_MODES)[number][];
}

export interface QueryIsolationSubjectiveCase {
  id: string;
  sourceSlug: string;
  textPrompt: string;
  expectedInstrument: string;
  modes: readonly (typeof SUBJECTIVE_MODES)[number][];
}

export interface QueryIsolationFixturePolicy {
  sampleRate: 32000;
  channels: 1;
  durationSeconds: 24;
  targetGain: 0.25;
  interfererGain: 0.25;
  positiveSpan: [6, 18];
  negativeSpans: [[0, 5], [19, 24]];
  codec: 'pcm-f32le-wav';
  outputDirectory: typeof QUERY_ISOLATION_BAKEOFF_OUTPUT_DIRECTORY;
}

export interface QueryIsolationBakeoffManifest {
  $schema: typeof QUERY_ISOLATION_BAKEOFF_SCHEMA;
  version: typeof QUERY_ISOLATION_BAKEOFF_VERSION;
  reviewStatus: typeof QUERY_ISOLATION_BAKEOFF_REVIEW_STATUS;
  sourceBindings: Record<string, unknown>;
  providers: Array<Record<string, unknown>>;
  fixturePolicy: QueryIsolationFixturePolicy;
  objectiveCases: QueryIsolationObjectiveCase[];
  subjectiveCases: QueryIsolationSubjectiveCase[];
  metrics: Record<string, unknown>;
}

export interface QueryIsolationEvaluationInput {
  purpose: 'evaluation-only';
  providerId: 'audiosep' | 'sam-audio';
  model: string;
  version: string;
  mode: QueryIsolationBakeoffMode;
  input: Record<string, string | boolean>;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], context: string): void {
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error(`${context} does not match the pinned schema`);
  }
}

function exactJson(value: unknown, expected: unknown, context: string): void {
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(`${context} drifted`);
  }
}

function safeString(value: unknown, pattern: RegExp, context: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${context} is invalid`);
  return value;
}

function validateHttpsSourceUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('evaluation source URL is invalid');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    !parsed.hostname
  ) {
    throw new Error('evaluation source URL must be credential-free HTTPS');
  }
  return parsed.toString();
}

export function samAudioEvaluationContractSurface(): {
  purpose: 'evaluation-only';
  model: typeof SAM_AUDIO_REPLICATE_MODEL;
  reviewedVersion: typeof SAM_AUDIO_REPLICATE_VERSION;
  inputKeys: readonly string[];
  requiredInputKeys: readonly ['audio'];
  output: 'uri-array';
  outputRoles: readonly ['target', 'residual'];
  officialRepositoryCommit: typeof SAM_AUDIO_OFFICIAL_REPOSITORY_COMMIT;
  officialLicenseSha256: typeof SAM_AUDIO_OFFICIAL_LICENSE_SHA256;
  huggingFaceRepositoryCommit: typeof SAM_AUDIO_HUGGING_FACE_REPOSITORY_COMMIT;
  communityWrapperCommit: typeof SAM_AUDIO_COMMUNITY_WRAPPER_COMMIT;
  checkpointSha256: null;
  institutionalLicenseApproval: false;
  hostedWrapperBinding: 'unverified';
} {
  return Object.freeze({
    purpose: 'evaluation-only',
    model: SAM_AUDIO_REPLICATE_MODEL,
    reviewedVersion: SAM_AUDIO_REPLICATE_VERSION,
    inputKeys: Object.freeze([
      'audio',
      'description',
      'span_anchors',
      'predict_spans',
      'output_residual',
      'use_span_prompting',
    ]),
    requiredInputKeys: Object.freeze(['audio'] as const),
    output: 'uri-array',
    outputRoles: Object.freeze(['target', 'residual'] as const),
    officialRepositoryCommit: SAM_AUDIO_OFFICIAL_REPOSITORY_COMMIT,
    officialLicenseSha256: SAM_AUDIO_OFFICIAL_LICENSE_SHA256,
    huggingFaceRepositoryCommit: SAM_AUDIO_HUGGING_FACE_REPOSITORY_COMMIT,
    communityWrapperCommit: SAM_AUDIO_COMMUNITY_WRAPPER_COMMIT,
    checkpointSha256: null,
    institutionalLicenseApproval: false,
    hostedWrapperBinding: 'unverified',
  });
}

const EXPECTED_SOURCE_BINDINGS = {
  objective: {
    manifestPath: INSTRUMENT_CONTROL_MANIFEST_PATH,
    version: INSTRUMENT_CONTROL_VERSION,
    license: 'CC BY 4.0',
    reviewStatus: INSTRUMENT_CONTROL_REVIEW_STATUS,
  },
  subjective: {
    manifestPath: CORE_CORPUS_PATH,
    expectationPath: AUTO_EXPECTATIONS_PATH,
    classifierVersion: 'autosplit-role-v4',
    identityPolicy: 'content-sha256-required',
  },
};

const EXPECTED_PROVIDERS = [
  {
    id: 'audiosep',
    disposition: 'dormant-contract-only',
    provider: 'replicate',
    model: 'cjwbw/audiosep',
    version: 'f07004438b8f3e6c5b720ba889389007cbf8dbbc9caa124afc24d9bbd2d307b8',
    contractVersion: 'audiosep-replicate-v1',
    outputRoles: ['target'],
    blockers: [
      'hosted-checkpoint-hash-unresolved',
      'hosted-weight-license-unresolved',
      'semester-budget-missing',
      'provider-route-disabled',
    ],
  },
  {
    id: 'sam-audio',
    disposition: 'evaluation-only-license-blocked',
    provider: 'replicate',
    model: SAM_AUDIO_REPLICATE_MODEL,
    version: SAM_AUDIO_REPLICATE_VERSION,
    contractVersion: 'sam-audio-replicate-eval-v1',
    officialRepositoryCommit: SAM_AUDIO_OFFICIAL_REPOSITORY_COMMIT,
    officialLicenseSha256: SAM_AUDIO_OFFICIAL_LICENSE_SHA256,
    huggingFaceModel: 'facebook/sam-audio-large',
    huggingFaceRepositoryCommit: SAM_AUDIO_HUGGING_FACE_REPOSITORY_COMMIT,
    communityWrapperRepository: 'geopti/cog-sam-audio',
    communityWrapperCommit: SAM_AUDIO_COMMUNITY_WRAPPER_COMMIT,
    wrapperBinding: 'not-provider-attested',
    outputRoles: ['target', 'residual'],
    blockers: [
      'institutional-sam-license-approval-missing',
      'gated-checkpoint-sha256-unavailable',
      'community-image-checkpoint-binding-unverified',
      'community-wrapper-dependencies-floating',
      'application-adapter-forbidden',
    ],
  },
];

const EXPECTED_FIXTURE_POLICY: QueryIsolationFixturePolicy = {
  sampleRate: 32000,
  channels: 1,
  durationSeconds: 24,
  targetGain: 0.25,
  interfererGain: 0.25,
  positiveSpan: [6, 18],
  negativeSpans: [[0, 5], [19, 24]],
  codec: 'pcm-f32le-wav',
  outputDirectory: QUERY_ISOLATION_BAKEOFF_OUTPUT_DIRECTORY,
};

const EXPECTED_METRICS = {
  objective: [
    'si-sdr-improvement-db',
    'target-interference-rejection-db',
    'residual-si-sdr-db',
    'reconstruction-residual-db',
    'span-uplift-db',
    'latency-ms',
    'cost-usd',
    'provider-failure-rate',
  ],
  subjective: [
    'blinded-target-recall',
    'blinded-target-precision',
    'blinded-residual-usefulness',
    'latency-ms',
    'cost-usd',
    'provider-failure-rate',
  ],
  claimStatus: 'none-until-provider-runs-and-teacher-review',
};

function coreCorpusSources(repositoryRoot: string): Map<string, {
  slug: string;
  expectedInstruments: string[];
  contentSha256: string;
}> {
  const value: unknown = JSON.parse(readFileSync(resolve(repositoryRoot, CORE_CORPUS_PATH), 'utf8'));
  if (!record(value) || !Array.isArray(value.sources)) throw new Error('core corpus is invalid');
  const sources = new Map<string, { slug: string; expectedInstruments: string[]; contentSha256: string }>();
  for (const candidate of value.sources) {
    if (!record(candidate) || candidate.kind !== 'file') continue;
    const slug = safeString(candidate.slug, SAFE_ID, 'core corpus slug');
    if (!Array.isArray(candidate.expectedInstruments)) {
      throw new Error(`${slug}: core corpus instruments are invalid`);
    }
    const expectedInstruments = candidate.expectedInstruments.map((instrument) =>
      safeString(instrument, SAFE_ID, `${slug} expected instrument`)
    );
    if (!record(candidate.provenance)) throw new Error(`${slug}: core corpus provenance is missing`);
    const contentSha256 = safeString(
      candidate.provenance.contentSha256,
      SHA256,
      `${slug} corpus SHA-256`
    );
    sources.set(slug, { slug, expectedInstruments, contentSha256 });
  }
  return sources;
}

function validateObjectiveCases(
  value: unknown,
  controls: InstrumentControlManifest
): QueryIsolationObjectiveCase[] {
  if (!Array.isArray(value) || value.length !== controls.controls.length) {
    throw new Error('objective bake-off cases are incomplete');
  }
  const byId = new Map(controls.controls.map((control) => [control.id, control]));
  const cases = value.map((candidate): QueryIsolationObjectiveCase => {
    if (!record(candidate)) throw new Error('objective bake-off case is invalid');
    exactKeys(
      candidate,
      ['id', 'targetControlId', 'interfererControlIds', 'textPrompt', 'modes'],
      'objective bake-off case'
    );
    const id = safeString(candidate.id, SAFE_ID, 'objective case id');
    const targetControlId = safeString(candidate.targetControlId, SAFE_ID, `${id} target control`);
    const target = byId.get(targetControlId);
    if (!target) throw new Error(`${id}: target control is not pinned`);
    if (id !== `${target.pieceCode.toLowerCase()}-${target.instrument}`) {
      throw new Error(`${id}: objective case identity drifted`);
    }
    if (!Array.isArray(candidate.interfererControlIds) || candidate.interfererControlIds.length < 1) {
      throw new Error(`${id}: interferer controls are missing`);
    }
    const interfererControlIds = candidate.interfererControlIds.map((controlId) =>
      safeString(controlId, SAFE_ID, `${id} interferer control`)
    );
    if (
      new Set(interfererControlIds).size !== interfererControlIds.length ||
      interfererControlIds.includes(targetControlId)
    ) {
      throw new Error(`${id}: interferer controls are invalid`);
    }
    for (const controlId of interfererControlIds) {
      const interferer = byId.get(controlId);
      if (!interferer || interferer.pieceId !== target.pieceId) {
        throw new Error(`${id}: objective mix must use synchronized controls from one piece`);
      }
    }
    const textPrompt = safeString(candidate.textPrompt, SAFE_PROMPT, `${id} text prompt`);
    if (textPrompt !== target.instrument.replaceAll('-', ' ')) {
      throw new Error(`${id}: text prompt must name the target control exactly`);
    }
    exactJson(candidate.modes, OBJECTIVE_MODES, `${id} objective modes`);
    return {
      id,
      targetControlId,
      interfererControlIds,
      textPrompt,
      modes: [...OBJECTIVE_MODES],
    };
  });
  const targets = cases.map((candidate) => candidate.targetControlId);
  if (
    new Set(cases.map((candidate) => candidate.id)).size !== cases.length ||
    new Set(targets).size !== controls.controls.length ||
    !controls.controls.every((control) => targets.includes(control.id))
  ) {
    throw new Error('objective bake-off cases do not cover every control exactly once');
  }
  return cases;
}

function validateSubjectiveCases(
  value: unknown,
  repositoryRoot: string
): QueryIsolationSubjectiveCase[] {
  if (!Array.isArray(value) || value.length !== SUBJECTIVE_SOURCE_SLUGS.length) {
    throw new Error('subjective bake-off cases are incomplete');
  }
  const sources = coreCorpusSources(repositoryRoot);
  const cases = value.map((candidate): QueryIsolationSubjectiveCase => {
    if (!record(candidate)) throw new Error('subjective bake-off case is invalid');
    exactKeys(
      candidate,
      ['id', 'sourceSlug', 'textPrompt', 'expectedInstrument', 'modes'],
      'subjective bake-off case'
    );
    const id = safeString(candidate.id, SAFE_ID, 'subjective case id');
    const sourceSlug = safeString(candidate.sourceSlug, SAFE_ID, `${id} source slug`);
    const expectedInstrument = safeString(
      candidate.expectedInstrument,
      SAFE_ID,
      `${id} expected instrument`
    );
    const source = sources.get(sourceSlug);
    if (!source || !source.expectedInstruments.includes(expectedInstrument)) {
      throw new Error(`${id}: subjective target is not supported by the pinned source annotation`);
    }
    if (id !== `${sourceSlug}-${expectedInstrument}`) {
      throw new Error(`${id}: subjective case identity drifted`);
    }
    const textPrompt = safeString(candidate.textPrompt, SAFE_PROMPT, `${id} text prompt`);
    if (textPrompt !== expectedInstrument.replaceAll('-', ' ')) {
      throw new Error(`${id}: subjective prompt must preserve the reviewed target`);
    }
    exactJson(candidate.modes, SUBJECTIVE_MODES, `${id} subjective modes`);
    return {
      id,
      sourceSlug,
      textPrompt,
      expectedInstrument,
      modes: [...SUBJECTIVE_MODES],
    };
  });
  exactJson(
    cases.map((candidate) => candidate.sourceSlug),
    SUBJECTIVE_SOURCE_SLUGS,
    'subjective source order'
  );
  return cases;
}

export function validateQueryIsolationBakeoffManifest(
  value: unknown,
  repositoryRoot = REPOSITORY_ROOT
): QueryIsolationBakeoffManifest {
  if (!record(value)) throw new Error('query-isolation bake-off manifest is invalid');
  exactKeys(
    value,
    [
      '$schema',
      'version',
      'reviewStatus',
      'sourceBindings',
      'providers',
      'fixturePolicy',
      'objectiveCases',
      'subjectiveCases',
      'metrics',
    ],
    'query-isolation bake-off manifest'
  );
  if (
    value.$schema !== QUERY_ISOLATION_BAKEOFF_SCHEMA ||
    value.version !== QUERY_ISOLATION_BAKEOFF_VERSION ||
    value.reviewStatus !== QUERY_ISOLATION_BAKEOFF_REVIEW_STATUS
  ) {
    throw new Error('query-isolation bake-off identity drifted');
  }
  exactJson(value.sourceBindings, EXPECTED_SOURCE_BINDINGS, 'bake-off source bindings');
  exactJson(value.providers, EXPECTED_PROVIDERS, 'bake-off provider boundary');
  exactJson(value.fixturePolicy, EXPECTED_FIXTURE_POLICY, 'bake-off fixture policy');
  exactJson(value.metrics, EXPECTED_METRICS, 'bake-off metric policy');
  const controls = loadInstrumentControlManifest(repositoryRoot);
  const objectiveCases = validateObjectiveCases(value.objectiveCases, controls);
  const subjectiveCases = validateSubjectiveCases(value.subjectiveCases, repositoryRoot);
  return {
    $schema: QUERY_ISOLATION_BAKEOFF_SCHEMA,
    version: QUERY_ISOLATION_BAKEOFF_VERSION,
    reviewStatus: QUERY_ISOLATION_BAKEOFF_REVIEW_STATUS,
    sourceBindings: EXPECTED_SOURCE_BINDINGS,
    providers: EXPECTED_PROVIDERS,
    fixturePolicy: EXPECTED_FIXTURE_POLICY,
    objectiveCases,
    subjectiveCases,
    metrics: EXPECTED_METRICS,
  };
}

export function loadQueryIsolationBakeoffManifest(
  repositoryRoot = REPOSITORY_ROOT
): QueryIsolationBakeoffManifest {
  const value: unknown = JSON.parse(
    readFileSync(resolve(repositoryRoot, QUERY_ISOLATION_BAKEOFF_MANIFEST_PATH), 'utf8')
  );
  return validateQueryIsolationBakeoffManifest(value, repositoryRoot);
}

export function buildQueryIsolationEvaluationInput(
  manifest: QueryIsolationBakeoffManifest,
  candidate: QueryIsolationObjectiveCase | QueryIsolationSubjectiveCase,
  mode: QueryIsolationBakeoffMode,
  sourceUrl: string
): QueryIsolationEvaluationInput {
  if (!(candidate.modes as readonly QueryIsolationBakeoffMode[]).includes(mode)) {
    throw new Error(`${candidate.id}: evaluation mode is not allowed`);
  }
  const audio = validateHttpsSourceUrl(sourceUrl);
  if (mode === 'audiosep-text') {
    return {
      purpose: 'evaluation-only',
      providerId: 'audiosep',
      model: 'cjwbw/audiosep',
      version: EXPECTED_PROVIDERS[0].version,
      mode,
      input: { audio_file: audio, text: candidate.textPrompt },
    };
  }
  const spanAnchors = [
    ['+', ...manifest.fixturePolicy.positiveSpan],
    ...manifest.fixturePolicy.negativeSpans.map((span) => ['-', ...span]),
  ];
  return {
    purpose: 'evaluation-only',
    providerId: 'sam-audio',
    model: SAM_AUDIO_REPLICATE_MODEL,
    version: SAM_AUDIO_REPLICATE_VERSION,
    mode,
    input: {
      audio,
      description: candidate.textPrompt,
      use_span_prompting: mode === 'sam-audio-span',
      span_anchors: mode === 'sam-audio-span' ? JSON.stringify(spanAnchors) : '[]',
      predict_spans: false,
      output_residual: true,
    },
  };
}

export function assertQueryIsolationOutputDuration(
  durationSeconds: number,
  expectedDurationSeconds: number
): void {
  if (
    !Number.isFinite(durationSeconds) ||
    !Number.isFinite(expectedDurationSeconds) ||
    expectedDurationSeconds <= 0 ||
    Math.abs(durationSeconds - expectedDurationSeconds) >
      QUERY_ISOLATION_OUTPUT_DURATION_TOLERANCE_SECONDS
  ) {
    throw new Error(
      `provider output must preserve the ${expectedDurationSeconds}-second evaluation fixture`
    );
  }
}

function finiteSamples(value: Float32Array, context: string): void {
  if (!value.length) throw new Error(`${context} has no samples`);
  for (const sample of value) {
    if (!Number.isFinite(sample)) throw new Error(`${context} contains non-finite audio`);
  }
}

function centered(value: Float32Array, length: number): Float64Array {
  let mean = 0;
  for (let index = 0; index < length; index += 1) mean += value[index];
  mean /= length;
  const result = new Float64Array(length);
  for (let index = 0; index < length; index += 1) result[index] = value[index] - mean;
  return result;
}

export function scaleInvariantSdrDb(reference: Float32Array, estimate: Float32Array): number {
  finiteSamples(reference, 'reference');
  finiteSamples(estimate, 'estimate');
  const length = Math.min(reference.length, estimate.length);
  if (length < 32) throw new Error('SI-SDR requires at least 32 aligned samples');
  const target = centered(reference, length);
  const output = centered(estimate, length);
  let dot = 0;
  let targetEnergy = 0;
  for (let index = 0; index < length; index += 1) {
    dot += output[index] * target[index];
    targetEnergy += target[index] * target[index];
  }
  if (targetEnergy <= Number.EPSILON) throw new Error('SI-SDR reference is silent');
  const scale = dot / targetEnergy;
  let projectionEnergy = 0;
  let errorEnergy = 0;
  for (let index = 0; index < length; index += 1) {
    const projected = scale * target[index];
    const error = output[index] - projected;
    projectionEnergy += projected * projected;
    errorEnergy += error * error;
  }
  if (projectionEnergy <= Number.EPSILON) return -120;
  if (errorEnergy <= Number.EPSILON) return 120;
  return Math.max(-120, Math.min(120, 10 * Math.log10(projectionEnergy / errorEnergy)));
}

export function reconstructionResidualDb(
  mixture: Float32Array,
  target: Float32Array,
  residual: Float32Array
): number {
  finiteSamples(mixture, 'mixture');
  finiteSamples(target, 'target');
  finiteSamples(residual, 'residual');
  const length = Math.min(mixture.length, target.length, residual.length);
  if (length < 32) throw new Error('reconstruction requires at least 32 aligned samples');
  let sourceEnergy = 0;
  let errorEnergy = 0;
  for (let index = 0; index < length; index += 1) {
    sourceEnergy += mixture[index] * mixture[index];
    const error = mixture[index] - target[index] - residual[index];
    errorEnergy += error * error;
  }
  if (sourceEnergy <= Number.EPSILON) throw new Error('reconstruction mixture is silent');
  if (errorEnergy <= Number.EPSILON) return -120;
  return Math.max(-120, Math.min(120, 10 * Math.log10(errorEnergy / sourceEnergy)));
}

function activeBounds(samples: Float32Array): [number, number] {
  let start = 0;
  while (start < samples.length && Math.abs(samples[start]) <= 1e-7) start += 1;
  let end = samples.length;
  while (end > start && Math.abs(samples[end - 1]) <= 1e-7) end -= 1;
  return [start, end];
}

/** Find the estimate delay without letting silence dominate correlation. */
export function bestQueryIsolationLag(
  reference: Float32Array,
  estimate: Float32Array,
  sampleRate: number,
  maximumLagSeconds = 0.25
): number {
  finiteSamples(reference, 'alignment reference');
  finiteSamples(estimate, 'alignment estimate');
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new Error('alignment sample rate is invalid');
  }
  const [activeStart, activeEnd] = activeBounds(reference);
  if (activeEnd - activeStart < 32) throw new Error('alignment reference has no usable signal');
  const requestedMaximumLag = Math.floor(sampleRate * maximumLagSeconds);
  const maximumWindow = sampleRate * 12;
  const centre = Math.floor((activeStart + activeEnd) / 2);
  const windowStart = Math.max(activeStart, centre - Math.floor(maximumWindow / 2));
  const windowEnd = Math.min(activeEnd, windowStart + maximumWindow);
  // Never let a short overlap win merely because its normalized correlation is
  // based on a tiny fragment of the reference.
  const maximumLag = Math.max(
    0,
    Math.min(
      requestedMaximumLag,
      Math.floor((windowEnd - windowStart) / 4),
      estimate.length - 32
    )
  );

  const squaredEnergyPrefix = (samples: Float32Array): Float64Array => {
    const prefix = new Float64Array(samples.length + 1);
    for (let index = 0; index < samples.length; index += 1) {
      prefix[index + 1] = prefix[index] + samples[index] * samples[index];
    }
    return prefix;
  };
  const referenceEnergyPrefix = squaredEnergyPrefix(reference);
  const estimateEnergyPrefix = squaredEnergyPrefix(estimate);
  const envelopeCorrelation = (lag: number): number => {
    const blockSize = 32;
    let count = 0;
    let sourceSum = 0;
    let outputSum = 0;
    let sourceSquares = 0;
    let outputSquares = 0;
    let dot = 0;
    for (let index = windowStart; index < windowEnd; index += blockSize) {
      const outputStart = index + lag;
      const width = Math.min(blockSize, windowEnd - index, estimate.length - outputStart);
      if (outputStart < 0 || width <= 0) continue;
      const sourceEnvelope = Math.sqrt(
        (referenceEnergyPrefix[index + width] - referenceEnergyPrefix[index]) / width
      );
      const outputEnvelope = Math.sqrt(
        (estimateEnergyPrefix[outputStart + width] - estimateEnergyPrefix[outputStart]) / width
      );
      count += 1;
      sourceSum += sourceEnvelope;
      outputSum += outputEnvelope;
      sourceSquares += sourceEnvelope * sourceEnvelope;
      outputSquares += outputEnvelope * outputEnvelope;
      dot += sourceEnvelope * outputEnvelope;
    }
    if (count < 2) return -1;
    const covariance = dot - (sourceSum * outputSum) / count;
    const sourceVariance = sourceSquares - (sourceSum * sourceSum) / count;
    const outputVariance = outputSquares - (outputSum * outputSum) / count;
    if (sourceVariance <= Number.EPSILON || outputVariance <= Number.EPSILON) return -1;
    return covariance / Math.sqrt(sourceVariance * outputVariance);
  };

  const correlation = (lag: number, stride: number): number => {
    let dot = 0;
    let referenceEnergy = 0;
    let estimateEnergy = 0;
    const start = Math.max(windowStart, -lag);
    const end = Math.min(windowEnd, estimate.length - lag);
    for (let index = start; index < end; index += stride) {
      const source = reference[index];
      const output = estimate[index + lag];
      dot += source * output;
      referenceEnergy += source * source;
      estimateEnergy += output * output;
    }
    if (!referenceEnergy || !estimateEnergy) return -1;
    return dot / Math.sqrt(referenceEnergy * estimateEnergy);
  };

  let bestLag = 0;
  let bestCorrelation = -1;
  for (let lag = -maximumLag; lag <= maximumLag; lag += 32) {
    const candidate = envelopeCorrelation(lag);
    if (candidate > bestCorrelation) {
      bestCorrelation = candidate;
      bestLag = lag;
    }
  }
  const refineStart = Math.max(-maximumLag, bestLag - 48);
  const refineEnd = Math.min(maximumLag, bestLag + 48);
  // The refined pass uses waveform correlation, so its score is not directly
  // comparable to the coarse pass's block-envelope correlation.
  bestCorrelation = -1;
  for (let lag = refineStart; lag <= refineEnd; lag += 1) {
    const candidate = correlation(lag, 4);
    if (candidate > bestCorrelation) {
      bestCorrelation = candidate;
      bestLag = lag;
    }
  }
  return bestLag;
}

function alignedPair(
  reference: Float32Array,
  estimate: Float32Array,
  lag: number
): [Float32Array, Float32Array] {
  const referenceStart = Math.max(0, -lag);
  const estimateStart = Math.max(0, lag);
  const length = Math.min(reference.length - referenceStart, estimate.length - estimateStart);
  if (length < 32) throw new Error('aligned output is too short');
  return [
    reference.subarray(referenceStart, referenceStart + length),
    estimate.subarray(estimateStart, estimateStart + length),
  ];
}

export function targetInterferenceRejectionDb(
  targetReference: Float32Array,
  interferenceReference: Float32Array,
  estimate: Float32Array
): number {
  finiteSamples(targetReference, 'target reference');
  finiteSamples(interferenceReference, 'interference reference');
  finiteSamples(estimate, 'target estimate');
  const length = Math.min(targetReference.length, interferenceReference.length, estimate.length);
  if (length < 32) throw new Error('interference rejection requires aligned samples');
  let targetDot = 0;
  let targetEnergy = 0;
  let interferenceDot = 0;
  let interferenceEnergy = 0;
  for (let index = 0; index < length; index += 1) {
    targetDot += estimate[index] * targetReference[index];
    targetEnergy += targetReference[index] * targetReference[index];
    interferenceDot += estimate[index] * interferenceReference[index];
    interferenceEnergy += interferenceReference[index] * interferenceReference[index];
  }
  if (targetEnergy <= Number.EPSILON || interferenceEnergy <= Number.EPSILON) {
    throw new Error('interference rejection references must contain signal');
  }
  const targetProjection = (targetDot * targetDot) / targetEnergy;
  const interferenceProjection = (interferenceDot * interferenceDot) / interferenceEnergy;
  if (targetProjection <= Number.EPSILON) return -120;
  if (interferenceProjection <= Number.EPSILON) return 120;
  return Math.max(-120, Math.min(120, 10 * Math.log10(targetProjection / interferenceProjection)));
}

export interface QueryIsolationObjectiveScore {
  targetLagSamples: number;
  targetSiSdrDb: number;
  mixtureBaselineSiSdrDb: number;
  siSdrImprovementDb: number;
  targetInterferenceRejectionDb: number;
  residualLagSamples: number | null;
  residualSiSdrDb: number | null;
  reconstructionLagSamples: number | null;
  reconstructionResidualDb: number | null;
}

export function scoreQueryIsolationObjectiveOutput(input: {
  sampleRate: number;
  mixture: Float32Array;
  targetReference: Float32Array;
  residualReference: Float32Array;
  targetEstimate: Float32Array;
  residualEstimate?: Float32Array;
}): QueryIsolationObjectiveScore {
  const targetLagSamples = bestQueryIsolationLag(
    input.targetReference,
    input.targetEstimate,
    input.sampleRate
  );
  const [targetReference, targetEstimate] = alignedPair(
    input.targetReference,
    input.targetEstimate,
    targetLagSamples
  );
  const referenceStart = Math.max(0, -targetLagSamples);
  const residualForTarget = input.residualReference.subarray(
    referenceStart,
    referenceStart + targetReference.length
  );
  const targetSiSdrDb = scaleInvariantSdrDb(targetReference, targetEstimate);
  const mixtureBaselineSiSdrDb = scaleInvariantSdrDb(
    input.targetReference,
    input.mixture
  );
  const rejectionDb = targetInterferenceRejectionDb(
    targetReference,
    residualForTarget,
    targetEstimate
  );

  let residualLagSamples: number | null = null;
  let residualSiSdrDb: number | null = null;
  let reconstructionLagSamples: number | null = null;
  let reconstructionDb: number | null = null;
  if (input.residualEstimate) {
    residualLagSamples = bestQueryIsolationLag(
      input.residualReference,
      input.residualEstimate,
      input.sampleRate
    );
    const [residualReference, residualEstimate] = alignedPair(
      input.residualReference,
      input.residualEstimate,
      residualLagSamples
    );
    residualSiSdrDb = scaleInvariantSdrDb(residualReference, residualEstimate);

    const estimateLength = Math.min(input.targetEstimate.length, input.residualEstimate.length);
    const sum = new Float32Array(estimateLength);
    for (let index = 0; index < estimateLength; index += 1) {
      sum[index] = input.targetEstimate[index] + input.residualEstimate[index];
    }
    reconstructionLagSamples = bestQueryIsolationLag(input.mixture, sum, input.sampleRate);
    const [mixture, alignedSum] = alignedPair(input.mixture, sum, reconstructionLagSamples);
    reconstructionDb = reconstructionResidualDb(
      mixture,
      alignedSum,
      new Float32Array(alignedSum.length)
    );
  }
  return {
    targetLagSamples,
    targetSiSdrDb,
    mixtureBaselineSiSdrDb,
    siSdrImprovementDb: targetSiSdrDb - mixtureBaselineSiSdrDb,
    targetInterferenceRejectionDb: rejectionDb,
    residualLagSamples,
    residualSiSdrDb,
    reconstructionLagSamples,
    reconstructionResidualDb: reconstructionDb,
  };
}
