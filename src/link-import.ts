import { parseMediaUrl } from './url-source.ts';
import { parseVideoSource } from './video-source.ts';
import { mp3FrameInfo } from './reliability/media.ts';

/**
 * Link import runs in its own Worker (cail-stem-import), reachable only through
 * the splitter's service binding. It owns every outbound request to a
 * user-supplied host, so the splitter never fetches arbitrary URLs itself.
 *
 * Native acquisition covers formats whose duration can be proven cheaply:
 * MP3 (full frame syntax), WAV and FLAC (header fields checked against the
 * byte count). Everything else answers `hosted: true` so the caller can use the
 * existing pinned ffmpeg fetcher; the native path never refuses a source the
 * hosted path would have accepted, except for limits both paths enforce.
 */

export const LINK_IMPORT_PATHS = { import: '/v1/import', resolve: '/v1/resolve' } as const;
/** mp3FrameInfo validates at most 24 MiB; WAV/FLAC need only their headers. */
const MP3_MAX_BYTES = 24 * 1024 * 1024;
const DECLARED_MAX_BYTES = 40 * 1024 * 1024;
const UNDECLARED_MAX_BYTES = 24 * 1024 * 1024;
const MIN_AUDIO_BYTES = 1024;
const MAX_REDIRECTS = 5;
const MAX_IMPORT_MS = 150_000;
const OEMBED_TIMEOUT_MS = 5_000;
const USER_AGENT = 'CAIL-Stem-Splitter/1.0 (+https://stem-splitter.ailab-452.workers.dev)';
/** Self-fetches would loop through the app's own routes. */
const BLOCKED_HOSTS = /(?:^|\.)(?:ailab-452\.workers\.dev|ailab\.gc\.cuny\.edu)$/i;
const KEY_PREFIX = /^uploads\/[0-9a-f-]{36}\/source-\d{1,9}$/;

export type ShareProvider = 'dropbox' | 'google-drive' | 'onedrive' | 'sharepoint';

export type LinkKind =
  | { kind: 'youtube'; videoId: string; canonicalUrl: string; title: string | null; author: string | null; query: string | null }
  | { kind: 'share'; provider: ShareProvider }
  | { kind: 'direct' }
  | { kind: 'retired'; provider: 'vimeo' }
  | { kind: 'invalid' };

export interface ImportRequest {
  url: string;
  /** Fenced object key without extension, chosen by the splitter. */
  keyPrefix: string;
  maximumSeconds: 300 | 900;
  /** Epoch milliseconds; the import stops at the earlier of this and its own budget. */
  deadline: number;
}

export type ImportResult =
  | { ok: true; key: string; bytes: number; sha256: string; durationSec: number; contentType: string; fileName: string; title: string }
  | { ok: false; code: string; message: string; retryable: boolean; hosted: boolean };

export interface LinkImportEnv {
  AUDIO: R2Bucket;
  /**
   * Hosts that resolve DNS themselves (the Node host) supply a fetch that
   * connects only to public addresses, checked inside the connection's own
   * lookup. Cloudflare Workers egress cannot reach private networks, so the
   * Worker uses the platform fetch.
   */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

class ImportFailure extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, readonly hosted = false) {
    super(message);
  }
}
const toHosted = (code: string) => new ImportFailure(code, 'This link needs the hosted importer.', false, true);

/** Rewrite a public share link to its direct-download form. Folders and
 * document editors are rejected: they never resolve to a single audio file. */
