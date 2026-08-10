// YouTube audio fetch behind the fetchYouTubeAudio() seam.
//
// Strategy: use the configured provider order, with a Replicate-hosted yt-dlp
// model as the production primary and youtubei.js as the free fallback.
import { Innertube, type Types } from 'youtubei.js/cf-worker';
import type { Env } from './env';
import { readBoundedResponse, responseMediaType } from './http/bounded-response.ts';

const MAX_DURATION_SECONDS = 15 * 60; // cost/scope guard for class use
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const MIN_AUDIO_BYTES = 1024;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const MODEL_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MODEL_VERSION_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_TOKEN_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/;

// YouTube bot-checks the default WEB client from datacenter IPs; the app
// clients are usually exempt. Try them in order until one is playable.
const CLIENTS: Types.InnerTubeClient[] = ['IOS', 'ANDROID', 'TV', 'TV_EMBEDDED', 'WEB_EMBEDDED', 'MWEB', 'WEB'];

const REPLICATE_API = 'https://api.replicate.com/v1';
const REPLICATE_POLL_MS = 2000;
const REPLICATE_MAX_WAIT_MS = 4 * 60 * 1000; // covers cold boot + download
const REPLICATE_START_TIMEOUT_MS = 75 * 1000;
const REPLICATE_POLL_TIMEOUT_MS = 15 * 1000;
const AUDIO_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_PREDICTION_BYTES = 64 * 1024;
const PREDICTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const PREDICTION_STATUSES = new Set([
  'starting',
  'processing',
  'succeeded',
  'failed',
  'canceled',
]);

/** Errors safe to show to students verbatim. */
export class YouTubeError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code = 'youtube_fetch_failed', retryable = false) {
    super(message);
    this.name = 'YouTubeError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface YouTubeAudio {
  data: ArrayBuffer;
  title: string;
  durationSec: number;
}

function replicateConfiguration(env: Env) {
  const modelName = env.REPLICATE_YT_MODEL ?? '';
  const modelVersion = env.REPLICATE_YT_MODEL_VERSION ?? '';
  const apiToken = env.REPLICATE_API_TOKEN ?? '';
  if (
    modelName.length > 200 ||
    !MODEL_NAME_PATTERN.test(modelName) ||
    !MODEL_VERSION_PATTERN.test(modelVersion) ||
    apiToken.length < 20 ||
    apiToken.length > 512 ||
    !SAFE_TOKEN_PATTERN.test(apiToken)
  ) {
    return null;
  }
  return { modelName, modelVersion, apiToken };
}

