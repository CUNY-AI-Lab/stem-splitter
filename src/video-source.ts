export interface VideoSource {
  sourceType: 'youtube' | 'vimeo';
  id: string;
  canonicalUrl: string;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = '[1-9][0-9]{0,11}';
const VIMEO_HASH = /^[a-fA-F0-9]{10}$/;

/** Accept individual videos on known hosts; drop tracking data and retain
 * Vimeo's unlisted access hash only when its location is unambiguous.
 */
export function parseVideoSource(value: unknown): VideoSource | null {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f\\]/.test(value)) return null;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  // URL normalizes default ports and encoded host names; require a literal
  // supported authority as the extractor does before it receives this URL.
  const authority = /^https?:\/\/([^/?#]*)/i.exec(value.trim())?.[1];
  if (!authority || authority.toLowerCase() !== url.hostname.toLowerCase()) return null;

  const host = url.hostname.toLowerCase();
  const youtubeHost = host.replace(/^(www|m)\./, '');
  let id: string | null = null;
  if (youtubeHost === 'youtu.be') {
    id = /^\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname) ? url.pathname.split('/')[1] : null;
  } else if (['youtube.com', 'music.youtube.com', 'youtube-nocookie.com'].includes(youtubeHost)) {
    if (url.pathname === '/watch') {
      id = url.searchParams.getAll('v').length === 1 ? url.searchParams.get('v') : null;
    } else if (/^\/(shorts|embed|live)\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname)) {
      id = url.pathname.split('/')[2];
    }
  }
  if (id && YOUTUBE_ID.test(id)) return { sourceType: 'youtube', id, canonicalUrl: `https://www.youtube.com/watch?v=${id}` };

  const path = host === 'vimeo.com' || host === 'www.vimeo.com'
    ? new RegExp(`^/(${VIMEO_ID})(?:/([a-fA-F0-9]{10}))?/?$`).exec(url.pathname)
    : host === 'player.vimeo.com' ? new RegExp(`^/video/(${VIMEO_ID})/?$`).exec(url.pathname) : null;
  if (!path) return null;
  const hashes = url.searchParams.getAll('h');
  if (hashes.length > 1 || hashes.some(hash => !VIMEO_HASH.test(hash))) return null;
  const pathHash = path[2], queryHash = hashes[0];
  if (pathHash && queryHash && pathHash !== queryHash) return null;
  const hash = pathHash || queryHash;
  return { sourceType: 'vimeo', id: path[1], canonicalUrl: `https://vimeo.com/${path[1]}${hash ? `/${hash}` : ''}` };
}

export function parseYouTubeVideoId(value: unknown): string | null {
  const source = parseVideoSource(value);
  return source?.sourceType === 'youtube' ? source.id : null;
}