export function shareDownloadUrl(input: string): { provider: ShareProvider; url: string } | null {
  let url: URL;
  try { url = new URL(input); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (host === 'dropbox.com' || host === 'www.dropbox.com') {
    if (!/^\/(?:s|scl\/fi)\//.test(url.pathname)) throw new ImportFailure('share_link_unsupported', 'Share a single Dropbox file, not a folder.');
    url.searchParams.delete('raw');
    url.searchParams.set('dl', '1');
    return { provider: 'dropbox', url: url.href };
  }
  if (host === 'drive.google.com') {
    const id = /^\/file\/d\/([A-Za-z0-9_-]{20,})(?:\/|$)/.exec(url.pathname)?.[1]
      ?? (['/open', '/uc'].includes(url.pathname) ? url.searchParams.get('id') : null);
    if (!id || !/^[A-Za-z0-9_-]{20,}$/.test(id)) throw new ImportFailure('share_link_unsupported', 'Share a single Google Drive file, not a folder or document.');
    return { provider: 'google-drive', url: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t` };
  }
  if (host === '1drv.ms' || host === 'onedrive.live.com') {
    // OneDrive's documented share resolver: base64url of the original link.
    const encoded = btoa(url.href).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    return { provider: 'onedrive', url: `https://api.onedrive.com/v1.0/shares/u!${encoded}/root/content` };
  }
  if (host.endsWith('.sharepoint.com')) {
    url.searchParams.set('download', '1');
    return { provider: 'sharepoint', url: url.href };
  }
  return null;
}

/** Fetch with manual redirects; every hop must pass the same public-HTTPS rules. */
async function fetchPublic(raw: string, deadline: number, accept: string, send: NonNullable<LinkImportEnv['fetch']> = fetch): Promise<Response> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = parseMediaUrl(current);
    // A trailing dot names the same host ("example.org.") and would slip past suffix rules.
    const hostname = checked ? new URL(checked).hostname.toLowerCase() : '';
    if (!checked || hostname.endsWith('.') || BLOCKED_HOSTS.test(hostname)) {
      throw new ImportFailure(hop ? 'source_untrusted_redirect' : 'invalid_source_url',
        hop ? 'The link redirected to an address that cannot be imported.' : 'Paste a public HTTPS audio link.');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ImportFailure('source_timeout', 'The link took too long to respond.', true);
    let response: Response;
    try {
      response = await send(checked, { redirect: 'manual', headers: { Accept: accept, 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(remaining) });
    } catch (error) {
      const timedOut = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
      throw new ImportFailure(timedOut ? 'source_timeout' : 'source_unreachable', timedOut ? 'The link took too long to respond.' : 'The link could not be reached.', true);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location) break;
    try { current = new URL(location, checked).href; } catch { break; }
  }
  throw new ImportFailure('source_untrusted_redirect', 'The link redirected too many times.');
}

/** Short retries for rate limits and server errors, never past the deadline.
 * Each retry restarts at the original link, so a redirecting host can pick a
 * different mirror (archive.org mirrors return intermittent 500s). */
async function fetchWithRetry(url: string, deadline: number, accept: string, send?: LinkImportEnv['fetch']): Promise<Response> {
  const RETRIES = 2;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetchPublic(url, deadline, accept, send);
    } catch (error) {
      if (attempt < RETRIES && error instanceof ImportFailure && error.code === 'source_unreachable' && Date.now() + 1500 < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      throw error;
    }
    if (attempt >= RETRIES || ![429, 500, 502, 503, 504].includes(response.status)) return response;
    const retryAfter = Number(response.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (attempt + 1);
    if (waitMs > 3000 || Date.now() + waitMs + 1500 >= deadline) return response;
    await response.body?.cancel().catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
}

/** Single allocation when the length is declared; growth is capped lower otherwise. */
async function readCapped(response: Response, deadline: number, hostedWhenLarge: boolean): Promise<Uint8Array> {
  const header = response.headers.get('content-length');
  const declared = header !== null && /^\d+$/.test(header) ? Number(header) : null;
  const limit = declared === null ? UNDECLARED_MAX_BYTES : DECLARED_MAX_BYTES;
  const tooLarge = () => hostedWhenLarge ? toHosted('native_size_limit') : new ImportFailure('source_too_large', 'This file is too large to import. Upload it instead.');
  if (declared !== null && declared > limit) { await response.body?.cancel().catch(() => undefined); throw tooLarge(); }
  if (!response.body) return new Uint8Array(0);
  let buffer = new Uint8Array(declared ?? 1024 * 1024);
  let length = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ImportFailure('source_timeout', 'The download took too long.', true);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ImportFailure('source_timeout', 'The download took too long.', true)), remaining); }),
      ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
      if (chunk.done) break;
      if (length + chunk.value.byteLength > limit) throw tooLarge();
      if (length + chunk.value.byteLength > buffer.byteLength) {
        const grown = new Uint8Array(Math.min(limit, Math.max(buffer.byteLength * 2, length + chunk.value.byteLength)));
        grown.set(buffer.subarray(0, length));
        buffer = grown;
      }
      buffer.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ImportFailure) throw error;
    throw new ImportFailure('source_unreachable', 'The download was interrupted.', true);
  } finally {
    reader.releaseLock();
  }
  return buffer.subarray(0, length);
}

