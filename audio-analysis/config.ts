export const PINNED_FFMPEG_VERSION = '8.0.3';
export const ANALYSIS_SAMPLE_RATE = 22_050;
export const MAX_REQUEST_PHASE_TIMEOUT_MS = 28_000;

const MIB = 1024 * 1024;

export interface AudioAnalysisServiceConfig {
  token: string;
  allowedSourceOrigins: ReadonlySet<string>;
  allowHttpSources: boolean;
  maxSourceBytes: number;
  maxSourceDurationSeconds: number;
  sourceFetchTimeoutMs: number;
  decoderTimeoutMs: number;
  maxConcurrency: number;
  expectedFfmpegVersion: string;
  port: number;
  errors: readonly string[];
}

function boundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  errors: string[]
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    errors.push(`${name} is invalid`);
    return fallback;
  }
  return parsed;
}

function parseOrigins(raw: string | undefined, allowHttp: boolean, errors: string[]): Set<string> {
  const origins = new Set<string>();
  for (const candidate of raw?.split(',') ?? []) {
    const value = candidate.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (
        (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      ) {
        throw new Error('invalid origin');
      }
      origins.add(url.origin);
    } catch {
      errors.push('AUDIO_ANALYSIS_SOURCE_ORIGINS contains an invalid origin');
    }
  }
  if (!origins.size) errors.push('AUDIO_ANALYSIS_SOURCE_ORIGINS is required');
  return origins;
}

export function audioAnalysisConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): AudioAnalysisServiceConfig {
  const errors: string[] = [];
  const token = env.AUDIO_ANALYSIS_TOKEN?.trim() ?? '';
  if (token.length < 32) errors.push('AUDIO_ANALYSIS_TOKEN must contain at least 32 characters');

  const allowHttpSources = env.AUDIO_ANALYSIS_ALLOW_HTTP === 'true';
  const expectedFfmpegVersion =
    env.AUDIO_ANALYSIS_EXPECTED_FFMPEG_VERSION?.trim() || PINNED_FFMPEG_VERSION;
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(expectedFfmpegVersion)) {
    errors.push('AUDIO_ANALYSIS_EXPECTED_FFMPEG_VERSION is invalid');
  }

  const sourceFetchTimeoutMs = boundedInteger(
    env,
    'AUDIO_ANALYSIS_FETCH_TIMEOUT_MS',
    5_000,
    1_000,
    15_000,
    errors
  );
  const decoderTimeoutMs = boundedInteger(
    env,
    'AUDIO_ANALYSIS_DECODER_TIMEOUT_MS',
    8_000,
    1_000,
    30_000,
    errors
  );
  if (sourceFetchTimeoutMs + decoderTimeoutMs > MAX_REQUEST_PHASE_TIMEOUT_MS) {
    errors.push(
      'AUDIO_ANALYSIS_FETCH_TIMEOUT_MS plus AUDIO_ANALYSIS_DECODER_TIMEOUT_MS exceeds the request budget'
    );
  }

  return {
    token,
    allowedSourceOrigins: parseOrigins(
      env.AUDIO_ANALYSIS_SOURCE_ORIGINS,
      allowHttpSources,
      errors
    ),
    allowHttpSources,
    maxSourceBytes: boundedInteger(
      env,
      'AUDIO_ANALYSIS_MAX_SOURCE_BYTES',
      100 * MIB,
      1 * MIB,
      100 * MIB,
      errors
    ),
    maxSourceDurationSeconds: boundedInteger(
      env,
      'AUDIO_ANALYSIS_MAX_SOURCE_SECONDS',
      900,
      1,
      900,
      errors
    ),
    sourceFetchTimeoutMs,
    decoderTimeoutMs,
    maxConcurrency: boundedInteger(
      env,
      'AUDIO_ANALYSIS_MAX_CONCURRENCY',
      1,
      1,
      4,
      errors
    ),
    expectedFfmpegVersion,
    port: boundedInteger(env, 'PORT', 8080, 1, 65_535, errors),
    errors,
  };
}
