import type { Env } from '../env';
// Explicit .ts specifiers: tests load this module through Node's
// type-stripping runner, which does not resolve extensionless specifiers.
import {
  audioSeparatorBackend,
  isAudioSeparatorPayload,
  parseAudioSeparatorResult,
} from './audio-separator.ts';
import { DEFAULT_DEMUCS_MODEL, getAudioSeparatorRunner } from './options.ts';
import { replicateBackend } from './replicate.ts';
import { selfHostedSeparatorStatus } from './self-hosted.ts';
import type { SeparationBackend, SeparationResult, SeparationStartRequest } from './types';

// SEPARATION_BACKEND=failover: the self-hosted Audio Separator service (the
// GPU host in docs/legion-separator.md) runs every split it has a runner for,
// and Replicate runs everything else, including any job the self-hosted
// service refuses, cannot be reached for, or does not answer in time. Students
// see Replicate's catalogue unchanged (options.ts CATALOGUE_ALIASES).
//
// The stored external id records which provider accepted the job. Routing a
// later poll or webhook by that prefix, never by the current setting, keeps
// in-flight jobs reachable across a flip to failover and across a rollback.

export const SELF_HOSTED_PREFIX = 'as:';
export const REPLICATE_PREFIX = 'rep:';

export type JobProvider = 'audio-separator' | 'replicate';

export interface StoredProviderId {
  /** null for an unprefixed id, which predates failover. */
  provider: JobProvider | null;
  providerId: string;
}

const PREFIXES: readonly (readonly [string, JobProvider])[] = [
  [SELF_HOSTED_PREFIX, 'audio-separator'],
  [REPLICATE_PREFIX, 'replicate'],
];

export function splitExternalId(externalId: string): StoredProviderId {
  for (const [prefix, provider] of PREFIXES) {
    if (externalId.startsWith(prefix)) {
      const providerId = externalId.slice(prefix.length);
      if (!providerId) throw new Error('The stored provider id is empty');
      return { provider, providerId };
    }
  }
  return { provider: null, providerId: externalId };
}

/** A short, secret-free reason for the log line that records a fallback. */
function describeStartFailure(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timed out';
    return error.message.replace(/\s+/g, ' ').slice(0, 200) || error.name;
  }
  return String(error).slice(0, 200);
}

export interface FailoverParts {
  primary?: SeparationBackend;
  fallback?: SeparationBackend;
  log?: (message: string) => void;
}

export function failoverBackend(env: Env, parts: FailoverParts = {}): SeparationBackend {
  const primary = parts.primary ?? audioSeparatorBackend(env);
  const fallback = parts.fallback ?? replicateBackend(env);
  const log = parts.log ?? ((message: string) => console.log(message));

  return {
    async start(req: SeparationStartRequest): Promise<{ externalId: string }> {
      const model = req.model ?? DEFAULT_DEMUCS_MODEL;
      // An http:// or weak-token pair would carry the token, a signed source
      // URL and the webhook URL in the clear, so it is never tried at all.
      const configuration = selfHostedSeparatorStatus(env);
      let reason: string | null =
        configuration !== 'configured'
          ? `self-hosted separator ${configuration}`
          : !getAudioSeparatorRunner(model)
            ? `no self-hosted runner for ${model}`
            : null;

      if (!reason) {
        try {
          const { externalId } = await primary.start({ ...req, model });
          return { externalId: `${SELF_HOSTED_PREFIX}${externalId}` };
        } catch (error) {
          reason = describeStartFailure(error);
        }
      }

      log(`[separation] job ${req.jobId} -> Replicate (${reason})`);
      // If Replicate also fails, this throws and the job fails as it always has.
      const { externalId } = await fallback.start({ ...req, model });
      return { externalId: `${REPLICATE_PREFIX}${externalId}` };
    },

    // The app routes webhooks by the stored id (getJobBackend). This shape
    // check only completes the interface for callers holding a bare payload.
    parseResult(payload: unknown): SeparationResult {
      return isAudioSeparatorPayload(payload)
        ? parseAudioSeparatorResult(payload)
        : fallback.parseResult(payload);
    },

    async fetchStatus(externalId: string): Promise<SeparationResult> {
      const { provider, providerId } = splitExternalId(externalId);
      return (provider === 'audio-separator' ? primary : fallback).fetchStatus(providerId);
    },
  };
}
