import type { Env } from '../env';
// Explicit .ts: tests/separation.test.mts loads this module through Node's
// type-stripping runner, which does not resolve extensionless specifiers.
import { BS_ROFORMER_MODEL, getAudioSeparatorRunner } from './options.ts';
import type { SeparationBackend, SeparationResult, SeparationStartRequest, StemRef } from './types';

interface AudioSeparatorPayload {
  id?: unknown;
  status?: unknown;
  stems?: unknown;
  error?: unknown;
}

function serviceHeaders(env: Env): Headers {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (env.AUDIO_SEPARATOR_TOKEN) {
    headers.set('Authorization', `Bearer ${env.AUDIO_SEPARATOR_TOKEN}`);
  }
  return headers;
}

function serviceUrl(env: Env, path: string): string {
  const base = env.AUDIO_SEPARATOR_URL?.replace(/\/+$/, '');
  if (!base) {
    throw new Error('AUDIO_SEPARATOR_URL is required for the audio-separator backend');
  }
  return `${base}${path}`;
}

async function serviceError(res: Response): Promise<string> {
  const detail = (await res.text()).trim().slice(0, 500);
  return detail ? `: ${detail}` : '';
}

function validStem(value: unknown): value is StemRef {
  if (!value || typeof value !== 'object') return false;
  const stem = value as { name?: unknown; url?: unknown };
  if (typeof stem.name !== 'string' || !/^[a-z0-9_-]+$/.test(stem.name)) return false;
  if (typeof stem.url !== 'string') return false;
  try {
    const parsed = new URL(stem.url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function parseAudioSeparatorResult(payload: unknown): SeparationResult {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Audio Separator returned an invalid response');
  }

  const result = payload as AudioSeparatorPayload;
  if (result.status === 'queued' || result.status === 'processing') {
    return { status: 'processing' };
  }
  if (result.status === 'failed') {
    return {
      status: 'failed',
      error: typeof result.error === 'string' && result.error.trim() ? result.error : 'Separation failed',
    };
  }
  if (result.status === 'succeeded') {
    if (!Array.isArray(result.stems) || !result.stems.every(validStem)) {
      throw new Error('Audio Separator succeeded without valid stem URLs');
    }
    return { status: 'succeeded', stems: result.stems };
  }
  throw new Error('Audio Separator returned an unknown status');
}

export function audioSeparatorBackend(env: Env): SeparationBackend {
  return {
    async start(req: SeparationStartRequest): Promise<{ externalId: string }> {
      const model = req.model ?? BS_ROFORMER_MODEL;
      const runner = getAudioSeparatorRunner(model);
      if (!runner) {
        throw new Error(`No Audio Separator profile is configured for the "${model}" choice`);
      }
      const res = await fetch(serviceUrl(env, '/v1/jobs'), {
        method: 'POST',
        headers: serviceHeaders(env),
        body: JSON.stringify({
          job_id: req.jobId,
          audio_url: req.audioUrl,
          webhook_url: req.webhookUrl,
          model: runner.profile,
        }),
      });
      if (!res.ok) {
        throw new Error(`Audio Separator start failed (${res.status})${await serviceError(res)}`);
      }
      const payload = (await res.json()) as AudioSeparatorPayload;
      if (typeof payload.id !== 'string' || !payload.id) {
        throw new Error('Audio Separator start response did not include a job id');
      }
      return { externalId: payload.id };
    },

    parseResult: parseAudioSeparatorResult,

    async fetchStatus(externalId: string): Promise<SeparationResult> {
      const res = await fetch(serviceUrl(env, `/v1/jobs/${encodeURIComponent(externalId)}`), {
        headers: serviceHeaders(env),
      });
      if (!res.ok) {
        throw new Error(`Audio Separator status failed (${res.status})${await serviceError(res)}`);
      }
      return parseAudioSeparatorResult(await res.json());
    },
  };
}
