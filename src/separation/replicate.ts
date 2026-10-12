import type { Env } from '../env';
import { DEFAULT_DEMUCS_MODEL, getReplicateRunner, replicateVersion } from './options';
import type { SeparationBackend, SeparationResult, SeparationStartRequest } from './types';
import { readBoundedResponse } from '../http/bounded-response.ts';
import { retryAt, UpstreamError } from '../reliability/retry.ts';

// Replicate-hosted Demucs (ryan5453/demucs), running the htdemucs_ft
// fine-tuned model with MP3 output. Cost depends on the deployed pin/hardware.
//
// REPLICATE_MODEL_VERSION must be set to an exact, reviewed version hash:
//   curl -s https://api.replicate.com/v1/models/ryan5453/demucs \
//     -H "Authorization: Bearer $REPLICATE_API_TOKEN" | jq -r .latest_version.id

interface ReplicatePrediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: Record<string, string | null>;
  error?: unknown;
  webhook?: string;
  version?: string;
}

const API = 'https://api.replicate.com/v1';

/** Cancel only a known prediction, then require an authoritative terminal read.
 * An acknowledgement, timeout, malformed response or 404 never releases quota.
 * No create/retry operation is hidden in this helper. */
export async function cancelReplicatePrediction(env: Env, externalId: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(externalId)) throw new Error('Invalid prediction identifier');
  const url = `${API}/predictions/${externalId}`;
  const headers = { Authorization: `Bearer ${env.REPLICATE_API_TOKEN}` };
  const terminal = async () => {
    let response: Response;
    try { response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(10000) }); }
    catch { throw new UpstreamError('provider_cancel_uncertain', 'uncertain'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new UpstreamError('provider_cancel_unavailable', 'uncertain', response.status,
        response.status === 429 ? retryAt(response.headers.get('retry-after')) : 0);
    }
    const prediction = await predictionJson(response);
    if (prediction.id !== externalId || !['starting','processing','succeeded','failed','canceled'].includes(prediction.status)) {
      throw new UpstreamError('provider_cancel_identity', 'uncertain');
    }
    return ['succeeded','failed','canceled'].includes(prediction.status);
  };
  // A completion that beat cancellation needs no cancel POST or output download.
  if (await terminal()) return true;
  let response: Response;
  try { response = await fetch(`${url}/cancel`, { method: 'POST', headers,
    redirect: 'manual', signal: AbortSignal.timeout(10000) }); }
  catch { throw new UpstreamError('provider_cancel_uncertain', 'uncertain'); }
  await response.body?.cancel().catch(() => undefined);
  // Conflict/validation refusal may mean completion won the race. Verify it.
  if (!response.ok && response.status !== 409 && response.status !== 422) {
    throw new UpstreamError('provider_cancel_unavailable', 'uncertain', response.status,
      response.status === 429 ? retryAt(response.headers.get('retry-after')) : 0);
  }
  return terminal();
}

async function predictionJson(response: Response): Promise<ReplicatePrediction> {
  const data = await readBoundedResponse(response, {
    maximumBytes: 2 * 1024 * 1024, timeoutMs: 20000,
    errors: { tooLarge: () => new Error('Separator response exceeded its limit'),
      timedOut: () => new Error('Separator response timed out'), unreadable: () => new Error('Separator response could not be read') },
  });
  return JSON.parse(new TextDecoder().decode(data));
}

export function replicateBackend(env: Env): SeparationBackend {
  const headers = {
    Authorization: `Bearer ${env.REPLICATE_API_TOKEN}`,
    'Content-Type': 'application/json',
  };

  const backend: SeparationBackend = {
    async start(req: SeparationStartRequest): Promise<{ externalId: string }> {
      // The catalogue owns the version and the input shape; this backend only
      // knows how to talk to Replicate. Adding a choice never edits this file.
      const model = req.model ?? DEFAULT_DEMUCS_MODEL;
      const runner = getReplicateRunner(model);
      if (!runner) {
        throw new Error(`No Replicate runner is configured for the "${model}" choice`);
      }
      const version = replicateVersion(env, runner);
      if (!version) {
        throw new Error(`${runner.versionVar} is not configured`);
      }
      let res: Response;
      try { res = await fetch(`${API}/predictions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          version,
          input: { audio: req.audioUrl, ...runner.input() },
          webhook: req.webhookUrl,
          webhook_events_filter: ['completed'],
        }),
        redirect: 'manual', signal: AbortSignal.timeout(30000),
      }); } catch { throw new UpstreamError('start_uncertain','uncertain'); }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new UpstreamError(res.status === 429 ? 'provider_capacity' : res.status === 402 ? 'provider_credit' : 'provider_rejected',
          res.status >= 500 ? 'uncertain' : 'rejected',res.status,res.status === 429 ? retryAt(res.headers.get('retry-after')) : 0);
      }
      let prediction: ReplicatePrediction;
      try { prediction = await predictionJson(res); } catch { throw new UpstreamError('start_response_unreadable','uncertain'); }
      if (typeof prediction.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(prediction.id)) throw new UpstreamError('start_id_missing','uncertain');
      return { externalId: prediction.id };
    },

    parseResult(payload: unknown): SeparationResult {
      const p = payload as ReplicatePrediction;
      if (p.status === 'succeeded') {
        const stems = Object.entries(p.output ?? {})
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
          .map(([name, url]) => ({ name, url }));
        return { status: 'succeeded', stems };
      }
      if (p.status === 'failed' || p.status === 'canceled') {
        return { status: 'failed', error: 'The separator could not complete this track. Please try again.' };
      }
      return { status: 'processing' };
    },

    async fetchStatus(externalId: string): Promise<SeparationResult> {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(externalId)) throw new Error('Invalid prediction identifier');
      const res = await fetch(`${API}/predictions/${externalId}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new UpstreamError('provider_poll_unavailable','uncertain',res.status,res.status===429?retryAt(res.headers.get('retry-after')):0);
      }
      const prediction=await predictionJson(res);
      if(prediction.id!==externalId)throw new UpstreamError('provider_poll_identity','uncertain');
      return backend.parseResult(prediction);
    },

    async confirmStart(externalId: string, webhookUrl: string, version: string): Promise<boolean> {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(externalId)) return false;
      const res=await fetch(`${API}/predictions/${externalId}`,{headers,redirect:'manual',signal:AbortSignal.timeout(20000)});
      if (!res.ok) { await res.body?.cancel();if(res.status===429)throw new UpstreamError('provider_poll_unavailable','uncertain',429,retryAt(res.headers.get('retry-after'))); return false; }
      const prediction=await predictionJson(res);
      return prediction.id===externalId && prediction.webhook===webhookUrl && prediction.version===version;
    },
  };

  return backend;
}
