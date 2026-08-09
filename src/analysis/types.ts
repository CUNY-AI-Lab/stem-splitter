import type { SeparationOptionSummary } from '../separation/options';

export const AUDIO_ANALYSIS_SCHEMA_VERSION = '1' as const;
export const AUTO_ROUTING_SCHEMA_VERSION = '1' as const;
export const AUTO_ROUTING_REQUEST = 'auto' as const;
export const PINNED_ROLE_CLASSIFIER_VERSION = 'autosplit-role-v3' as const;
export const INSTRUMENT_DISCOVERY_SCHEMA_VERSION = '1' as const;
export const PINNED_INSTRUMENT_CLASSIFIER_VERSION =
  'laion-larger-clap-music-pairwise-presence-rand-trunc-v1@a0b4534a14f58e20944452dff00a22a06ce629d1' as const;
export const PINNED_INSTRUMENT_MODEL_SHA256 =
  '5c289311f4a030d768af7ffbfdecd01b008aa64824211899a4e59f4f9d154fd1' as const;
export const PINNED_INSTRUMENT_VOCABULARY_VERSION = 'classroom-instruments-v1' as const;
export const PINNED_INSTRUMENT_VOCABULARY_SHA256 =
  '72b7ab09cc188bf5cb8b47acf55145c45703cd4368e94c372cce8130f96ba140' as const;
export const MAX_ANALYSIS_SECONDS = 45;
export const MAX_DISCOVERY_WINDOWS = 3;
export const MAX_DISCOVERY_WINDOW_SECONDS = 15;
export const INSTRUMENT_DISCOVERY_SAMPLE_RATE = 22_050;

export type AudioSourceType = 'upload' | 'youtube' | 'archive';
export type CoreSplitChoice = 'two' | 'four' | 'six';
export type CoreModelContract = Pick<SeparationOptionSummary, 'id' | 'stems'>;

/** Scalar role features from the existing bounded AutoSplit classifier. */
export interface RoleFeaturesV1 {
  onsetsPerSecond: number;
  pitchedAttacksPerSecond: number;
  sustainedLow: number;
  percussiveHigh: number;
  silent: boolean;
}

export interface InstrumentDetectionV1 {
  id: string;
  label: string;
  confidence: number;
  state: 'possible' | 'uncertain';
  windowSupport: number;
  windowsAnalyzed: number;
}

export type InstrumentDiscoveryCode =
  | 'discovery_unconfigured'
  | 'discovery_timeout'
  | 'discovery_unavailable'
  | 'discovery_contract_invalid';

export interface InstrumentDiscoveryTraceV1 {
  status: 'complete' | 'unavailable';
  code: InstrumentDiscoveryCode | null;
  totalMs: number;
  windowsAnalyzed: number;
}

/** Private discovery-service response before it is merged into analysis v1. */
export interface InstrumentDiscoveryResultV1 {
  schemaVersion: typeof INSTRUMENT_DISCOVERY_SCHEMA_VERSION;
  classifier: {
    version: typeof PINNED_INSTRUMENT_CLASSIFIER_VERSION;
    weightsSha256: typeof PINNED_INSTRUMENT_MODEL_SHA256;
  };
  vocabularyVersion: typeof PINNED_INSTRUMENT_VOCABULARY_VERSION;
  vocabularySha256: typeof PINNED_INSTRUMENT_VOCABULARY_SHA256;
  detections: InstrumentDetectionV1[];
  windowsAnalyzed: number;
  timingMs: number;
}

export type AnalysisDegradedCode =
  | 'analysis_unconfigured'
  | 'analysis_timeout'
  | 'analysis_unavailable'
  | 'analysis_contract_invalid'
  | 'analysis_model_unsupported'
  | 'audio_unsupported';

/**
 * Wire contract returned by the private audio-analysis service.
 *
 * Instrument detections are advisory. `resolvedCoreModel` must still name one
 * of the app-provided core contracts; a detected label can never become a stem.
 */
export interface AudioAnalysisResultV1 {
  schemaVersion: typeof AUDIO_ANALYSIS_SCHEMA_VERSION;
  roleClassifier: {
    version: typeof PINNED_ROLE_CLASSIFIER_VERSION | 'not-run';
  };
  vocabularyClassifier?: {
    version: typeof PINNED_INSTRUMENT_CLASSIFIER_VERSION;
    weightsSha256: typeof PINNED_INSTRUMENT_MODEL_SHA256;
    vocabularyVersion: typeof PINNED_INSTRUMENT_VOCABULARY_VERSION;
    vocabularySha256: typeof PINNED_INSTRUMENT_VOCABULARY_SHA256;
  };
  instrumentDiscovery?: InstrumentDiscoveryTraceV1;
  decision: {
    choice: CoreSplitChoice | 'fallback';
    resolvedCoreModel: string;
    confidence: number | null;
    features: RoleFeaturesV1 | null;
    reason: string;
  };
  detectedInstruments: InstrumentDetectionV1[];
  timing: {
    totalMs: number;
    analyzedSeconds: number | null;
  };
  degraded: {
    active: boolean;
    code: AnalysisDegradedCode | null;
  };
}

export interface AudioAnalysisRequestV1 {
  schemaVersion: typeof AUDIO_ANALYSIS_SCHEMA_VERSION;
  sourceUrl: string;
  sourceType: AudioSourceType;
  coreModels: CoreModelContract[];
  fallbackModel: string;
  instrumentDiscovery: boolean;
}

export interface AudioAnalysisProvider {
  analyze(request: AudioAnalysisRequestV1, signal?: AbortSignal): Promise<unknown>;
}

/** Small comparison payload from the browser; raw PCM and feature arrays stay out. */
export interface BrowserAutoSummaryV1 {
  classifierVersion: typeof PINNED_ROLE_CLASSIFIER_VERSION;
  choice: CoreSplitChoice;
  resolvedCoreModel: string;
  reason: string;
}

/** App-owned persisted decision. `resolvedCoreModel` is what the separator ran. */
export interface AutoRoutingDecisionV1 {
  schemaVersion: typeof AUTO_ROUTING_SCHEMA_VERSION;
  routingRequest: typeof AUTO_ROUTING_REQUEST;
  sourceType: AudioSourceType;
  mode: 'shadow' | 'authoritative';
  applied: boolean;
  fallbackModel: string;
  resolvedCoreModel: string;
  analysis: AudioAnalysisResultV1;
  browserAnalysis?: BrowserAutoSummaryV1;
  comparison: 'agree' | 'disagree' | 'unavailable';
}
