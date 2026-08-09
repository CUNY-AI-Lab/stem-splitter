import {
  AUDIO_ANALYSIS_SCHEMA_VERSION,
  MAX_ANALYSIS_SECONDS,
  PINNED_ROLE_CLASSIFIER_VERSION,
  type AnalysisDegradedCode,
  type AudioAnalysisResultV1,
  type BrowserAutoSummaryV1,
  type CoreModelContract,
  type CoreSplitChoice,
  type InstrumentDetectionV1,
  type RoleFeaturesV1,
} from './types.ts';

export class AudioAnalysisContractError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum;
}

function finiteBetween(value: unknown, minimum: number, maximum: number): value is number {
  return finite(value, minimum) && value <= maximum;
}

function confidence(value: unknown): value is number | null {
  return value === null || (finite(value) && value <= 1);
}

function parseFeatures(value: unknown): RoleFeaturesV1 | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new AudioAnalysisContractError('analysis features are invalid');
  for (const key of ['onsetsPerSecond', 'pitchedAttacksPerSecond'] as const) {
    if (!finiteBetween(value[key], 0, 100)) {
      throw new AudioAnalysisContractError(`analysis feature ${key} is invalid`);
    }
  }
  for (const key of ['sustainedLow', 'percussiveHigh'] as const) {
    if (!finiteBetween(value[key], 0, 1)) {
      throw new AudioAnalysisContractError(`analysis feature ${key} is invalid`);
    }
  }
  if (typeof value.silent !== 'boolean') {
    throw new AudioAnalysisContractError('analysis feature silent is invalid');
  }
  return {
    onsetsPerSecond: value.onsetsPerSecond as number,
    pitchedAttacksPerSecond: value.pitchedAttacksPerSecond as number,
    sustainedLow: value.sustainedLow as number,
    percussiveHigh: value.percussiveHigh as number,
    silent: value.silent,
  };
}

function parseDetections(value: unknown): InstrumentDetectionV1[] {
  if (!Array.isArray(value)) {
    throw new AudioAnalysisContractError('detected instruments are invalid');
  }
  if (value.length > 64) {
    throw new AudioAnalysisContractError('too many instrument detections');
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const id = isRecord(item) && typeof item.id === 'string' ? item.id : '';
    const label = isRecord(item) && typeof item.label === 'string' ? item.label : '';
    if (
      !isRecord(item) ||
      !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(id) ||
      id.length > 64 ||
      !label.trim() ||
      label !== label.trim() ||
      label.length > 120 ||
      /[\u0000-\u001f\u007f]/.test(label) ||
      !confidence(item.confidence) ||
      item.confidence === null
    ) {
      throw new AudioAnalysisContractError('an instrument detection is invalid');
    }
    if (seen.has(id)) {
      throw new AudioAnalysisContractError(`instrument detection ${id} is duplicated`);
    }
    seen.add(id);
    return { id, label, confidence: item.confidence };
  });
}

function pinnedVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    value === value.trim() &&
    value.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    value.toLowerCase() !== 'latest'
  );
}

function boundedReason(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    value === value.trim() &&
    value.length <= 500 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}

const TRACKS_BY_CHOICE: Record<CoreSplitChoice, number> = { two: 2, four: 4, six: 6 };

const CHOICES = new Set<CoreSplitChoice | 'fallback'>(['two', 'four', 'six', 'fallback']);
const DEGRADED_CODES = new Set<AnalysisDegradedCode>([
  'analysis_unconfigured',
  'analysis_timeout',
  'analysis_unavailable',
  'analysis_contract_invalid',
  'analysis_model_unsupported',
  'audio_unsupported',
]);