const ascii = (bytes: Uint8Array, offset: number, text: string) =>
  bytes.length >= offset + text.length && [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** RIFF/WAVE: duration from the data chunk and the fmt byte rate. */
export function wavDuration(bytes: Uint8Array): number | null {
  if (!ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WAVE')) return null;
  let offset = 12, byteRate = 0;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = u32(bytes, offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.length) return null;
      const format = u16(bytes, body), channels = u16(bytes, body + 2), sampleRate = u32(bytes, body + 4);
      const rate = u32(bytes, body + 8), blockAlign = u16(bytes, body + 12), bits = u16(bytes, body + 14);
      if (![1, 3, 0xfffe].includes(format) || channels < 1 || channels > 8 || sampleRate < 8000 || sampleRate > 192000
        || ![8, 16, 24, 32].includes(bits) || blockAlign !== channels * bits / 8 || rate !== sampleRate * blockAlign) return null;
      byteRate = rate;
    } else if (id === 'data') {
      // A complete file holds every declared sample; streaming sizes (0 or 0xFFFFFFFF) are not proof.
      if (!byteRate || size === 0 || body + size > bytes.length) return null;
      return size / byteRate;
    }
    offset = body + size + (size & 1);
  }
  return null;
}

/** FLAC: STREAMINFO total samples over sample rate, then a frame sync after the metadata. */
export function flacDuration(bytes: Uint8Array): number | null {
  // The first metadata block must be a 34-byte STREAMINFO (type 0).
  if (!ascii(bytes, 0, 'fLaC') || bytes.length < 42 || (bytes[4] & 0x7f) !== 0 || bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 34) return null;
  const info = 8;
  const sampleRate = (bytes[info + 10] << 12) | (bytes[info + 11] << 4) | (bytes[info + 12] >> 4);
  const low = ((bytes[info + 14] << 24) | (bytes[info + 15] << 16) | (bytes[info + 16] << 8) | bytes[info + 17]) >>> 0;
  const total = (bytes[info + 13] & 0x0f) * 2 ** 32 + low;
  if (sampleRate < 8000 || sampleRate > 192000 || total === 0) return null;
  let offset = 4;
  while (offset + 4 <= bytes.length) {
    const last = bytes[offset] & 0x80;
    offset += 4 + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]);
    if (last) break;
  }
  if (offset + 2 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xfe) !== 0xf8) return null;
  return total / sampleRate;
}

type Inspected = { format: 'mp3' | 'wav' | 'flac'; durationSec: number };

