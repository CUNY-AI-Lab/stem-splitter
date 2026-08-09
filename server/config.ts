import type { Env } from '../src/env';
import { processingFeatureFlags } from '../src/features';
import { audioAnalysisEndpoint } from '../src/analysis/http';

export type OptionalServiceConfigurationStatus =
  | 'unconfigured'
  | 'incomplete'
  | 'invalid'
  | 'configured';

type RuntimeConfig = Pick<
  Env,
  | 'REPLICATE_API_TOKEN'
  | 'REPLICATE_YT_MODEL'
  | 'REPLICATE_YT_MODEL_VERSION'
  | 'AUDIO_ANALYSIS_URL'
  | 'AUDIO_ANALYSIS_TOKEN'
  | 'SERVER_AUTO_ENABLED'
  | 'SERVER_AUTO_MODE'
  | 'INSTRUMENT_DISCOVERY_ENABLED'
  | 'QUERY_ISOLATION_ENABLED'
>;

function enabled(value: string | undefined): boolean {
  return value === 'true';
}

export function youtubeImportStatus(env: RuntimeConfig): OptionalServiceConfigurationStatus {
  const model = env.REPLICATE_YT_MODEL?.trim() ?? '';
  const version = env.REPLICATE_YT_MODEL_VERSION?.trim() ?? '';
  const token = env.REPLICATE_API_TOKEN?.trim() ?? '';
  const count = [model, version, token].filter(Boolean).length;
  if (count === 0) return 'unconfigured';
  if (count < 3) return 'incomplete';
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(model)) return 'invalid';
  if (version.toLowerCase() === 'latest') return 'invalid';
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

export function runtimeConfigurationSummary(env: RuntimeConfig) {
  const flags = processingFeatureFlags(env);
  return {
    youtubeImport: youtubeImportStatus(env),
    audioAnalysis: audioAnalysisStatus(env),
    serverAutoMode: flags.serverAutoMode,
    instrumentDiscovery: flags.instrumentDiscovery ? 'enabled' : 'disabled',
    queryIsolation: flags.queryIsolation ? 'enabled' : 'disabled',
  } as const;
}

/** Human-readable, value-free startup warnings for fail-lazy feature gaps. */
export function runtimeConfigurationWarnings(env: RuntimeConfig): string[] {
  const summary = runtimeConfigurationSummary(env);
  const warnings: string[] = [];

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

  return warnings;
}
