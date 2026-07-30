// YouTube audio fetch behind the fetchYouTubeAudio() seam.
//
// Strategy: use the configured provider order, with a Replicate-hosted yt-dlp
// model as the production primary and youtubei.js as the free fallback.
import { Innertube, type Types } from 'youtubei.js/cf-worker';
import type { Env } from './env';

const MAX_DURATION_SECONDS = 15 * 60; // cost/scope guard for class use
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const MIN_AUDIO_BYTES = 1024;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const MODEL_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// YouTube bot-checks the default WEB client from datacenter IPs; the app
// clients are usually exempt. Try them in order until one is playable.
const CLIENTS: Types.InnerTubeClient[] = ['IOS', 'ANDROID', 'TV', 'TV_EMBEDDED', 'WEB_EMBEDDED', 'MWEB', 'WEB'];

const REPLICATE_API = 'https://api.replicate.com/v1';
const REPLICATE_POLL_MS = 2000;
const REPLICATE_MAX_WAIT_MS = 4 * 60 * 1000; // covers cold boot + download

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

export function parseYouTubeVideoId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

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

  const replicateConfigured = Boolean(
    env.REPLICATE_YT_MODEL?.trim() && env.REPLICATE_API_TOKEN?.trim()
  );
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
      console.error(`youtube ${provider} fetch failed`, err);
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
    const data = await new Response(stream).arrayBuffer();
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
  error?: unknown;
}

export async function fetchViaReplicate(url: string, env: Env): Promise<YouTubeAudio> {
  const modelName = env.REPLICATE_YT_MODEL?.trim() ?? '';
  const apiToken = env.REPLICATE_API_TOKEN?.trim() ?? '';
  if (!MODEL_NAME_PATTERN.test(modelName) || !apiToken) {
    throw new YouTubeError(
      'YouTube import is unavailable right now. Upload the audio file instead.',
      'youtube_fetch_unavailable'
    );
  }

  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  // Resolve the latest version explicitly — the model-scoped predictions
  // endpoint 404s for this private model, so pin the version per request.
  const modelRes = await fetch(`${REPLICATE_API}/models/${modelName}`, { headers });
  if (!modelRes.ok) {
    throw replicateResponseError(modelRes, 'model lookup');
  }
  const model = (await modelRes.json()) as { latest_version?: { id: string } };
  if (!model.latest_version?.id) {
    throw new YouTubeError(
      'YouTube import is unavailable right now. Upload the audio file instead.',
      'youtube_fetch_unavailable'
    );
  }

  const res = await fetch(`${REPLICATE_API}/predictions`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'wait=60', 'Cancel-After': '4m' },
    body: JSON.stringify({
      version: model.latest_version.id,
      input: { url, max_duration: MAX_DURATION_SECONDS },
    }),
  });
  if (!res.ok) {
    throw replicateResponseError(res, 'prediction start');
  }
  let prediction = (await res.json()) as YtPrediction;

  const deadline = Date.now() + REPLICATE_MAX_WAIT_MS;
  while (prediction.status === 'starting' || prediction.status === 'processing') {
    if (Date.now() > deadline) {
      throw new YouTubeError('YouTube fetch timed out — try again in a minute.');
    }
    await new Promise((r) => setTimeout(r, REPLICATE_POLL_MS));
    const poll = await fetch(`${REPLICATE_API}/predictions/${prediction.id}`, { headers });
    if (!poll.ok) throw replicateResponseError(poll, 'prediction poll');
    prediction = (await poll.json()) as YtPrediction;
  }

  if (prediction.status !== 'succeeded' || !prediction.output?.audio) {
    // predict.py raises ValueError with student-readable messages.
    const raw = prediction.error ? String(prediction.error) : '';
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
    const metadata = audio.slice(5, comma).toLowerCase();
    if (comma < 0 || !metadata.includes(';base64')) {
      throw invalidAudioResponse();
    }
    const b64 = audio.slice(comma + 1);
    if (b64.length > Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 4) {
      throw new YouTubeError('Audio too large (max 100 MB).', 'audio_too_large');
    }
    let bin: string;
    try {
      bin = atob(b64);
    } catch {
      throw invalidAudioResponse();
    }
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
    (outputUrl.hostname !== 'replicate.delivery' &&
      !outputUrl.hostname.endsWith('.replicate.delivery'))
  ) {
    throw invalidAudioResponse();
  }

  const res = await fetch(outputUrl, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!res.ok) throw replicateResponseError(res, 'audio download');

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (
    contentType.startsWith('text/') ||
    contentType.includes('json') ||
    contentType.includes('html')
  ) {
    throw invalidAudioResponse();
  }
  const contentLength = Number(res.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_AUDIO_BYTES) {
    throw new YouTubeError('Audio too large (max 100 MB).', 'audio_too_large');
  }
  return res.arrayBuffer();
}

function validateFetchedAudio(audio: YouTubeAudio): YouTubeAudio {
  const { data } = audio;
  if (data.byteLength < MIN_AUDIO_BYTES) throw invalidAudioResponse();
  if (data.byteLength > MAX_AUDIO_BYTES) {
    throw new YouTubeError('Audio too large (max 100 MB).', 'audio_too_large');
  }

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
    title: audio.title.trim().slice(0, 200) || 'youtube-audio',
    durationSec,
  };
}

function replicateResponseError(response: Response, operation: string): YouTubeError {
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