/** Validate the service boundary before any recommendation may route a paid job. */
export function parseAudioAnalysisResult(
  value: unknown,
  coreModels: readonly CoreModelContract[],
  fallbackModel: string,
  includeInstrumentDiscovery: boolean
): AudioAnalysisResultV1 {
  const modelsById = new Map(coreModels.map((model) => [model.id, model]));
  if (!modelsById.has(fallbackModel)) {
    throw new AudioAnalysisContractError('analysis fallback model is invalid');
  }
  if (!isRecord(value) || value.schemaVersion !== AUDIO_ANALYSIS_SCHEMA_VERSION) {
    throw new AudioAnalysisContractError('unsupported analysis schema version');
  }
  const role = value.roleClassifier;
  const decision = value.decision;
  const timing = value.timing;
  const degraded = value.degraded;
  if (
    !isRecord(role) ||
    (role.version !== PINNED_ROLE_CLASSIFIER_VERSION && role.version !== 'not-run')
  ) {
    throw new AudioAnalysisContractError('role classifier version does not match the app pin');
  }
  if (
    !isRecord(decision) ||
    typeof decision.choice !== 'string' ||
    !CHOICES.has(decision.choice as CoreSplitChoice | 'fallback') ||
    typeof decision.resolvedCoreModel !== 'string' ||
    !modelsById.has(decision.resolvedCoreModel) ||
    !confidence(decision.confidence) ||
    !boundedReason(decision.reason)
  ) {
    throw new AudioAnalysisContractError('analysis decision is invalid');
  }
  if (
    !isRecord(timing) ||
    !finiteBetween(timing.totalMs, 0, 60_000) ||
    !(timing.analyzedSeconds === null ||
      finiteBetween(timing.analyzedSeconds, 0, MAX_ANALYSIS_SECONDS))
  ) {
    throw new AudioAnalysisContractError('analysis timing is invalid');
  }
  if (
    !isRecord(degraded) ||
    typeof degraded.active !== 'boolean' ||
    !(degraded.code === null ||
      (typeof degraded.code === 'string' && DEGRADED_CODES.has(degraded.code as AnalysisDegradedCode))) ||
    (degraded.active && degraded.code === null) ||
    (!degraded.active && degraded.code !== null)
  ) {
    throw new AudioAnalysisContractError('analysis degraded state is invalid');
  }
  if (
    (degraded.active && decision.choice !== 'fallback') ||
    (!degraded.active && decision.choice === 'fallback') ||
    (degraded.active && decision.resolvedCoreModel !== fallbackModel) ||
    (!degraded.active && role.version === 'not-run')
  ) {
    throw new AudioAnalysisContractError('analysis fallback state is inconsistent');
  }

  if (!degraded.active) {
    const choice = decision.choice as CoreSplitChoice;
    const model = modelsById.get(decision.resolvedCoreModel)!;
    if (model.stems.length !== TRACKS_BY_CHOICE[choice]) {
      throw new AudioAnalysisContractError('analysis choice does not match its core model contract');
    }
  }

  let vocabularyClassifier: AudioAnalysisResultV1['vocabularyClassifier'];
  if (includeInstrumentDiscovery && value.vocabularyClassifier !== undefined) {
    const vocabulary = value.vocabularyClassifier;
    if (
      !isRecord(vocabulary) ||
      !pinnedVersion(vocabulary.version) ||
      !pinnedVersion(vocabulary.vocabularyVersion)
    ) {
      throw new AudioAnalysisContractError('vocabulary classifier version is invalid');
    }
    vocabularyClassifier = {
      version: vocabulary.version,
      vocabularyVersion: vocabulary.vocabularyVersion,
    };
  }

  const detectedInstruments = includeInstrumentDiscovery
    ? parseDetections(value.detectedInstruments)
    : [];
  if (detectedInstruments.length && !vocabularyClassifier) {
    throw new AudioAnalysisContractError('instrument detections have no pinned vocabulary classifier');
  }

  return {
    schemaVersion: AUDIO_ANALYSIS_SCHEMA_VERSION,
    roleClassifier: {
      version: role.version as typeof PINNED_ROLE_CLASSIFIER_VERSION | 'not-run',
    },
    ...(vocabularyClassifier ? { vocabularyClassifier } : {}),
    decision: {
      choice: decision.choice as CoreSplitChoice | 'fallback',
      resolvedCoreModel: decision.resolvedCoreModel,
      confidence: decision.confidence as number | null,
      features: parseFeatures(decision.features),
      reason: decision.reason,
    },
    detectedInstruments,
    timing: {
      totalMs: timing.totalMs as number,
      analyzedSeconds: timing.analyzedSeconds as number | null,
    },
    degraded: {
      active: degraded.active,
      code: degraded.code as AnalysisDegradedCode | null,
    },
  };
}

export function parseBrowserAutoSummary(
  value: unknown,
  coreModels: readonly CoreModelContract[]
): BrowserAutoSummaryV1 | undefined {
  if (value === undefined) return undefined;
  const modelsById = new Map(coreModels.map((model) => [model.id, model]));
  if (
    !isRecord(value) ||
    value.classifierVersion !== PINNED_ROLE_CLASSIFIER_VERSION ||
    typeof value.choice !== 'string' ||
    !new Set<CoreSplitChoice>(['two', 'four', 'six']).has(value.choice as CoreSplitChoice) ||
    typeof value.resolvedCoreModel !== 'string' ||
    !modelsById.has(value.resolvedCoreModel) ||
    !boundedReason(value.reason)
  ) {
    throw new AudioAnalysisContractError('browser Auto summary is invalid');
  }
  const choice = value.choice as CoreSplitChoice;
  if (modelsById.get(value.resolvedCoreModel)!.stems.length !== TRACKS_BY_CHOICE[choice]) {
    throw new AudioAnalysisContractError('browser Auto summary choice does not match its model');
  }
  return {
    classifierVersion: PINNED_ROLE_CLASSIFIER_VERSION,
    choice: value.choice as CoreSplitChoice,
    resolvedCoreModel: value.resolvedCoreModel,
    reason: value.reason,
  };
}

export function degradedAnalysis(
  fallbackModel: string,
  code: AnalysisDegradedCode,
  reason: string,
  totalMs: number
): AudioAnalysisResultV1 {
  return {
    schemaVersion: AUDIO_ANALYSIS_SCHEMA_VERSION,
    roleClassifier: { version: 'not-run' },
    decision: {
      choice: 'fallback',
      resolvedCoreModel: fallbackModel,
      confidence: null,
      features: null,
      reason,
    },
    detectedInstruments: [],
    timing: { totalMs, analyzedSeconds: null },
    degraded: { active: true, code },
  };
}
