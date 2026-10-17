import type { Env } from '../env';
import type { SeparationBackend } from './types';
// Explicit .ts specifiers: tests load this module through Node's
// type-stripping runner, which does not resolve extensionless specifiers.
import { replicateBackend } from './replicate.ts';
import { modalBackend } from './modal.ts';
import { audioSeparatorBackend } from './audio-separator.ts';
import { failoverBackend, splitExternalId } from './failover.ts';

export type { SeparationBackend, SeparationResult, StemRef } from './types';

export function getBackend(env: Env): SeparationBackend {
  switch (env.SEPARATION_BACKEND ?? 'replicate') {
    case 'replicate':
      return replicateBackend(env);
    case 'modal':
      return modalBackend(env);
    case 'audio-separator':
      return audioSeparatorBackend(env);
    case 'failover':
      return failoverBackend(env);
    default:
      throw new Error(`Unknown SEPARATION_BACKEND: ${env.SEPARATION_BACKEND}`);
  }
}

/**
 * The backend that owns an existing job, chosen by its stored external id.
 * New jobs start through getBackend(); everything after start (polls and
 * webhooks) comes through here, so a job finishes where it began even when
 * SEPARATION_BACKEND has changed since. Never strip the prefixes in storage.
 */
export function getJobBackend(
  env: Env,
  externalId: string
): { backend: SeparationBackend; providerId: string } {
  const { provider, providerId } = splitExternalId(externalId);
  if (provider === 'audio-separator') return { backend: audioSeparatorBackend(env), providerId };
  if (provider === 'replicate') return { backend: replicateBackend(env), providerId };
  // Unprefixed ids were stored by a single-provider backend before the flip.
  // The self-hosted service issues UUIDs and Replicate prediction ids never
  // contain a dash, so the id's own shape says which provider holds it.
  if (env.SEPARATION_BACKEND === 'failover') {
    return SERVICE_JOB_ID.test(providerId)
      ? { backend: audioSeparatorBackend(env), providerId }
      : { backend: replicateBackend(env), providerId };
  }
  return { backend: getBackend(env), providerId };
}

const SERVICE_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A webhook belongs to the job only when it names the provider id the job
 * stored. A self-hosted start that timed out after the service accepted it
 * falls back to Replicate, and the service's late webhook must not complete
 * (or fail) a job that Replicate now owns.
 */
export function webhookMatchesJob(payload: unknown, providerId: string): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const id = (payload as { id?: unknown }).id;
  return typeof id === 'string' && id === providerId;
}