/** Prove format and duration, or say which importer should try instead. */
export function inspectAudio(bytes: Uint8Array): Inspected {
  if (bytes.length < MIN_AUDIO_BYTES) throw new ImportFailure('invalid_audio_response', 'The link returned no usable audio.');
  if (ascii(bytes, 0, 'RIFF')) {
    const durationSec = wavDuration(bytes);
    if (durationSec === null) throw toHosted('wav_unproven');
    return { format: 'wav', durationSec };
  }
  if (ascii(bytes, 0, 'fLaC')) {
    const durationSec = flacDuration(bytes);
    if (durationSec === null) throw toHosted('flac_unproven');
    return { format: 'flac', durationSec };
  }
  const mpeg = ascii(bytes, 0, 'ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (mpeg) {
    if (bytes.length > MP3_MAX_BYTES) throw toHosted('native_size_limit');
    const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    const frames = mp3FrameInfo(exact ? bytes.buffer as ArrayBuffer : bytes.slice().buffer);
    // Trailing tags or junk defeat strict frame parsing; ffmpeg tolerates them.
    if (!frames) throw toHosted('mp3_unproven');
    return { format: 'mp3', durationSec: frames.seconds };
  }
  // M4A/MP4, Ogg, WebM, AIFF and web pages are left to the ffmpeg importer.
  throw toHosted('format_not_native');
}

const looksLikeHtml = (bytes: Uint8Array, contentType: string) =>
  contentType.includes('html') || /^\s*</.test(new TextDecoder().decode(bytes.subarray(0, 64)));

function sourceTitle(response: Response, url: string): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition)?.[1];
  let name = '';
  try { name = star ? decodeURIComponent(star) : plain ?? decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''); } catch { name = plain ?? ''; }
  return name.replace(/\.[A-Za-z0-9]{2,5}$/, '').replace(/[\x00-\x1f\x7f/\\]/g, ' ').replace(/[_+]+/g, ' ').trim().slice(0, 200) || 'Imported audio';
}

const CONTENT_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac' } as const;

