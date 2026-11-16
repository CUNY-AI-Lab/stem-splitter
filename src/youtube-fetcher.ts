import type { Env } from './env';
import { parseYouTubeVideoId } from './video-source.ts';
import { readBoundedResponse, responseMediaType } from './http/bounded-response.ts';
import { CAIL_IMPORT_BYTES, YouTubeError } from './youtube.ts';

// YouTube refuses full audio to a Worker's own requests: the player is bot-checked, and
// direct links stop after the first megabyte. The fetcher (youtube-fetcher/) runs yt-dlp
// on an ordinary connection and is reached through a Cloudflare Tunnel, or, on Dev's
// Containers trial, through a service binding to the Worker that runs it in a container.

/** Leaves time for the browser and hosted importers if the fetcher cannot answer. */
const FETCHER_TIMEOUT_MS = 60_000;
const TYPES = { 'audio/mp4': 'source.m4a', 'audio/webm': 'source.webm' } as const;
// The fetcher's own refusals. Each one would recur on any other importer.
const FINAL: Record<string, [code: string, message: string]> = {
  source_too_long: ['source_too_long', 'This video is longer than your import limit.'],
  live_stream: ['live_stream', 'Live streams cannot be imported.'],
  audio_too_large: ['audio_too_large', 'This video’s audio exceeds the import size limit.'],
  source_denied_private: ['youtube_source_restricted', 'This video is private.'],
  source_denied_age_restricted: ['youtube_source_restricted', 'This video is age-restricted, so it cannot be imported.'],
  source_denied_unavailable: ['youtube_source_restricted', 'This video is unavailable.'],
};

export function youtubeFetcherConfigured(env: Pick<Env, 'YOUTUBE_FETCHER_URL' | 'YOUTUBE_FETCHER_SECRET'>): boolean {
  const secret = env.YOUTUBE_FETCHER_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) return false;
  try { return new URL(env.YOUTUBE_FETCHER_URL ?? '').protocol === 'https:'; } catch { return false; }
}

/** How to reach the fetcher: its service binding when the Worker has one, else the public URL. */
export function fetcherFetch(env: Pick<Env, 'YOUTUBE_FETCHER_SERVICE'>): typeof fetch {
  const service = env.YOUTUBE_FETCHER_SERVICE;
  return ((input: RequestInfo | URL, init?: RequestInit) => service ? service.fetch(input, init) : fetch(input, init)) as typeof fetch;
}

/**
 * Fetch one video's audio through the fetcher. A final refusal (too long, private, live)
 * is a YouTubeError with retryable false; anything else may be retried by another importer.
 */
export async function fetchViaYouTubeFetcher(url: string, env: Env, options: { deadline: number; maximumDurationSeconds: 300 | 900 }) {
  const videoId = parseYouTubeVideoId(url);
  if (!videoId) throw new YouTubeError('Choose a supported video link.', 'invalid_youtube_url');
  if (!youtubeFetcherConfigured(env)) throw new YouTubeError('Video import is temporarily unavailable.', 'youtube_fetch_unavailable', true);
  const timeoutMs = Math.min(FETCHER_TIMEOUT_MS, options.deadline - Date.now());
  if (timeoutMs < 5000) throw new YouTubeError('Video import ran out of time.', 'youtube_fetch_timeout', true);
  const unavailable = () => new YouTubeError('Video import is temporarily unavailable.', 'youtube_fetch_unavailable', true);
  let response: Response;
  try {
    response = await fetcherFetch(env)(new URL('/audio', env.YOUTUBE_FETCHER_URL), {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${env.YOUTUBE_FETCHER_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, maxSeconds: options.maximumDurationSeconds }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new YouTubeError('Video import ran out of time.', 'youtube_fetch_timeout', true);
    throw unavailable();
  }
  if (!response.ok) {
    const code = await response.json().then(body => (body as { code?: unknown })?.code, () => undefined);
    const final = typeof code === 'string' ? FINAL[code] : undefined;
    if (final) throw new YouTubeError(final[1], final[0]);
    await response.body?.cancel().catch(() => {});
    throw unavailable();
  }
  const type = responseMediaType(response);
  if (!(type in TYPES)) { await response.body?.cancel().catch(() => {}); throw new YouTubeError('Video audio is unavailable.', 'invalid_audio_response', true); }
  const durationSec = Number(response.headers.get('x-audio-duration'));
  const data = await readBoundedResponse(response, {
    maximumBytes: CAIL_IMPORT_BYTES, timeoutMs: Math.max(1000, options.deadline - Date.now()),
    errors: {
      tooLarge: () => new YouTubeError('This video’s audio exceeds the import size limit.', 'audio_too_large'),
      timedOut: () => new YouTubeError('Video import ran out of time.', 'youtube_fetch_timeout', true),
      unreadable: () => new YouTubeError('Video audio is unavailable.', 'invalid_audio_response', true),
    },
  });
  if (!data.byteLength || !Number.isFinite(durationSec) || durationSec <= 0 || durationSec > options.maximumDurationSeconds) {
    throw new YouTubeError('Video audio is unavailable.', 'invalid_audio_response', true);
  }
  let title = '';
  try { title = decodeURIComponent(response.headers.get('x-audio-title') ?? ''); } catch {}
  title = title.replace(/[\x00-\x1f\x7f/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return { data, title: title || 'YouTube audio', durationSec, fileName: TYPES[type as keyof typeof TYPES], contentType: type as keyof typeof TYPES };
}
