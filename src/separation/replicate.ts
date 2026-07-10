import type { Env } from '../env';
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

  const backend: SeparationBackend = {
    async start(req: SeparationStartRequest): Promise<{ externalId: string }> {
      const res = await fetch(`${API}/predictions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          version: env.REPLICATE_MODEL_VERSION,
          input: {
            audio: req.audioUrl,
            model: req.model ?? 'htdemucs_ft',
            output_format: 'mp3',
            mp3_bitrate: 192,
          },
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
