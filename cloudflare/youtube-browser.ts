import type { Env } from '../src/env.ts';
import { parseYouTubeVideoId, YouTubeError, CAIL_IMPORT_BYTES } from '../src/youtube.ts';
import { acquireYouTubeAudio, type BrowserBinding } from './youtube-acquisition.mjs';

type Acquire = typeof acquireYouTubeAudio;

/** Cloudflare owns the browser; public requests can only supply a validated video URL. */
export function youtubeBrowserLoader(binding: unknown, acquire: Acquire = acquireYouTubeAudio): Env['fetchYouTubeBrowserAudio'] {
  if (!binding || typeof binding !== 'object' || typeof (binding as BrowserBinding).fetch !== 'function') return undefined;
  return async (url, { deadline }) => {
    const videoId = parseYouTubeVideoId(url);
    if (!videoId) throw new YouTubeError('Choose a supported video link.', 'invalid_youtube_url');
    try {
      const { audio, receipt } = await acquire({ BROWSER: binding as BrowserBinding }, { videoId, deadline });
      if (!receipt.browserClosed || audio.mimeType !== 'audio/webm' || !(audio.data instanceof Uint8Array)
        || !audio.data.byteLength || audio.data.byteLength > CAIL_IMPORT_BYTES
        || !Number.isFinite(audio.durationMs) || audio.durationMs <= 0 || audio.durationMs > 900000) {
        throw new YouTubeError('Video audio is unavailable.', 'invalid_audio_response');
      }
      const title = typeof receipt.title === 'string' ? receipt.title.replace(/[\x00-\x1f\x7f/\\]/g, ' ').trim().slice(0, 200) : '';
      // Copy exactly the audio view, excluding any surrounding response buffer.
      const data = new Uint8Array(audio.data.byteLength);
      data.set(audio.data);
      return { data: data.buffer, title: title || 'YouTube audio', durationSec: audio.durationMs / 1000,
        fileName: 'source.webm', contentType: 'audio/webm' };
    } catch (error) {
      if (error instanceof YouTubeError) throw error;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      throw new YouTubeError('Video audio is unavailable.', code === 'audio_too_large' ? 'audio_too_large'
        : code === 'source_timeout' ? 'youtube_fetch_timeout'
          : ['source_access_refused', 'source_security_refusal', 'source_restricted'].includes(String(code)) ? 'youtube_source_restricted'
            : 'youtube_fetch_unavailable');
    }
  };
}
