import type { SeparationOptionSummary } from '../separation/options';

export const AUDIO_ANALYSIS_SCHEMA_VERSION = '1' as const;
export const AUTO_ROUTING_SCHEMA_VERSION = '1' as const;
export const AUTO_ROUTING_REQUEST = 'auto' as const;
export const PINNED_ROLE_CLASSIFIER_VERSION = 'autosplit-role-v3' as const;
export const MAX_ANALYSIS_SECONDS = 45;

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
    version: string;
    vocabularyVersion: string;
  };
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