export function parseYouTubeVideoId(url: string): string | null {
  if (url.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (
    (u.protocol !== 'https:' && u.protocol !== 'http:') ||
    u.username ||
    u.password ||
    u.port
  ) return null;

  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  let videoId: string | null = null;
  if (host === 'youtu.be') {
    videoId = u.pathname.slice(1).split('/')[0] || null;
  } else if (
    host === 'youtube.com' ||
    host === 'music.youtube.com' ||
    host === 'youtube-nocookie.com'
  ) {
    if (u.pathname === '/watch') {
      videoId = u.searchParams.get('v');
    } else if (/^\/(shorts|embed|live)\//.test(u.pathname)) {
      videoId = u.pathname.split('/')[2] || null;
    }
  }
  return videoId && VIDEO_ID_PATTERN.test(videoId) ? videoId : null;
}

export async function fetchYouTubeAudio(url: string, env: Env): Promise<YouTubeAudio> {
  const videoId = parseYouTubeVideoId(url);
  if (!videoId) {
    throw new YouTubeError(
      'Paste a full YouTube video link.',
      'invalid_youtube_url'
    );
  }

  const replicateConfigured = replicateConfiguration(env) !== null;
  const replicateFirst = env.YOUTUBE_FETCH_ORDER === 'replicate-first' && replicateConfigured;
  const providers: Array<'innertube' | 'replicate'> = replicateFirst
    ? ['replicate', 'innertube']
    : ['innertube', ...(replicateConfigured ? (['replicate'] as const) : [])];
  const failures: Array<{ provider: string; error: unknown }> = [];

  for (const provider of providers) {
    try {
      return provider === 'replicate'
        ? await fetchViaReplicate(url, env)
        : await fetchViaInnertube(videoId);
    } catch (err) {
      if (
        err instanceof YouTubeError &&
        ['live_stream', 'video_too_long'].includes(err.code)
      ) {
        throw err;
      }
      failures.push({ provider, error: err });
      console.error(`youtube ${provider} fetch failed`, {
        name: err instanceof Error ? err.name : 'unknown',
        ...(err instanceof YouTubeError ? { code: err.code } : {}),
      });
    }
  }

  const busy = failures.some(
    ({ error }) => error instanceof YouTubeError && error.code === 'youtube_fetch_busy'
  );
  if (busy) {
    throw new YouTubeError(
      'YouTube import is busy. Wait a minute and try again.',
      'youtube_fetch_busy',
      true
    );
  }
  throw new YouTubeError(
    'YouTube blocked this import. Try a different video or upload the audio file.',
    'youtube_fetch_blocked',
    true
  );
}

// --- in-Worker fetch (youtubei.js) --------------------------------------

async function fetchViaInnertube(videoId: string): Promise<YouTubeAudio> {
  const yt = await Innertube.create({ generate_session_locally: true });

  let lastReason = 'unknown';
  for (const client of CLIENTS) {
    let info;
    try {
      info = await yt.getBasicInfo(videoId, { client });
    } catch {
      continue; // client-specific parse/availability failure — try the next one
    }

    const basic = info.basic_info;
    if (basic.is_live) {
      throw new YouTubeError('Live streams cannot be imported.', 'live_stream');
    }
    const durationSec = basic.duration ?? 0;
    if (durationSec > MAX_DURATION_SECONDS) {
      throw new YouTubeError(
        'Video is longer than 15 minutes — pick a shorter one.',
        'video_too_long'
      );
    }
    if (info.playability_status && info.playability_status.status !== 'OK') {
      lastReason = info.playability_status.reason || info.playability_status.status;
      continue;
    }

    // Audio-only M4A/AAC — Demucs ingests M4A directly, no transcoding needed.
    let stream;
    try {
      stream = await info.download({ type: 'audio', quality: 'best', format: 'mp4', client });
    } catch {
      continue; // no matching format via this client — try the next one
    }
    const data = await readBoundedResponse(new Response(stream), {
      maximumBytes: MAX_AUDIO_BYTES,
      timeoutMs: AUDIO_DOWNLOAD_TIMEOUT_MS,
      errors: {
        tooLarge: audioTooLarge,
        timedOut: providerUnavailable,
        unreadable: invalidAudioResponse,
      },
    });
    return validateFetchedAudio({
      data,
      title: basic.title ?? 'youtube-audio',
      durationSec,
    });
  }

  throw new YouTubeError(
    `Video is not playable (${lastReason}).`,
    'youtube_fetch_blocked',
    true
  );
}

// --- Replicate yt-dlp fallback (replicate-yt-audio/) --------------------

interface YtPrediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: { audio: string; title: string; duration: number };
  error?: string;
}

async function replicateFetch(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      // Keep the bearer token on the exact provider origin selected here. A
      // redirect is an error; callers never reissue it with credentials.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw providerUnavailable();
  }
}

