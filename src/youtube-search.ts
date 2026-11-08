import { Innertube } from 'youtubei.js/cf-worker';
import { createInnertubeFetch } from './youtube.ts';

/** A YouTube search result. Choosing it imports `videoUrl` through the video importer. */
export interface YouTubeTrack {
  id: string; provider: 'youtube'; videoUrl: string; sourceUrl: string;
  title: string; channel: string; itemCreator: string; durationSec: number; providerName: string;
}

// Searching YouTube needs no key: the same Innertube API the site uses answers
// Cloudflare's network in about a second. Only downloads are refused there.
const SEARCH_LIMIT_MS = 6000;
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

export async function searchYouTube(query: string, options: { maximumSeconds: number; signal?: AbortSignal }): Promise<{ results: YouTubeTrack[] }> {
  options.signal?.throwIfAborted();
  const deadline = Date.now() + SEARCH_LIMIT_MS;
  const work = (async () => {
    const yt = await Innertube.create({ generate_session_locally: true, fetch: createInnertubeFetch(deadline) });
    const response = await yt.search(query.trim(), { type: 'video' });
    return youtubeTracks((response.videos ?? []) as unknown as VideoNode[], options.maximumSeconds);
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('YouTube search timed out')), SEARCH_LIMIT_MS);
      options.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    })]);
    return { results };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    work.catch(() => {});
  }
}
