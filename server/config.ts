import type { Env } from '../src/env';
import { processingFeatureFlags } from '../src/features';
import { audioAnalysisEndpoint } from '../src/analysis/http';
import { queryIsolationBudgetConfigurationStatus } from '../src/isolation/budget.ts';
import { audioSepReplicateIdentity } from '../src/isolation/options.ts';
import { selfHostedSeparatorStatus } from '../src/separation/self-hosted.ts';

export type OptionalServiceConfigurationStatus =
  | 'unconfigured'
  | 'incomplete'
  | 'invalid'
  | 'configured';

type RuntimeConfig = Pick<
  Env,
  | 'REPLICATE_API_TOKEN'
  | 'SEPARATION_BACKEND'
  | 'AUDIO_SEPARATOR_URL'
  | 'AUDIO_SEPARATOR_TOKEN'
  | 'REPLICATE_MODEL_VERSION'
  | 'REPLICATE_YT_MODEL'
  | 'REPLICATE_YT_MODEL_VERSION'
  | 'AUDIO_ANALYSIS_URL'
  | 'AUDIO_ANALYSIS_TOKEN'
  | 'SERVER_AUTO_ENABLED'
  | 'SERVER_AUTO_MODE'
  | 'INSTRUMENT_DISCOVERY_ENABLED'
  | 'QUERY_ISOLATION_ENABLED'
  | 'QUERY_ISOLATION_MODE'
  | 'REPLICATE_AUDIOSEP_VERSION'
  | 'QUERY_ISOLATION_COURSE_ID'
  | 'QUERY_ISOLATION_SEMESTER_ID'
  | 'QUERY_ISOLATION_MAX_PROVIDER_STARTS'
>;

function enabled(value: string | undefined): boolean {
  return value === 'true';
}

function plausibleReplicateToken(token: string): boolean {
  return token.length >= 20 && token.length <= 512 && /^[^\s\u0000-\u001f\u007f]+$/.test(token);
}

const SEPARATION_BACKENDS = new Set(['replicate', 'audio-separator', 'failover', 'modal']);

/** The configured separation backend name, or `invalid`; never a value from a secret. */
export function separationBackendStatus(env: RuntimeConfig): string {
  const backend = env.SEPARATION_BACKEND ?? 'replicate';
  return SEPARATION_BACKENDS.has(backend) ? backend : 'invalid';
}

/**
 * The self-hosted Audio Separator pair, judged by the same rule failover uses
 * before it sends anything to the service (src/separation/self-hosted.ts).
 */
export function audioSeparatorStatus(env: RuntimeConfig): OptionalServiceConfigurationStatus {
  return selfHostedSeparatorStatus(env);
}

/** The Replicate Demucs pin that `replicate` and the failover fallback both need. */
export function replicateSeparationStatus(
  env: RuntimeConfig
): OptionalServiceConfigurationStatus {
  const token = env.REPLICATE_API_TOKEN ?? '';
  const version = env.REPLICATE_MODEL_VERSION ?? '';
  const count = [token, version].filter(Boolean).length;
  if (count === 0) return 'unconfigured';
  if (count < 2) return 'incomplete';
  if (!/^[0-9a-f]{64}$/.test(version) || !plausibleReplicateToken(token)) return 'invalid';
  return 'configured';
}

export function youtubeImportStatus(env: RuntimeConfig): OptionalServiceConfigurationStatus {
  const model = env.REPLICATE_YT_MODEL ?? '';
  const version = env.REPLICATE_YT_MODEL_VERSION ?? '';
  const token = env.REPLICATE_API_TOKEN ?? '';
  const count = [model, version, token].filter(Boolean).length;
  if (count === 0) return 'unconfigured';
  if (count < 3) return 'incomplete';
  if (model.length > 200 || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(model)) {
    return 'invalid';
  }
  if (!/^[0-9a-f]{64}$/.test(version)) return 'invalid';
  if (
    token.length < 20 ||
    token.length > 512 ||
    !/^[^\s\u0000-\u001f\u007f]+$/.test(token)
  ) return 'invalid';
  return 'configured';
}

export function audioAnalysisStatus(env: RuntimeConfig): OptionalServiceConfigurationStatus {
  const url = env.AUDIO_ANALYSIS_URL ?? '';
  const token = env.AUDIO_ANALYSIS_TOKEN ?? '';
  const count = [url, token].filter(Boolean).length;
  if (count === 0) return 'unconfigured';
  if (count < 2) return 'incomplete';
  if (
    token.length < 32 ||
    token !== token.trim() ||
    /\s|[\u0000-\u001f\u007f]/.test(token)
  ) return 'invalid';
  try {
    audioAnalysisEndpoint(url);
    return 'configured';
  } catch {
    return 'invalid';
  }
}

