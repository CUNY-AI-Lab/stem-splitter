import { readBoundedResponse, responseMediaType } from './http/bounded-response.ts';
import { mp3FrameInfo } from './reliability/media.ts';

const API = 'https://api.audius.co/v1';
const MAX_AUDIO = 12 * 1024 * 1024;
const clean = (value: unknown, limit = 200) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
export const validAudiusId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9]{1,32}$/.test(value);
export class AudiusError extends Error {
  code: string;
  constructor(code: string, message = 'This song is unavailable. Choose another song or upload an audio file.') { super(message); this.code=code; }
}
export interface AudiusTrack {
  id: string; title: string; artist: string; durationSec: number; sourceUrl: string; licenseUrl: string;
}
const error = (code = 'music_unavailable') => new AudiusError(code);
const licenseUrl = (value: unknown) => {
  const code = /\bCC\s*(BY(?:-NC)?(?:-SA)?|0)\b/i.exec(clean(value))?.[1].toLowerCase();
  return code === '0' ? 'https://creativecommons.org/publicdomain/zero/1.0/'
    : code ? `https://creativecommons.org/licenses/${code}/4.0/` : '';
};
function track(value: any): AudiusTrack | null {
  if (!value || !validAudiusId(value.id) || value.is_available !== true || value.is_streamable !== true
    || value.is_stream_gated !== false || value.access?.stream !== true || value.is_delete || value.is_unlisted
    || !Number.isFinite(value.duration) || value.duration <= 0 || value.duration > 900
    || /NoDerivs|\bND\b/i.test(clean(value.license))) return null;
  const title = clean(value.title), artist = clean(value.user?.name);
  const path = clean(value.permalink, 500);
  if (!title || !artist || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.%-]+$/.test(path) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path)) return null;
  return { id: value.id, title, artist, durationSec: value.duration, sourceUrl: `https://audius.co${path}`, licenseUrl: licenseUrl(value.license) };
}
async function read(response: Response, maximumBytes: number, deadline: number) {
  const timeoutMs = Math.floor(deadline - Date.now());
  if (timeoutMs <= 0) { await response.body?.cancel(); throw error(); }
  const bytes = await readBoundedResponse(response, { maximumBytes, timeoutMs,
    errors: { tooLarge: () => new AudiusError('music_too_large', 'Choose a smaller song or upload its audio file.'), timedOut: error, unreadable: error } });
  const length = response.headers.get('content-length');
  if (length && !response.headers.get('content-encoding') && Number(length) !== bytes.byteLength) throw error('music_incomplete');
  return bytes;
}
async function json(path: string, deadline: number) {
  const response = await fetch(API + path, { redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
  if (response.status !== 200 || responseMediaType(response) !== 'application/json') { await response.body?.cancel(); throw error('music_api_unavailable'); }
  try { return JSON.parse(new TextDecoder().decode(await read(response, 2 * 1024 * 1024, deadline))); }
  catch { throw error(); }
}
export async function searchAudius(query: string): Promise<{ results: AudiusTrack[] }> {
  const term = clean(query, 120);
  if (term.length < 2) return { results: [] };
  const data = await json('/tracks/search?' + new URLSearchParams({ query: term, limit: '16' }), Date.now() + 15000);
  if (!Array.isArray(data.data)) throw error();
  return { results: data.data.slice(0, 16).map(track).filter((value: AudiusTrack | null): value is AudiusTrack => value !== null).slice(0, 8) };
}
function publicUrl(value: unknown): URL | null {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) || /(?:^|\.)(localhost|local|internal|test|example|invalid)$/i.test(url.hostname)) return null;
    return url;
  } catch { return null; }
}
export async function fetchAudiusAudio(id: string, options: { deadline: number; validate?: (data: ArrayBuffer) => Promise<boolean> }) {
  if (!validAudiusId(id)) throw new AudiusError('invalid_music_id');
  const deadline = Math.min(options.deadline, Date.now() + 90000);
  const metadata = await json(`/tracks/${id}`, deadline);
  const raw = metadata.data, selected = track(raw);
  if (!selected || selected.id !== id) throw error('music_metadata_unavailable');
  // Only a fresh provider response can select a content node. Browser-supplied
  // media addresses, preview URLs, purchases and gated playback are never used.
  const hosts = new Set<string>(['api.audius.co','creatornode.audius.co']);
  for (const value of [raw.stream?.url, ...(Array.isArray(raw.stream?.mirrors) ? raw.stream.mirrors.slice(0, 8) : [])]) {
    const url = publicUrl(value); if (url) hosts.add(url.hostname);
  }
  // The API stream route may choose a different node on every request. Use the
  // full stream address in this exact metadata response to keep both connected.
  let url = publicUrl(raw.stream?.url);
  if (!url) throw error('music_stream_missing');
  for (let hop = 0; hop < 4; hop++) {
    const remaining = Math.floor(deadline - Date.now());
    if (remaining <= 0) throw error();
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(remaining) });
    if ([301,302,303,307,308].includes(response.status)) {
      const next = publicUrl(response.headers.get('location'));
      await response.body?.cancel();
      // Audius content nodes also deliver their public files through R2.
      // Only this provider-selected redirect can use that storage origin.
      if (!next || !(hosts.has(next.hostname) || /^[a-z0-9-]+\.[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(next.hostname))) throw error('music_redirect_rejected');
      url = next; continue;
    }
    if (response.status !== 200 || response.headers.has('content-range')
      || !['audio/mpeg','audio/mp3','application/octet-stream'].includes(responseMediaType(response))) {
      await response.body?.cancel(); throw error([401,403,451].includes(response.status)?'music_source_denied':'music_stream_invalid');
    }
    const data = await read(response, MAX_AUDIO, deadline), bytes = new Uint8Array(data);
    if (bytes.length < 1024 || !(bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
      || options.validate && !await options.validate(data)) throw error('music_audio_invalid');
    const frames=mp3FrameInfo(data);
    if (!frames || Math.abs(frames.seconds-selected.durationSec)>1) throw error('music_incomplete');
    return { data, title: `${selected.title} — ${selected.artist}`.slice(0, 200), durationSec: selected.durationSec, fileName: 'source.mp3',
      attribution: { title: selected.title, creator: selected.artist, sourceUrl: selected.sourceUrl, licenseUrl: selected.licenseUrl, fileName: 'source.mp3' } };
  }
  throw error();
}