async function readPrediction(
  response: Response,
  expectedId?: string
): Promise<YtPrediction> {
  if (responseMediaType(response) !== 'application/json') {
    await response.body?.cancel().catch(() => undefined);
    throw providerUnavailable();
  }
  const bytes = await readBoundedResponse(response, {
    maximumBytes: MAX_PREDICTION_BYTES,
    timeoutMs: REPLICATE_POLL_TIMEOUT_MS,
    errors: {
      tooLarge: providerUnavailable,
      timedOut: providerUnavailable,
      unreadable: providerUnavailable,
    },
  });

  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    );
  } catch {
    throw providerUnavailable();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw providerUnavailable();
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string' ||
    !PREDICTION_ID_PATTERN.test(candidate.id) ||
    (expectedId !== undefined && candidate.id !== expectedId) ||
    typeof candidate.status !== 'string' ||
    !PREDICTION_STATUSES.has(candidate.status)
  ) {
    throw providerUnavailable();
  }

  let output: YtPrediction['output'];
  if (candidate.output !== undefined && candidate.output !== null) {
    if (
      typeof candidate.output !== 'object' ||
      Array.isArray(candidate.output)
    ) {
      throw providerUnavailable();
    }
    const rawOutput = candidate.output as Record<string, unknown>;
    if (
      typeof rawOutput.audio !== 'string' ||
      rawOutput.audio.length < 1 ||
      typeof rawOutput.title !== 'string' ||
      typeof rawOutput.duration !== 'number' ||
      !Number.isFinite(rawOutput.duration)
    ) {
      throw providerUnavailable();
    }
    output = {
      audio: rawOutput.audio,
      title: rawOutput.title,
      duration: rawOutput.duration,
    };
  }
  if (candidate.status === 'succeeded' && !output) throw providerUnavailable();

  return {
    id: candidate.id,
    status: candidate.status as YtPrediction['status'],
    output,
    error: typeof candidate.error === 'string' ? candidate.error.slice(0, 300) : undefined,
  };
}

export async function fetchViaReplicate(url: string, env: Env): Promise<YouTubeAudio> {
  const configuration = replicateConfiguration(env);
  if (!configuration) {
    throw new YouTubeError(
      'YouTube import is unavailable right now. Upload the audio file instead.',
      'youtube_fetch_unavailable'
    );
  }
  const { modelVersion, apiToken } = configuration;
  const videoId = parseYouTubeVideoId(url);
  if (!videoId) {
    throw new YouTubeError('Paste a full YouTube video link.', 'invalid_youtube_url');
  }
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  const res = await replicateFetch(`${REPLICATE_API}/predictions`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'wait=60', 'Cancel-After': '4m' },
    body: JSON.stringify({
      version: modelVersion,
      input: { url: canonicalUrl, max_duration: MAX_DURATION_SECONDS },
    }),
  }, REPLICATE_START_TIMEOUT_MS);
  if (!res.ok) {
    throw await replicateResponseError(res, 'prediction start');
  }
  let prediction = await readPrediction(res);

  const deadline = Date.now() + REPLICATE_MAX_WAIT_MS;
  while (prediction.status === 'starting' || prediction.status === 'processing') {
    if (Date.now() > deadline) {
      throw new YouTubeError('YouTube fetch timed out — try again in a minute.');
    }
    await new Promise((r) => setTimeout(r, REPLICATE_POLL_MS));
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new YouTubeError('YouTube fetch timed out — try again in a minute.');
    }
    const poll = await replicateFetch(
      `${REPLICATE_API}/predictions/${encodeURIComponent(prediction.id)}`,
      { headers },
      Math.min(REPLICATE_POLL_TIMEOUT_MS, remainingMs)
    );
    if (!poll.ok) throw await replicateResponseError(poll, 'prediction poll');
    prediction = await readPrediction(poll, prediction.id);
  }

  if (prediction.status !== 'succeeded' || !prediction.output?.audio) {
    // predict.py raises ValueError with student-readable messages.
    const raw = prediction.error ?? '';
    throw normalizePredictionError(raw);
  }

  const durationSec = Number(prediction.output.duration ?? 0);
  if (durationSec > MAX_DURATION_SECONDS) {
    throw new YouTubeError(
      'Video is longer than 15 minutes — pick a shorter one.',
      'video_too_long'
    );
  }

  const data = await downloadPredictionFile(prediction.output.audio, apiToken);
  return validateFetchedAudio({
    data,
    title: prediction.output.title || 'youtube-audio',
    durationSec,
  });
}