export function queryIsolationProviderStatus(
  env: RuntimeConfig
): OptionalServiceConfigurationStatus {
  if (!env.REPLICATE_AUDIOSEP_VERSION) return 'unconfigured';
  try {
    audioSepReplicateIdentity(env);
    return 'configured';
  } catch {
    return 'invalid';
  }
}

export function runtimeConfigurationSummary(env: RuntimeConfig) {
  const flags = processingFeatureFlags(env);
  return {
    separationBackend: separationBackendStatus(env),
    audioSeparator: audioSeparatorStatus(env),
    replicateSeparation: replicateSeparationStatus(env),
    youtubeImport: youtubeImportStatus(env),
    audioAnalysis: audioAnalysisStatus(env),
    serverAutoMode: flags.serverAutoMode,
    instrumentDiscovery: flags.instrumentDiscovery ? 'enabled' : 'disabled',
    queryIsolationMode: flags.queryIsolationMode,
    queryIsolationProvider: queryIsolationProviderStatus(env),
    queryIsolationBudget: queryIsolationBudgetConfigurationStatus(env),
  } as const;
}

/** Human-readable, value-free startup warnings for fail-lazy feature gaps. */
export function runtimeConfigurationWarnings(env: RuntimeConfig): string[] {
  const summary = runtimeConfigurationSummary(env);
  const warnings: string[] = [];

  if (summary.separationBackend === 'invalid') {
    warnings.push('SEPARATION_BACKEND is not a known backend; every split will fail to start');
  }
  const usesSelfHosted =
    summary.separationBackend === 'failover' || summary.separationBackend === 'audio-separator';
  if (usesSelfHosted && summary.audioSeparator !== 'configured') {
    warnings.push(
      summary.separationBackend === 'failover'
        ? `self-hosted separator configuration is ${summary.audioSeparator}; failover will send every split to Replicate`
        : `self-hosted separator configuration is ${summary.audioSeparator}; splits will fail to start`
    );
  }
  const usesReplicate =
    summary.separationBackend === 'failover' || summary.separationBackend === 'replicate';
  if (usesReplicate && summary.replicateSeparation !== 'configured') {
    warnings.push(
      `Replicate separation configuration is ${summary.replicateSeparation}; ${
        summary.separationBackend === 'failover'
          ? 'splits the self-hosted separator cannot take will fail'
          : 'splits will fail to start'
      }`
    );
  }

  if (summary.youtubeImport === 'incomplete' || summary.youtubeImport === 'invalid') {
    warnings.push(
      `YouTube Replicate fallback is ${summary.youtubeImport}; it will remain disabled`
    );
  }
  if (summary.audioAnalysis === 'incomplete' || summary.audioAnalysis === 'invalid') {
    warnings.push(`audio analysis configuration is ${summary.audioAnalysis}; it will remain disabled`);
  }
  if (summary.serverAutoMode !== 'off' && summary.audioAnalysis !== 'configured') {
    warnings.push(
      `server Auto is ${summary.serverAutoMode} but audio analysis is ${summary.audioAnalysis}; Auto will use the explicit fallback`
    );
  }
  if (env.SERVER_AUTO_MODE === 'authoritative' && !enabled(env.SERVER_AUTO_ENABLED)) {
    warnings.push('SERVER_AUTO_MODE=authoritative is ignored unless SERVER_AUTO_ENABLED=true');
  }
  if (summary.instrumentDiscovery === 'enabled' && summary.serverAutoMode === 'off') {
    warnings.push('instrument discovery is enabled while server Auto is off; the flag has no effect');
  }
  if (
    env.QUERY_ISOLATION_MODE &&
    env.QUERY_ISOLATION_MODE !== 'shadow' &&
    enabled(env.QUERY_ISOLATION_ENABLED)
  ) {
    warnings.push(
      `QUERY_ISOLATION_MODE=${env.QUERY_ISOLATION_MODE} is invalid; query isolation will remain off`
    );
  }
  if (env.QUERY_ISOLATION_MODE === 'shadow' && !enabled(env.QUERY_ISOLATION_ENABLED)) {
    warnings.push('QUERY_ISOLATION_MODE=shadow is ignored unless QUERY_ISOLATION_ENABLED=true');
  }
  if (summary.queryIsolationMode === 'shadow' && summary.audioAnalysis !== 'configured') {
    warnings.push(
      `query isolation shadow is enabled but audio analysis is ${summary.audioAnalysis}; source fingerprinting will be unavailable`
    );
  }
  if (
    summary.queryIsolationMode === 'shadow' &&
    summary.queryIsolationProvider !== 'configured'
  ) {
    warnings.push(
      `query isolation shadow is enabled but the reviewed provider identity is ${summary.queryIsolationProvider}; requests will remain unavailable`
    );
  }
  if (
    summary.queryIsolationBudget === 'incomplete' ||
    summary.queryIsolationBudget === 'invalid'
  ) {
    warnings.push(
      `query isolation budget configuration is ${summary.queryIsolationBudget}; provider starts will remain unavailable`
    );
  }

  return warnings;
}
