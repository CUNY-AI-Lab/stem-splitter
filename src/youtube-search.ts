import { Innertube } from 'youtubei.js/cf-worker';
import { createInnertubeFetch } from './youtube.ts';
import { youtubeFetcherConfigured } from './youtube-fetcher.ts';
import type { Env } from './env';

/** A YouTube search result. Choosing it imports `videoUrl` through the video importer. */
export interface YouTubeTrack {
  id: string; provider: 'youtube'; videoUrl: string; sourceUrl: string;
  title: string; channel: string; itemCreator: string; durationSec: number; providerName: string;
}

// Searching YouTube needs no key: the same Innertube API the site uses answers
// Cloudflare's network in about a second. Only downloads are refused there.
// Together under the 9 s that every search source gets (music-search.ts).
const INNERTUBE_LIMIT_MS = 3500, FETCHER_LIMIT_MS = 4500;
const RESULTS = 8;
// Shorter than this is a clip or a preview, not a song to split.
const MIN_SECONDS = 30;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const clean = (value: unknown) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

type VideoNode = {
  id?: unknown; video_id?: unknown; title?: { text?: unknown } | unknown; author?: { name?: unknown };
  duration?: { seconds?: unknown }; is_live?: unknown; is_upcoming?: unknown;
};

/** Parse search nodes into importable tracks, dropping live, upcoming, too short and too long videos. */
export function youtubeTracks(videos: VideoNode[], maximumSeconds: number): YouTubeTrack[] {
  const tracks: YouTubeTrack[] = [];
  for (const video of videos) {
    const id = typeof video.id === 'string' ? video.id : video.video_id;
    const seconds = Number(video.duration?.seconds);
    if (typeof id !== 'string' || !VIDEO_ID.test(id) || video.is_live === true || video.is_upcoming === true) continue;
    if (!Number.isFinite(seconds) || seconds < MIN_SECONDS || seconds > maximumSeconds) continue;
    const title = clean(typeof video.title === 'object' && video.title && 'text' in video.title ? (video.title as { text?: unknown }).text : video.title);
    // An auto-generated "Artist - Topic" channel names the artist.
    const channel = clean(video.author?.name), artist = channel.replace(/\s+-\s+Topic$/i, '');
    if (!title || tracks.some(track => track.videoUrl.endsWith(id))) continue;
    const videoUrl = `https://www.youtube.com/watch?v=${id}`;
    tracks.push({ id: `youtube:${id}`, provider: 'youtube', videoUrl, sourceUrl: videoUrl, title, channel, itemCreator: artist,
      durationSec: seconds, providerName: 'YouTube' });
    if (tracks.length >= RESULTS) break;
  }
  return tracks;
}

type FetcherSettings = Pick<Env, 'YOUTUBE_FETCHER_URL' | 'YOUTUBE_FETCHER_SECRET'>;
type VideoSearch = (query: string) => Promise<VideoNode[]>;

/** Race work against a time limit and the caller's cancellation. */
async function limited<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('YouTube search timed out')), ms);
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    work.catch(() => {});
  }
}

const innertubeVideos: VideoSearch = async query => {
  const yt = await Innertube.create({ generate_session_locally: true, fetch: createInnertubeFetch(Date.now() + INNERTUBE_LIMIT_MS) });
  return ((await yt.search(query, { type: 'video' })).videos ?? []) as unknown as VideoNode[];
};

/** The fetcher's yt-dlp search, shaped like Innertube's results. */
async function fetcherVideos(query: string, fetcher: FetcherSettings, signal?: AbortSignal, caller?: string): Promise<VideoNode[]> {
  const response = await fetch(new URL('/search', fetcher.YOUTUBE_FETCHER_URL), {
    method: 'POST', redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(FETCHER_LIMIT_MS), ...(signal ? [signal] : [])]),
    headers: { Authorization: `Bearer ${fetcher.YOUTUBE_FETCHER_SECRET}`, 'Content-Type': 'application/json' },
    // The caller lets the fetcher share its hour fairly; it names no one (src/search-limits.ts).
    body: JSON.stringify(caller ? { query, caller } : { query }),
  });
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`YouTube fetcher search answered ${response.status}`); }
  const body = await response.json() as { results?: unknown };
  if (!Array.isArray(body?.results)) throw new Error('YouTube fetcher search answered without results');
  return body.results.slice(0, 20).map(result => {
    const r = (result ?? {}) as { id?: unknown; title?: unknown; channel?: unknown; duration?: unknown; live?: unknown };
    return { id: r.id, title: { text: r.title }, author: { name: r.channel }, duration: { seconds: r.duration }, is_live: r.live === true };
  });
}

/**
 * YouTube's own search first. From Cloudflare's network it sometimes does not answer within seconds,
 * so a failed, slow or empty answer falls back to the fetcher, which searches from an ordinary connection.
 */
/** A search the fetcher would have answered, left out by the search limits. Not cached. */
export class YouTubeSearchLimited extends Error {
  constructor() { super('youtube_search_limited'); }
}

export async function searchYouTube(query: string,
  options: { maximumSeconds: number; signal?: AbortSignal; fetcher?: FetcherSettings; fallbackAllowed?: () => Promise<boolean>; caller?: string },
  innertube: VideoSearch = innertubeVideos): Promise<{ results: YouTubeTrack[] }> {
  options.signal?.throwIfAborted();
  const words = query.trim();
  let videos: VideoNode[] = [], failure: unknown;
  try { videos = await limited(innertube(words), INNERTUBE_LIMIT_MS, options.signal); }
  catch (error) { if (options.signal?.aborted) throw error; failure = error; }
  if (!videos.length && options.fetcher && youtubeFetcherConfigured(options.fetcher)) {
    // Counted only when the fetcher would be asked. Left out, YouTube is "unavailable" for this
    // search rather than empty, so the shared cache does not keep it empty for everyone.
    if (options.fallbackAllowed && !(await options.fallbackAllowed())) {
      console.info(JSON.stringify({ event: 'youtube_search_fallback_limited' }));
      throw new YouTubeSearchLimited();
    }
    // No search words in the log.
    console.info(JSON.stringify({ event: 'youtube_search_fallback', reason: failure ? 'failed' : 'empty' }));
    videos = await fetcherVideos(words, options.fetcher, options.signal, options.caller);
  } else if (failure) throw failure;
  return { results: youtubeTracks(videos, options.maximumSeconds) };
}
