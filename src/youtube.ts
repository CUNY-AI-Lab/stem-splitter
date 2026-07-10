// YouTube audio fetch, isolated behind fetchYouTubeAudio() so it can be
// swapped for an external service (e.g. a Replicate yt-dlp model) if
// YouTube-side changes or bot detection make the in-Worker approach flaky.
import { Innertube } from 'youtubei.js/cf-worker';

const MAX_DURATION_SECONDS = 15 * 60; // cost/scope guard for class use

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

export async function fetchYouTubeAudio(url: string): Promise<YouTubeAudio> {
  const videoId = parseYouTubeVideoId(url);
  if (!videoId) {
    throw new YouTubeError('Not a recognizable YouTube link (use youtube.com/watch, youtu.be, or /shorts).');
  }

  const yt = await Innertube.create({ generate_session_locally: true });
  const info = await yt.getBasicInfo(videoId);

  const basic = info.basic_info;
  if (basic.is_live) throw new YouTubeError('Live streams cannot be imported.');
  const durationSec = basic.duration ?? 0;
  if (durationSec > MAX_DURATION_SECONDS) {
    throw new YouTubeError('Video is longer than 15 minutes — pick a shorter one.');
  }
  if (info.playability_status && info.playability_status.status !== 'OK') {
    throw new YouTubeError(
      `Video is not playable (${info.playability_status.reason || info.playability_status.status}).`
    );
  }

  // Audio-only M4A/AAC — Demucs ingests M4A directly, no transcoding needed.
  const stream = await info.download({ type: 'audio', quality: 'best', format: 'mp4' });
  const data = await new Response(stream).arrayBuffer();

  return { data, title: basic.title ?? 'youtube-audio', durationSec };
}