export async function importLink(env: LinkImportEnv, request: ImportRequest): Promise<ImportResult> {
  try {
    if (!KEY_PREFIX.test(request.keyPrefix)) throw new ImportFailure('invalid_request', 'Import key was not issued by the splitter.');
    if (request.maximumSeconds !== 300 && request.maximumSeconds !== 900) throw new ImportFailure('invalid_request', 'Import limit is missing.');
    const checked = parseMediaUrl(request.url);
    if (!checked) throw new ImportFailure('invalid_source_url', 'Paste a public HTTPS audio link.');
    const video = parseVideoSource(checked);
    if (video) throw toHosted(`${video.sourceType}_link`);
    const share = shareDownloadUrl(checked);
    const deadline = Math.min(request.deadline, Date.now() + MAX_IMPORT_MS);
    const response = await fetchWithRetry(share?.url ?? checked, deadline, 'audio/*,application/octet-stream;q=0.9,*/*;q=0.5', env.fetch);
    if (response.status !== 200 || response.headers.has('content-range')) {
      await response.body?.cancel().catch(() => undefined);
      if (share && [401, 403, 404].includes(response.status)) throw new ImportFailure('share_link_not_public', 'This share link is not public. Set it to "Anyone with the link" or upload the file.');
      if ([401, 403].includes(response.status)) throw new ImportFailure('source_denied', 'The site refused this download. Upload the file instead.');
      if ([404, 410].includes(response.status)) throw new ImportFailure('source_not_found', 'Nothing was found at that link.');
      throw new ImportFailure('source_unavailable', 'The site could not provide the file right now.', response.status >= 500 || response.status === 429);
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if ((contentType === 'audio/mpeg' || /\.mp3$/i.test(new URL(checked).pathname)) && declared > MP3_MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw toHosted('native_size_limit');
    }
    const bytes = await readCapped(response, deadline, true);
    if (looksLikeHtml(bytes, contentType)) {
      if (share) throw new ImportFailure('share_link_not_public', 'This share link opened a web page instead of a file. Set it to "Anyone with the link" or upload the file.');
      throw toHosted('web_page');
    }
    const audio = inspectAudio(bytes);
    if (audio.durationSec > request.maximumSeconds + 0.1) {
      throw new ImportFailure('source_too_long', `Audio exceeds your ${request.maximumSeconds / 60}-minute import limit.`);
    }
    const key = `${request.keyPrefix}.${audio.format}`;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    await env.AUDIO.put(key, bytes, { httpMetadata: { contentType: CONTENT_TYPES[audio.format] } });
    return { ok: true, key, bytes: bytes.byteLength, sha256, durationSec: audio.durationSec, contentType: CONTENT_TYPES[audio.format],
      fileName: `source.${audio.format}`, title: sourceTitle(response, checked) };
  } catch (error) {
    if (error instanceof ImportFailure) return { ok: false, code: error.code, message: error.message, retryable: error.retryable, hosted: error.hosted };
    console.error(JSON.stringify({ event: 'link_import_unexpected', name: error instanceof Error ? error.name : typeof error }));
    return { ok: false, code: 'link_import_failed', message: 'The link could not be imported. Upload the file instead.', retryable: true, hosted: false };
  }
}

/** Upload labels that describe the video, not the recording. */
const VIDEO_LABEL = /\b(?:official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|remaster(?:ed)?|mv|m\/v|explicit|colou?ri[sz]ed|restored|high quality|full (?:song|version)|audio only)\b/i;
/** Release variants: they name a pressing or take, not a different song. */
const VARIANT = /\b(?:mono|stereo|single version|radio edit|original version|version|\d{4} mix)\b/i;
const DASH = /\s+[-–—]\s+/;
const tidy = (value: string) => value.replace(/\s+/g, ' ').replace(/^[\s\-–—|:,.]+|[\s\-–—|:,.]+$/g, '').trim();
const global = (pattern: RegExp) => new RegExp(pattern.source, 'gi');
/** True when nothing but labels, variants, years and filler words remain. */
const labelOnly = (segment: string) =>
  !tidy(segment.replace(global(VIDEO_LABEL), ' ').replace(global(VARIANT), ' ').replace(/\b(?:\d{4}|from|the|in|music|new|full)\b/gi, ' '));

/** Channel names: drop "- Topic", VEVO and label words; split run-together VEVO names.
 * A run-together handle with digits ("reptileman117") is an uploader, not an artist. */
function channelArtist(author: string | null): { artist: string; topic: boolean } {
  let name = (author ?? '').trim();
  const topic = / - Topic$/i.test(name);
  name = name.replace(/ - Topic$/i, '').replace(/vevo$/i, '').replace(/^official(?=[a-z])/i, '').trim();
  if (!/\s/.test(name)) {
    if (/\d/.test(name) && /[a-z]{3}/i.test(name) && !topic) return { artist: '', topic };
    name = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  }
  while (/\s(?:official|music|records|recordings|tv|channel)$/i.test(name)) name = name.replace(/\s+\S+$/, '');
  return { artist: tidy(name), topic };
}

/** Titles: keep the recording's name, drop video labels, featured artists, tags and pipes. */
function cleanTitle(title: string): string {
  let text = title.split(/\s(?:\||\/\/)\s/)[0]
    .replace(/#\w+/g, ' ')
    .replace(/["“”«»]/g, '')
    // Bracketed labels and variants go; other brackets ("Live Aid 1985", "강남스타일") keep their words.
    .replace(/\s*[([{【]([^)\]}】]*)[)\]}】]/g, (_, inner: string) =>
      VIDEO_LABEL.test(inner) || VARIANT.test(inner) || /^\s*(?:feat\.?|ft\.?|featuring)\s/i.test(inner) ? ' ' : ` ${inner} `)
    // Featured artists run to the next dash or the end.
    .replace(/\s(?:feat\.?|ft\.?|featuring)\s[^-–—]*/gi, ' ');
  // Unbracketed trailing labels: "… Official Music Video", "… M/V".
  let words = tidy(text).split(' ');
  while (words.length > 1 && /^(?:official|music|lyric|lyrics|video|audio|hd|hq|4k|mv|m\/v|visuali[sz]er)$/i.test(words[words.length - 1])) words.pop();
  // Trailing " - Remastered 2011" segments describe a release, not a song.
  const parts = words.join(' ').split(DASH);
  while (parts.length > 1 && labelOnly(parts[parts.length - 1])) parts.pop();
  return tidy(parts.join(' - '));
}

/**
 * Turn a YouTube title and channel into an Internet Archive search query.
 *
 * Inputs come from YouTube oEmbed: `title` is the video title as uploaded and
 * `author` is the channel name. Archive song search matches terms, so fewer,
 * sharper words beat a faithful copy of the title. Returns null when nothing
 * useful remains.
 */
export function youtubeSearchQuery(title: string | null, author: string | null): string | null {
  const song = title ? cleanTitle(title) : '';
  const { artist, topic } = channelArtist(author);
  let query: string;
  if (!topic && DASH.test(song)) {
    // "Artist - Song" already names the artist; the channel name would only duplicate it.
    query = song.split(DASH).join(' ');
  } else {
    // Auto-generated "Topic" titles put the release descriptor after the dash ("- Live At …").
    const name = topic ? song.split(DASH)[0] : song.replace(DASH, ' ');
    const known = artist && name.toLowerCase().includes(artist.toLowerCase());
    query = [known ? '' : artist, name].filter(Boolean).join(' ');
  }
  query = tidy(query);
  if (!query) return null;
  return query.length <= 120 ? query : query.slice(0, 120).replace(/\s+\S*$/, '');
}

const clean = (value: unknown) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 300) || null : null;

