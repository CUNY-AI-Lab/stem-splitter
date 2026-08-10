import { AudioAnalysisContractError, parseAudioFingerprintResult } from './contract.ts';
import {
  SOURCE_FINGERPRINT_SCHEMA_VERSION,
  type AudioAnalysisClient,
  type AudioSourceIdentityV1,
  type AudioSourceType,
} from './types.ts';

function boundedTimeout(value: number): number {
  return Number.isFinite(value) ? Math.min(30_000, Math.max(1_000, Math.round(value))) : 15_000;
}

export async function requestSourceFingerprint(input: {
  sourceUrl: string;
  sourceType: AudioSourceType;
  provider: AudioAnalysisClient | null;
  timeoutMs: number;
}): Promise<AudioSourceIdentityV1> {
  if (!input.provider) {
    throw new AudioAnalysisContractError('source fingerprint service is not configured');
  }
  const controller = new AbortController();
  let rejectTimeout: ((reason: Error) => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimeout?.(new Error('source fingerprint timed out'));
  }, boundedTimeout(input.timeoutMs));
  try {
    const wire = await Promise.race([
      input.provider.fingerprint(
        {
          schemaVersion: SOURCE_FINGERPRINT_SCHEMA_VERSION,
          sourceUrl: input.sourceUrl,
          sourceType: input.sourceType,
        },
        controller.signal
      ),
      timeout,
    ]);
    return parseAudioFingerprintResult(wire).source;
  } finally {
    clearTimeout(timer);
  }
}
