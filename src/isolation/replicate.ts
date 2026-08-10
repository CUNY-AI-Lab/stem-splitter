import type { Env } from '../env';
import { validateQueryIsolationRequest } from './contract.ts';
import { audioSepReplicateIdentity } from './options.ts';
import {
  QUERY_ISOLATION_SCHEMA_VERSION,
  type QueryIsolationProvider,
  type QueryIsolationResultV1,
} from './types.ts';

interface ReplicatePrediction {
  id?: unknown;
  status?: unknown;
  output?: unknown;
}

const API = 'https://api.replicate.com/v1';
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function failed(
  code: 'provider_failed' | 'provider_canceled' | 'invalid_provider_response',
  retryable: boolean,
  message: string
): QueryIsolationResultV1 {
  return {
    schemaVersion: QUERY_ISOLATION_SCHEMA_VERSION,
    status: 'failed',
    failure: { code, retryable, message },
  };
}

function safeReplicateOutputUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const hostAllowed =
      url.hostname === 'replicate.delivery' || url.hostname.endsWith('.replicate.delivery');
    if (url.protocol !== 'https:' || url.username || url.password || !hostAllowed) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Dormant AudioSep adapter. App routes do not construct it until the separate
 * isolation resource, teacher authorization, and cost controls are complete.
 */
export function audioSepReplicateProvider(
  env: Pick<Env, 'REPLICATE_API_TOKEN' | 'REPLICATE_AUDIOSEP_VERSION'>,
  fetchImpl: typeof fetch = fetch
): QueryIsolationProvider {
  const identity = audioSepReplicateIdentity(env);
  const token = env.REPLICATE_API_TOKEN;
  if (!token) throw new Error('REPLICATE_API_TOKEN is not configured');

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const provider: QueryIsolationProvider = {
    identity,

    async start(request) {
      validateQueryIsolationRequest(request);
      const response = await fetchImpl(`${API}/predictions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          version: identity.version,
          input: {
            audio_file: request.sourceUrl,
            text: request.normalizedTarget,
          },
          webhook: request.webhookUrl,
          webhook_events_filter: ['completed'],
        }),
      });
      if (!response.ok) {
        throw new Error(`Replicate isolation start failed (${response.status})`);
      }
      const prediction = (await response.json()) as ReplicatePrediction;
      if (typeof prediction.id !== 'string' || !EXTERNAL_ID_PATTERN.test(prediction.id)) {
        throw new Error('Replicate isolation start returned an invalid prediction id');
      }
      return { externalId: prediction.id, identity };
    },

    parseResult(payload) {
      if (!payload || typeof payload !== 'object') {
        return failed(
          'invalid_provider_response',
          false,
          'The optional isolation provider returned an invalid result.'
        );
      }
      const prediction = payload as ReplicatePrediction;
      if (prediction.status === 'starting' || prediction.status === 'processing') {
        return { schemaVersion: QUERY_ISOLATION_SCHEMA_VERSION, status: 'processing' };
      }
      if (prediction.status === 'succeeded') {
        const targetUrl = safeReplicateOutputUrl(prediction.output);
        if (!targetUrl) {
          return failed(
            'invalid_provider_response',
            false,
            'The optional isolation provider returned an invalid result.'
          );
        }
        return {
          schemaVersion: QUERY_ISOLATION_SCHEMA_VERSION,
          status: 'succeeded',
          targetUrl,
        };
      }
      if (prediction.status === 'canceled') {
        return failed(
          'provider_canceled',
          true,
          'The optional isolation request was canceled.'
        );
      }
      if (prediction.status === 'failed') {
        return failed(
          'provider_failed',
          true,
          'The optional isolation provider could not produce this target.'
        );
      }
      return failed(
        'invalid_provider_response',
        false,
        'The optional isolation provider returned an invalid result.'
      );
    },

    async fetchStatus(externalId) {
      if (!EXTERNAL_ID_PATTERN.test(externalId)) {
        throw new Error('Invalid Replicate isolation prediction id');
      }
      const response = await fetchImpl(`${API}/predictions/${externalId}`, { headers });
      if (!response.ok) {
        throw new Error(`Replicate isolation status failed (${response.status})`);
      }
      return provider.parseResult(await response.json());
    },
  };

  return provider;
}
