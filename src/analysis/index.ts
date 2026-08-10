import type { Env } from '../env.ts';
import { processingFeatureFlags } from '../features.ts';
import { httpAudioAnalysisProvider } from './http.ts';

export * from './types.ts';
export { resolveAutoRouting, resolveAutoRoutingWithSource } from './routing.ts';
export { redactInstrumentDiscovery } from './redaction.ts';
export { requestSourceFingerprint } from './fingerprint.ts';

export function configuredAudioAnalysisProvider(env: Env) {
  const url = env.AUDIO_ANALYSIS_URL;
  const token = env.AUDIO_ANALYSIS_TOKEN;
  if (!url || !token) return null;
  try {
    return httpAudioAnalysisProvider(url, token);
  } catch {
    // Configuration errors fail closed to the same explicit fallback as a
    // missing service. They must not strand a source or turn every job into 500.
    return null;
  }
}

export function audioAnalysisTimeoutMs(env: Env): number {
  const parsed = Number(env.AUDIO_ANALYSIS_TIMEOUT_MS);
  return Number.isFinite(parsed) ? parsed : 15_000;
}

export function serverAutoCapability(env: Env): { mode: 'shadow' | 'authoritative' } | null {
  const flags = processingFeatureFlags(env);
  return flags.serverAutoMode === 'off' ? null : { mode: flags.serverAutoMode };
}
