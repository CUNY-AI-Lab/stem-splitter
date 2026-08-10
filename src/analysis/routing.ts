import {
  AudioAnalysisContractError,
  degradedAnalysis,
  parseAudioAnalysisResult,
  parseAudioSourceIdentity,
} from './contract.ts';
import {
  AUDIO_ANALYSIS_SCHEMA_VERSION,
  AUTO_ROUTING_REQUEST,
  AUTO_ROUTING_SCHEMA_VERSION,
  type AudioAnalysisProvider,
  type AudioSourceIdentityV1,
  type AudioSourceType,
  type AutoRoutingDecisionV1,
  type AutoRoutingResolutionV1,
  type BrowserAutoSummaryV1,
} from './types.ts';
import type { SeparationOptionSummary } from '../separation/options';

export interface ResolveAutoRoutingInput {
  sourceUrl: string;
  sourceType: AudioSourceType;
  mode: 'shadow' | 'authoritative';
  currentModel: string;
  fallbackModel: string;
  coreModels: SeparationOptionSummary[];
  browserAnalysis?: BrowserAutoSummaryV1;
  /** Independent identity for server-fetched imports, calculated before storage. */
  expectedSourceIdentity?: AudioSourceIdentityV1;
  provider: AudioAnalysisProvider | null;
  timeoutMs: number;
  instrumentDiscovery: boolean;
}

function boundedTimeout(value: number): number {
  return Number.isFinite(value) ? Math.min(30_000, Math.max(1_000, Math.round(value))) : 15_000;
}

export async function resolveAutoRoutingWithSource(
  input: ResolveAutoRoutingInput
): Promise<AutoRoutingResolutionV1> {
  const startedAt = Date.now();
  let analysis;
  let sourceIdentity: AudioSourceIdentityV1 | null = null;

  if (!input.provider) {
    analysis = degradedAnalysis(
      input.fallbackModel,
      'analysis_unconfigured',
      'the analysis service is not configured — using the default split',
      Date.now() - startedAt
    );
  } else {
    const controller = new AbortController();
    let timedOut = false;
    let rejectTimeout: ((reason: Error) => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectTimeout?.(new Error('audio analysis timed out'));
    }, boundedTimeout(input.timeoutMs));
    try {
      const wire = await Promise.race([
        input.provider.analyze(
          {
            schemaVersion: AUDIO_ANALYSIS_SCHEMA_VERSION,
            sourceUrl: input.sourceUrl,
            sourceType: input.sourceType,
            coreModels: input.coreModels.map(({ id, stems }) => ({ id, stems: [...stems] })),
            fallbackModel: input.fallbackModel,
            instrumentDiscovery: input.instrumentDiscovery,
          },
          controller.signal
        ),
        timeout,
      ]);
      if (wire && typeof wire === 'object' && !Array.isArray(wire) && 'source' in wire) {
        try {
          sourceIdentity = parseAudioSourceIdentity((wire as { source?: unknown }).source);
        } catch {
          // Without an independent caller fingerprint, malformed identity only
          // disables source caching. Server-fetched imports provide one and
          // therefore fail closed to the default route in the check below.
          sourceIdentity = null;
        }
      }
      analysis = parseAudioAnalysisResult(
        wire,
        input.coreModels,
        input.fallbackModel,
        input.instrumentDiscovery
      );
    } catch (error) {
      // A response that fails the core contract cannot independently authorize
      // private source identity, even when its fingerprint field parsed first.
      sourceIdentity = null;
      const contractInvalid = error instanceof AudioAnalysisContractError || error instanceof SyntaxError;
      analysis = degradedAnalysis(
        input.fallbackModel,
        timedOut
          ? 'analysis_timeout'
          : contractInvalid
            ? 'analysis_contract_invalid'
            : 'analysis_unavailable',
        timedOut
          ? 'audio analysis timed out — using the default split'
          : contractInvalid
            ? 'the analysis result was invalid — using the default split'
            : 'audio analysis was unavailable — using the default split',
        Date.now() - startedAt
      );
    } finally {
      clearTimeout(timer);
    }
  }

  if (
    !analysis.degraded.active &&
    input.expectedSourceIdentity &&
    (!sourceIdentity ||
      sourceIdentity.sha256 !== input.expectedSourceIdentity.sha256 ||
      sourceIdentity.bytes !== input.expectedSourceIdentity.bytes)
  ) {
    sourceIdentity = null;
    analysis = degradedAnalysis(
      input.fallbackModel,
      'source_identity_mismatch',
      'the analyzed source did not match the stored import — using the default split',
      Date.now() - startedAt
    );
  }

  const authoritativeModel = analysis.degraded.active
    ? input.fallbackModel
    : analysis.decision.resolvedCoreModel;
  const resolvedCoreModel = input.mode === 'authoritative' ? authoritativeModel : input.currentModel;
  const browserModel = input.browserAnalysis?.resolvedCoreModel;

  return {
    decision: {
      schemaVersion: AUTO_ROUTING_SCHEMA_VERSION,
      routingRequest: AUTO_ROUTING_REQUEST,
      sourceType: input.sourceType,
      mode: input.mode,
      applied: input.mode === 'authoritative' && !analysis.degraded.active,
      fallbackModel: input.fallbackModel,
      resolvedCoreModel,
      analysis,
      ...(input.browserAnalysis ? { browserAnalysis: input.browserAnalysis } : {}),
      comparison: browserModel && !analysis.degraded.active
        ? browserModel === analysis.decision.resolvedCoreModel
          ? 'agree'
          : 'disagree'
        : 'unavailable',
    },
    sourceIdentity,
  };
}

/** Backward-compatible routing helper for callers that do not need content identity. */
export async function resolveAutoRouting(
  input: ResolveAutoRoutingInput
): Promise<AutoRoutingDecisionV1> {
  return (await resolveAutoRoutingWithSource(input)).decision;
}
