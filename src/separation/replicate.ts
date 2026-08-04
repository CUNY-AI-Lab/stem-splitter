import type { Env } from '../env';
import { DEFAULT_DEMUCS_MODEL, getReplicateRunner, replicateVersion } from './options';
import type { SeparationBackend, SeparationResult, SeparationStartRequest } from './types';

// Replicate-hosted Demucs (ryan5453/demucs), running the htdemucs_ft
// fine-tuned model with MP3 output. ~$0.04–0.05/song on A40.
//
// REPLICATE_MODEL_VERSION must be set to the model's latest version hash:
//   curl -s https://api.replicate.com/v1/models/ryan5453/demucs \
//     -H "Authorization: Bearer $REPLICATE_API_TOKEN" | jq -r .latest_version.id

interface ReplicatePrediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: Record<string, string | null>;
  error?: unknown;
}

const API = 'https://api.replicate.com/v1';

export function replicateBackend(env: Env): SeparationBackend {
  const headers = {
    Authorization: `Bearer ${env.REPLICATE_API_TOKEN}`,
    'Content-Type': 'application/json',
  };

  // Low-credit accounts get "burst of 1" rate limits; a YouTube import makes
  // two predictions back-to-back (fetch, then separate), so honor 429s.
  const fetchRetrying429 = async (url: string, init: RequestInit): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, init);
      if (res.status !== 429 || attempt >= 3) return res;
      const retryAfter = Number(res.headers.get('retry-after')) || 5;
      await new Promise((r) => setTimeout(r, Math.min(retryAfter + 1, 15) * 1000));
    }
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
      const res = await fetchRetrying429(`${API}/predictions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          version,
          input: { audio: req.audioUrl, ...runner.input() },
          webhook: req.webhookUrl,
          webhook_events_filter: ['completed'],
        }),
      });
      if (!res.ok) {
        throw new Error(`Replicate start failed (${res.status}): ${await res.text()}`);
      }
      const prediction = (await res.json()) as ReplicatePrediction;
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
        return { status: 'failed', error: p.error ? String(p.error) : p.status };
      }
      return { status: 'processing' };
    },

    async fetchStatus(externalId: string): Promise<SeparationResult> {
      const res = await fetch(`${API}/predictions/${externalId}`, { headers });
      if (!res.ok) {
        throw new Error(`Replicate status failed (${res.status}): ${await res.text()}`);
      }
      return backend.parseResult(await res.json());
    },
  };

  return backend;
}
