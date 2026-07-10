// YouTube audio fetch behind the fetchYouTubeAudio() seam.
//
// Strategy: try the free in-Worker fetch (youtubei.js) first, then fall back
// to a Replicate-hosted yt-dlp model (replicate-yt-audio/, deployed as
// REPLICATE_YT_MODEL). YouTube bot-checks Cloudflare egress IPs, so in
// practice the fallback does most of the work; the in-Worker attempt stays
// because it is free and instant whenever YouTube lets it through.
import { Innertube, type Types } from 'youtubei.js/cf-worker';
import type { Env } from './env';

const MAX_DURATION_SECONDS = 15 * 60; // cost/scope guard for class use

// YouTube bot-checks the default WEB client from datacenter IPs; the app
// clients are usually exempt. Try them in order until one is playable.
const CLIENTS: Types.InnerTubeClient[] = ['IOS', 'ANDROID', 'TV', 'TV_EMBEDDED', 'WEB_EMBEDDED', 'MWEB', 'WEB'];

const REPLICATE_API = 'https://api.replicate.com/v1';
const REPLICATE_POLL_MS = 2000;
const REPLICATE_MAX_WAIT_MS = 4 * 60 * 1000; // covers cold boot + download

/** Errors safe to show to students verbatim. */
export class YouTubeError extends Error {}

export interface YouTubeAudio {
  data: ArrayBuffer;
  title: string;
  durationSec: number;
}

export function parseYouTubeVideoId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m)\./, '');
  if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    if (u.pathname === '/watch') return u.searchParams.get('v');
    if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2] || null;
  }
  return null;
}

export async function fetchYouTubeAudio(url: string, env: Env): Promise<YouTubeAudio> {
  const videoId = parseYouTubeVideoId(url);
  if (!videoId) {
    throw new YouTubeError('Not a recognizable YouTube link (use youtube.com/watch, youtu.be, or /shorts).');
  }

  let innertubeError: unknown;
  try {
    return await fetchViaInnertube(videoId);
  } catch (err) {
    innertubeError = err;
  }

  if (env.REPLICATE_YT_MODEL) {
    try {
      return await fetchViaReplicate(url, env);
    } catch (err) {
      // The fallback's error is the more meaningful one (yt-dlp's reason).
      if (err instanceof YouTubeError) throw err;
      console.error('replicate yt fetch error', err);
    }
  }

  if (innertubeError instanceof YouTubeError) throw innertubeError;
  throw new YouTubeError('YouTube fetch failed — try again, or upload the audio file instead.');
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
    if (basic.is_live) throw new YouTubeError('Live streams cannot be imported.');
    const durationSec = basic.duration ?? 0;
    if (durationSec > MAX_DURATION_SECONDS) {
      throw new YouTubeError('Video is longer than 15 minutes — pick a shorter one.');
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
    return { data, title: basic.title ?? 'youtube-audio', durationSec };
  }

  throw new YouTubeError(`Video is not playable (${lastReason}).`);
}

// --- Replicate yt-dlp fallback (replicate-yt-audio/) --------------------

interface YtPrediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: { audio: string; title: string; duration: number };
  error?: unknown;
}

async function fetchViaReplicate(url: string, env: Env): Promise<YouTubeAudio> {
  const headers = {
    Authorization: `Bearer ${env.REPLICATE_API_TOKEN}`,
    'Content-Type': 'application/json',
  };

  // Resolve the latest version explicitly — the model-scoped predictions
  // endpoint 404s for this private model, so pin the version per request.
  const modelRes = await fetch(`${REPLICATE_API}/models/${env.REPLICATE_YT_MODEL}`, { headers });
  if (!modelRes.ok) {
    throw new Error(`Replicate yt-audio model lookup failed (${modelRes.status}): ${await modelRes.text()}`);
  }
  const model = (await modelRes.json()) as { latest_version?: { id: string } };
  if (!model.latest_version?.id) throw new Error('Replicate yt-audio model has no pushed version');

  const res = await fetch(`${REPLICATE_API}/predictions`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'wait=60' },
    body: JSON.stringify({
      version: model.latest_version.id,
      input: { url, max_duration: MAX_DURATION_SECONDS },
    }),
  });
  if (!res.ok) {
    throw new Error(`Replicate yt-audio start failed (${res.status}): ${await res.text()}`);
  }
  let prediction = (await res.json()) as YtPrediction;

  const deadline = Date.now() + REPLICATE_MAX_WAIT_MS;
  while (prediction.status === 'starting' || prediction.status === 'processing') {
    if (Date.now() > deadline) {
      throw new YouTubeError('YouTube fetch timed out — try again in a minute.');
    }
    await new Promise((r) => setTimeout(r, REPLICATE_POLL_MS));
    const poll = await fetch(`${REPLICATE_API}/predictions/${prediction.id}`, { headers });
    if (!poll.ok) throw new Error(`Replicate yt-audio poll failed (${poll.status})`);
    prediction = (await poll.json()) as YtPrediction;
  }

  if (prediction.status !== 'succeeded' || !prediction.output?.audio) {
    // predict.py raises ValueError with student-readable messages.
    const raw = prediction.error ? String(prediction.error) : 'YouTube fetch failed.';
    throw new YouTubeError(raw.replace(/^ValueError:\s*/, '').slice(0, 300));
  }

  const durationSec = prediction.output.duration ?? 0;
  if (durationSec > MAX_DURATION_SECONDS) {
    throw new YouTubeError('Video is longer than 15 minutes — pick a shorter one.');
  }

  const data = await downloadPredictionFile(prediction.output.audio);
  return { data, title: prediction.output.title || 'youtube-audio', durationSec };
}

/** Prediction file outputs are usually replicate.delivery URLs but can be inline data-URIs. */
async function downloadPredictionFile(audio: string): Promise<ArrayBuffer> {
  if (audio.startsWith('data:')) {
    const b64 = audio.slice(audio.indexOf(',') + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  const res = await fetch(audio);
  if (!res.ok) throw new Error(`Failed to download fetched audio (${res.status})`);
  return res.arrayBuffer();
}
