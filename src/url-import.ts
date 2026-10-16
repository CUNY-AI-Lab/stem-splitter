import type { Env } from './env';
import { fetchViaReplicate, parseYouTubeVideoId, YouTubeError, type YouTubeAudio } from './youtube.ts';

export class UrlImportError extends Error {
  readonly code: string;
  readonly status: 400 | 502 | 503;
  readonly retryable: boolean;
  constructor(message: string, code: string, status: 400 | 502 | 503, retryable = false) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/** The fetch model independently resolves and filters every network target. */
export { parseMediaUrl } from './url-source.ts';
import { parseMediaUrl } from './url-source.ts';

export async function fetchUrlAudio(input: unknown, env: Env, maximumDurationSeconds: 300 | 900 = 900): Promise<YouTubeAudio> {
  const url = parseMediaUrl(input);
  if (!url) throw new UrlImportError('Paste a public HTTPS media link.', 'invalid_source_url', 400);
  if (env.URL_IMPORT_ENABLED !== 'true') {
    throw new UrlImportError('URL import is unavailable. Upload an audio file instead.', 'url_import_unavailable', 503);
  }
  try {
    // Keep YouTube canonicalization, but use the repaired model for both types.
    const audio = await fetchViaReplicate(url, env, { generalUrl: true, maximumDurationSeconds });
    if (audio.durationSec > maximumDurationSeconds) throw new UrlImportError(`Audio exceeds your ${maximumDurationSeconds / 60}-minute import limit.`, 'source_too_long', 400);
    return audio;
  } catch (error) {
    if (error instanceof UrlImportError) throw error;
    if (error instanceof YouTubeError) {
      if (['unsupported_source', 'invalid_source_url', 'audio_too_large'].includes(error.code)) {
        throw new UrlImportError(error.message, error.code, 400);
      }
      if ((error.code === 'video_too_long' || error.code === 'source_too_long')) throw new UrlImportError(`Audio exceeds your ${maximumDurationSeconds / 60}-minute import limit.`, 'source_too_long', 400);
      if (error.code === 'live_stream') throw new UrlImportError('Live streams cannot be imported.', 'live_stream', 400);
      const youtube = Boolean(parseYouTubeVideoId(url));
      throw new UrlImportError(
        youtube ? error.message : 'Could not import this source. Try a direct audio link or upload a file.',
        error.code.replace(/^youtube_/, 'source_'), 502, error.retryable
      );
    }
    throw new UrlImportError('Audio import failed. Try a direct audio link or upload a file.', 'source_fetch_failed', 502, true);
  }
}