/** Classify a pasted link; YouTube links are resolved to metadata only, never audio. */
export async function resolveLink(input: unknown): Promise<LinkKind> {
  const checked = parseMediaUrl(input);
  if (!checked) return { kind: 'invalid' };
  const video = parseVideoSource(checked);
  if (video?.sourceType === 'vimeo') return { kind: 'retired', provider: 'vimeo' };
  if (video?.sourceType === 'youtube') {
    let title: string | null = null, author: string | null = null;
    try {
      const response = await fetchPublic(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(video.canonicalUrl)}`,
        Date.now() + OEMBED_TIMEOUT_MS, 'application/json');
      if (response.ok) {
        const body = await readCapped(response, Date.now() + OEMBED_TIMEOUT_MS, false);
        const data = JSON.parse(new TextDecoder().decode(body)) as { title?: unknown; author_name?: unknown };
        title = clean(data.title); author = clean(data.author_name);
      } else await response.body?.cancel().catch(() => undefined);
    } catch {
      // Private, removed or unembeddable videos still get the search-and-upload path.
    }
    return { kind: 'youtube', videoId: video.id, canonicalUrl: video.canonicalUrl, title, author, query: youtubeSearchQuery(title, author) };
  }
  try {
    const share = shareDownloadUrl(checked);
    if (share) return { kind: 'share', provider: share.provider };
  } catch {
    return { kind: 'invalid' };
  }
  return { kind: 'direct' };
}

/** The Worker's whole HTTP surface; it has no public route, only the service binding. */
export async function handleLinkImportRequest(request: Request, env: LinkImportEnv): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method !== 'POST' || !Object.values(LINK_IMPORT_PATHS).includes(path as typeof LINK_IMPORT_PATHS.import)) {
    return new Response('Not found', { status: 404 });
  }
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 8192) throw new Error('too large');
    body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
  } catch {
    return Response.json({ ok: false, code: 'invalid_request', message: 'Malformed import request.', retryable: false, hosted: false }, { status: 400 });
  }
  if (path === LINK_IMPORT_PATHS.resolve) return Response.json(await resolveLink(body.url));
  return Response.json(await importLink(env, {
    url: String(body.url ?? ''), keyPrefix: String(body.keyPrefix ?? ''),
    maximumSeconds: body.maximumSeconds as 300 | 900, deadline: Number(body.deadline) || Date.now(),
  }));
}