/** Prediction file outputs are usually replicate.delivery URLs but can be inline data-URIs. */
async function downloadPredictionFile(audio: string, apiToken: string): Promise<ArrayBuffer> {
  if (audio.startsWith('data:')) {
    const comma = audio.indexOf(',');
    const metadata = comma >= 0 ? audio.slice(5, comma).toLowerCase() : '';
    if (
      comma < 0 ||
      !metadata.startsWith('audio/') ||
      !metadata.endsWith(';base64')
    ) {
      throw invalidAudioResponse();
    }
    const b64 = audio.slice(comma + 1);
    if (b64.length > Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 4) {
      throw audioTooLarge();
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
      throw invalidAudioResponse();
    }
    let bin: string;
    try {
      bin = atob(b64);
    } catch {
      throw invalidAudioResponse();
    }
    if (bin.length > MAX_AUDIO_BYTES) throw audioTooLarge();
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  let outputUrl: URL;
  try {
    outputUrl = new URL(audio);
  } catch {
    throw invalidAudioResponse();
  }
  if (
    outputUrl.protocol !== 'https:' ||
    outputUrl.username ||
    outputUrl.password ||
    outputUrl.port ||
    outputUrl.hash ||
    (outputUrl.hostname !== 'replicate.delivery' &&
      !outputUrl.hostname.endsWith('.replicate.delivery'))
  ) {
    throw invalidAudioResponse();
  }

  const res = await replicateFetch(
    outputUrl,
    { headers: { Authorization: `Bearer ${apiToken}` } },
    AUDIO_DOWNLOAD_TIMEOUT_MS
  );
  if (!res.ok) throw await replicateResponseError(res, 'audio download');

  const contentType = responseMediaType(res);
  if (!contentType.startsWith('audio/') && contentType !== 'application/octet-stream') {
    await res.body?.cancel().catch(() => undefined);
    throw invalidAudioResponse();
  }
  return readBoundedResponse(res, {
    maximumBytes: MAX_AUDIO_BYTES,
    timeoutMs: AUDIO_DOWNLOAD_TIMEOUT_MS,
    errors: {
      tooLarge: audioTooLarge,
      timedOut: providerUnavailable,
      unreadable: invalidAudioResponse,
    },
  });
}

function validateFetchedAudio(audio: YouTubeAudio): YouTubeAudio {
  const { data } = audio;
  if (data.byteLength < MIN_AUDIO_BYTES) throw invalidAudioResponse();
  if (data.byteLength > MAX_AUDIO_BYTES) throw audioTooLarge();

  const bytes = new Uint8Array(data, 0, Math.min(data.byteLength, 12));
  const isIsoBaseMedia =
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70;
  if (!isIsoBaseMedia) throw invalidAudioResponse();

  const durationSec = Number(audio.durationSec);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw invalidAudioResponse();

  return {
    data,
    title:
      audio.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) ||
      'youtube-audio',
    durationSec,
  };
}

async function replicateResponseError(
  response: Response,
  operation: string
): Promise<YouTubeError> {
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 429) {
    return new YouTubeError(
      'YouTube import is busy. Wait a minute and try again.',
      'youtube_fetch_busy',
      true
    );
  }
  console.error(`replicate YouTube ${operation} failed`, { status: response.status });
  return new YouTubeError(
    'YouTube import is unavailable right now. Upload the audio file instead.',
    'youtube_fetch_unavailable',
    response.status >= 500
  );
}

function providerUnavailable(): YouTubeError {
  return new YouTubeError(
    'YouTube import is unavailable right now. Upload the audio file instead.',
    'youtube_fetch_unavailable',
    true
  );
}

function audioTooLarge(): YouTubeError {
  return new YouTubeError('Audio too large (max 100 MB).', 'audio_too_large');
}

function normalizePredictionError(raw: string): YouTubeError {
  const message = raw.replace(/^ValueError:\s*/, '').slice(0, 300);
  if (/live stream/i.test(message)) {
    return new YouTubeError('Live streams cannot be imported.', 'live_stream');
  }
  if (/longer than \d+ minutes/i.test(message)) {
    return new YouTubeError(
      'Video is longer than 15 minutes — pick a shorter one.',
      'video_too_long'
    );
  }
  if (/throttl|rate.?limit|too many requests/i.test(message)) {
    return new YouTubeError(
      'YouTube import is busy. Wait a minute and try again.',
      'youtube_fetch_busy',
      true
    );
  }
  return new YouTubeError(
    'YouTube blocked this import. Try a different video or upload the audio file.',
    'youtube_fetch_blocked',
    true
  );
}

function invalidAudioResponse(): YouTubeError {
  return new YouTubeError(
    'YouTube returned no usable audio. Try another video or upload the audio file.',
    'invalid_audio_response',
    true
  );
}
