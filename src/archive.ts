// Internet Archive search and audio import, behind the fetchArchiveAudio() seam.
//
// Unlike the YouTube path this needs no third-party fetcher: archive.org serves
// public audio over HTTPS without a bot-check, so a direct provider fetch is
// the whole story (and costs nothing per import).
//
// Public song search verifies downloadable MP3s; the separate Crate and remix
// paths retain their open-license floor. Boundaries are enforced here:
//   - the search query is assembled server-side so students can never widen it
//     past open-licensed audio (see buildQuery), and
//   - Crate imports repeat that open-license check and exclude
//     NoDerivatives (ND), because stems are a derivative work; and
//   - provider redirects, response sizes, read times, and audio signatures are
//     bounded before any bytes are stored.
import type { Env } from './env';
import { readBoundedResponse, responseMediaType } from './http/bounded-response.ts';
import { mp3FrameInfo } from './reliability/media.ts';

// Crate-specific cap, tighter than the 15-minute YouTube/upload limit: the
// browse list only offers songs, and nothing over 5 minutes is shown or
// importable through it. Enforced here (not just in the UI) so a crafted API
// call cannot import past it.
const MAX_DURATION_SECONDS = 5 * 60;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const MIN_AUDIO_BYTES = 1024;
export const ARCHIVE_SEARCH_MAX_BYTES = 12 * 1024 * 1024;
const PUBLIC_AUDIO_MAX_SECONDS = 15 * 60;
const SEARCH_ROWS = 24;
const MAX_SEARCH_PAGE = 20;
const MAX_TERM_LENGTH = 120;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const JSON_FETCH_TIMEOUT_MS = 20 * 1000;
const AUDIO_FETCH_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_REDIRECTS = 3;
const MAX_METADATA_FILES = 10_000;
const MAX_FILE_NAME_LENGTH = 512;

const SEARCH_API = 'https://archive.org/advancedsearch.php';
const METADATA_API = 'https://archive.org/metadata';
const DOWNLOAD_BASE = 'https://archive.org/download';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Open-licence floor: CC or public domain, minus every NoDerivatives variant.
 * Two ND exclusions because CC v1.0 licences used bare "nd" / "nd-nc" path
 * segments (licenses/nd/1.0, licenses/nd-nc/1.0) that the *-nd* infix misses —
 * 98 such items were live in the scoped collections when this was written.
 */
const LICENSE_FILTER =
  'licenseurl:(*creativecommons* OR *publicdomain*) AND NOT licenseurl:*-nd* AND NOT licenseurl:*licenses\\/nd*';

/**
 * True when any licence module is NoDerivatives. Parses the licence code out
 * of the URL path and checks its "-"-separated modules, so by-nc-nd, by-nd,
 * nd-nc and bare nd all refuse regardless of ordering or licence version.
 */
function licenseForbidsDerivatives(url: string): boolean {
  const match = /licen[cs]es\/([a-z-]+)(\/|$)/i.exec(url);
  return match ? match[1].toLowerCase().split('-').includes('nd') : false;
}

function isOpenLicenseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    host !== 'creativecommons.org' ||
    url.username ||
    url.password
  ) {
    return false;
  }
  return (
    /^\/licenses\/[a-z-]+\/[0-9.]+(?:\/|$)/i.test(url.pathname) ||
    /^\/publicdomain\/(zero|mark)\/[0-9.]+(?:\/|$)/i.test(url.pathname)
  );
}

/**
 * Collection scopes offered to the UI. `music` is the curated default;
 * `all` widens to the general open-audio pool (which mixes in spoken word,
 * radio and podcasts, so it is opt-in).
 */
export const ARCHIVE_SCOPES = {
  music: {
    label: 'Music',
    collections: ['netlabels', 'audio_music'],
  },
  all: {
    label: 'All open audio',
    collections: ['netlabels', 'audio_music', 'opensource_audio'],
  },
} as const;

export type ArchiveScope = keyof typeof ARCHIVE_SCOPES;

export function isArchiveScope(value: unknown): value is ArchiveScope {
  return typeof value === 'string' && Object.hasOwn(ARCHIVE_SCOPES, value);
}

/** Errors safe to show to students verbatim. */
export class ArchiveError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code = 'archive_fetch_failed', retryable = false) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ArchiveAudio {
  data: ArrayBuffer;
  title: string;
  durationSec: number;
  attribution: { title: string; creator: string; sourceUrl: string; licenseUrl: string; fileName: string; itemTitle?: string; itemCreator?: string; fileCreator?: string };
}

export interface ArchiveSearchResult {
  identifier: string;
  title: string;
  creator: string;
  year: number | null;
  license: string;
  licenseUrl: string;
  downloads: number;
}

export interface ArchiveTrack {
  name: string;
  title: string;
  durationSec: number;
  bytes: number;
  artist?: string;
  creator?: string;
  /** False when the track breaks the duration or size cap; UI greys these out. */
  importable: boolean;
}

export interface ArchiveItem {
  identifier: string;
  title: string;
  creator: string;
  description?: string;
  year: number | null;
  license: string;
  licenseUrl: string;
  detailsUrl: string;
  tracks: ArchiveTrack[];
}

/**
 * Accepts a bare identifier or any archive.org item URL
 * (`/details/<id>`, `/download/<id>/…`, `/metadata/<id>`).
 */
export function parseArchiveIdentifier(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  if (IDENTIFIER_PATTERN.test(raw)) return raw;

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!/(^|\.)archive\.org$/i.test(u.hostname)) return null;

  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  if (!['details', 'download', 'metadata', 'embed'].includes(parts[0])) return null;

  let identifier: string;
  try {
    identifier = decodeURIComponent(parts[1]);
  } catch {
    return null;
  }
  return IDENTIFIER_PATTERN.test(identifier) ? identifier : null;
}

/**
 * Builds the Lucene query. User text is reduced to quoted terms so it cannot
 * introduce operators or fields and escape the licence/collection floor.
 */
function buildQuery(term: string, scope: ArchiveScope): string {
  const collections = ARCHIVE_SCOPES[scope].collections
    .map((name) => `collection:${name}`)
    .join(' OR ');

  const clauses = [`mediatype:audio`, `(${collections})`, LICENSE_FILTER];

  const tokens = term
    .slice(0, MAX_TERM_LENGTH)
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}'&._-]/gu, ''))
    .filter((token) => token.length > 0)
    .slice(0, 8);

  if (tokens.length > 0) {
    clauses.push(`(${tokens.map((token) => `"${token}"`).join(' AND ')})`);
  }

  return clauses.join(' AND ');
}

/** `…/licenses/by-nc-sa/4.0/` → `CC BY-NC-SA 4.0`. */
function licenseLabel(url: string | undefined): string {
  if (!url) return 'Open licence';
  if (/publicdomain\/zero/i.test(url)) return 'CC0 1.0';
  if (/publicdomain\/mark/i.test(url)) return 'Public Domain';

  const match = /licenses\/([a-z-]+)\/([0-9.]+)/i.exec(url);
  if (!match) return 'Creative Commons';
  return `CC ${match[1].toUpperCase()} ${match[2]}`;
}

function firstString(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

function displayText(value: unknown, fallback = '', maximum = 300): string {
  return (
    firstString(value)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, maximum) || fallback
  );
}

function toYear(value: unknown): number | null {
  const year = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(year) && year > 1800 && year < 2200 ? year : null;
}

/** IA `length` is usually seconds ("540.03") but sometimes "MM:SS" / "HH:MM:SS". */
function parseLength(value: unknown): number {
  const raw = String(value ?? '').trim();
  if (!raw) return 0;

  if (raw.includes(':')) {
    const parts = raw.split(':').map((part) => Number.parseFloat(part));
    if (parts.some((part) => !Number.isFinite(part))) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  const seconds = Number.parseFloat(raw);
  return Number.isFinite(seconds) ? seconds : 0;
}

const FETCH_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 3000];

function approvedArchiveUrl(raw: string | URL): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    (hostname !== 'archive.org' && !hostname.endsWith('.archive.org')) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    return null;
  }
  return url;
}

async function fetchArchiveOnce(
  rawUrl: string,
  timeoutMs: number,
  headers: Record<string, string> = {}
): Promise<Response> {
  let url = approvedArchiveUrl(rawUrl);
  if (!url) {
    throw new ArchiveError('Internet Archive returned an unapproved address.', 'archive_untrusted_url');
  }

  const deadline = Date.now() + timeoutMs;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new DOMException('Archive fetch timed out', 'TimeoutError');
    const response = await fetch(url, {
      headers: { Accept: '*/*', ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(remainingMs),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirects === MAX_REDIRECTS) {
      throw new ArchiveError(
        'Internet Archive redirected too many times.',
        'archive_untrusted_redirect',
        true
      );
    }
    let redirected: URL | null = null;
    try {
      redirected = approvedArchiveUrl(new URL(location, url));
    } catch {
      // Leave null; malformed provider redirects fail closed below.
    }
    if (!redirected) {
      throw new ArchiveError(
        'Internet Archive returned an unapproved download address.',
        'archive_untrusted_redirect',
        true
      );
    }
    url = redirected;
  }

  throw new ArchiveError('Internet Archive redirected too many times.', 'archive_untrusted_redirect');
}

/**
 * archive.org's frontends intermittently return 429/5xx under load — observed
 * live at roughly 1-in-5 downloads during evaluation — so every archive fetch
 * gets a short bounded retry rather than failing the student's import on the
 * first blip.
 */
async function fetchWithBusyRetry(
  url: string,
  label: string,
  timeoutMs: number,
  attemptTimeoutMs = timeoutMs
): Promise<{ response: Response; deadline: number }> {
  let lastNetworkError: unknown;
  let sawBusy = false;
  let lastStatus = 0, lastContentType = '';
  const deadline = Date.now() + timeoutMs;

  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delayMs = RETRY_DELAYS_MS[attempt - 1];
      if (Date.now() + delayMs >= deadline) break;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const res = await fetchArchiveOnce(url, Math.min(remainingMs, attemptTimeoutMs));
      if (res.status === 429 || res.status >= 500) {
        sawBusy = true;
        lastStatus = res.status; lastContentType = responseMediaType(res);
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      return { response: res, deadline };
    } catch (err) {
      if (err instanceof ArchiveError && err.code.startsWith('archive_untrusted')) throw err;
      lastNetworkError = err;
      console.error(`archive ${label} network error (attempt ${attempt + 1})`, {
        name: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  if (sawBusy) {
    archiveFailure(label, 'upstream_busy', lastStatus, lastContentType);
    throw new ArchiveError(
      'The Internet Archive is busy. Try again in a moment.',
      'archive_busy',
      true
    );
  }
  console.error(`archive ${label} unreachable`, {
    name: lastNetworkError instanceof Error ? lastNetworkError.name : 'unknown',
  });
  throw new ArchiveError(
    'Could not reach the Internet Archive. Try again in a moment.',
    'archive_unreachable',
    true
  );
}

function archiveFailure(stage: string, reason: string, status?: number, contentType?: string) {
  console.warn('archive_fetch_diagnostic', {
    stage: ['search', 'metadata', 'audio'].includes(stage) ? stage : 'source',
    reason, status,
    contentType: contentType === undefined ? undefined
      : ['application/json', 'text/html', 'audio/mpeg', 'application/octet-stream'].includes(contentType) ? contentType : 'other',
  });
}

async function remainingArchiveBodyBudget(
  response: Response,
  deadline: number,
  timedOut: () => ArchiveError
): Promise<number> {
  const remainingMs = deadline - Date.now();
  if (remainingMs > 0) return remainingMs;
  await response.body?.cancel().catch(() => undefined);
  throw timedOut();
}

async function fetchJson(url: string, label: string, timeoutMs = JSON_FETCH_TIMEOUT_MS, attemptTimeoutMs = timeoutMs): Promise<unknown> {
  const { response: res, deadline } = await fetchWithBusyRetry(
    url,
    label,
    timeoutMs,
    attemptTimeoutMs
  );
  if (!res.ok) {
    archiveFailure(label, 'http_error', res.status, responseMediaType(res));
    await res.body?.cancel().catch(() => undefined);
    throw new ArchiveError(`Internet Archive ${label} failed (${res.status}).`);
  }
  if (responseMediaType(res) !== 'application/json') {
    archiveFailure(label, 'unexpected_content_type', res.status, responseMediaType(res));
    await res.body?.cancel().catch(() => undefined);
    throw new ArchiveError(`Internet Archive ${label} returned an unreadable response.`);
  }
  const unreadable = () =>
    new ArchiveError(`Internet Archive ${label} returned an unreadable response.`);
  const timedOut = () =>
    new ArchiveError(`Internet Archive ${label} timed out.`, 'archive_busy', true);
  const bytes = await readBoundedResponse(res, {
    maximumBytes: MAX_JSON_BYTES,
    timeoutMs: await remainingArchiveBodyBudget(res, deadline, timedOut),
    errors: {
      tooLarge: () => new ArchiveError(`Internet Archive ${label} response was too large.`),
      timedOut,
      unreadable,
    },
  }).catch(error => {
    archiveFailure(label, error instanceof ArchiveError && error.retryable ? 'body_timeout' : 'unreadable_body', res.status, responseMediaType(res));
    throw error;
  });
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    );
  } catch {
    archiveFailure(label, 'invalid_json', res.status, responseMediaType(res));
    throw unreadable();
  }
}

export async function searchArchive(
  term: string,
  scope: ArchiveScope,
  page: number
): Promise<{ results: ArchiveSearchResult[]; total: number; page: number }> {
  const safePage = Math.min(Math.max(Math.trunc(page) || 1, 1), MAX_SEARCH_PAGE);

  const url = new URL(SEARCH_API);
  url.searchParams.set('q', buildQuery(term, scope));
  for (const field of ['identifier', 'title', 'creator', 'licenseurl', 'year', 'downloads']) {
    url.searchParams.append('fl[]', field);
  }
  // Popularity is the least-bad relevance proxy here and keeps the first page
  // of a broad query (e.g. "piano") on things students can actually use.
  url.searchParams.append('sort[]', 'downloads desc');
  url.searchParams.set('rows', String(SEARCH_ROWS));
  url.searchParams.set('page', String(safePage));
  url.searchParams.set('output', 'json');

  const payload = await fetchJson(url.toString(), 'search');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ArchiveError('Internet Archive search returned an unreadable response.');
  }
  const response = (payload as Record<string, unknown>).response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new ArchiveError('Internet Archive search returned an unreadable response.');
  }
  const rawDocs = (response as Record<string, unknown>).docs;
  const rawTotal = (response as Record<string, unknown>).numFound;
  if (!Array.isArray(rawDocs)) {
    throw new ArchiveError('Internet Archive search returned an unreadable response.');
  }
  const docs = rawDocs
    .filter(
      (doc): doc is Record<string, unknown> =>
        Boolean(doc) && typeof doc === 'object' && !Array.isArray(doc)
    )
    .slice(0, SEARCH_ROWS);
  const total = Number(rawTotal);
  return {
    page: safePage,
    total: Number.isSafeInteger(total) && total >= 0 ? total : 0,
    results: docs
      .filter((doc) => {
        const identifier = typeof doc.identifier === 'string' ? doc.identifier : '';
        const licenseUrl = firstString(doc.licenseurl);
        return (
          IDENTIFIER_PATTERN.test(identifier) &&
          isOpenLicenseUrl(licenseUrl) &&
          !licenseForbidsDerivatives(licenseUrl)
        );
      })
      .map((doc) => {
        const licenseUrl = firstString(doc.licenseurl);
        const identifier = String(doc.identifier);
        return {
          identifier,
          title: displayText(doc.title, identifier),
          creator: displayText(doc.creator),
          year: toYear(doc.year),
          license: licenseLabel(licenseUrl),
          licenseUrl,
          downloads:
            Number.isSafeInteger(Number(doc.downloads)) && Number(doc.downloads) >= 0
              ? Number(doc.downloads)
              : 0,
        };
      }),
  };
}

export interface ArchiveSong {
  id: string;
  archiveId: string;
  archiveFile: string;
  title: string;
  artist: string;
  fileCreator: string;
  itemCreator: string;
  itemDescription: string;
  durationSec: number;
  bytes: number;
  sourceUrl: string;
  itemTitle: string;
}

function songTitle(item: ArchiveItem, track: ArchiveTrack): string {
  return item.tracks.length === 1 && /^(?:file|track|audio)[\s._-]*\d*$/i.test(track.title) ? item.title : track.title;
}
function recordingCredit(value: string | undefined): string {
  return value && !/^(artist|unknown|unknown artist|various artists)$/i.test(value) ? value : '';
}

function itemDescription(value: unknown): string {
  const plain = firstString(value).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
  return plain.length > 120 ? `${plain.slice(0, 117)}…` : plain;
}

export function archiveAudioMetadata(item: ArchiveItem, track: ArchiveTrack, publicAudio = false): Pick<ArchiveAudio, 'title' | 'attribution'> & { fileName: string } {
  const trackTitle = publicAudio ? songTitle(item, track) : track.title;
  return {
    title: publicAudio
      ? `${trackTitle}${item.title !== trackTitle ? ` - Archive item: ${item.title}` : ''}`
      : `${item.creator ? `${item.creator} - ` : ''}${trackTitle}`,
    fileName: track.name,
    attribution: { title: trackTitle, creator: publicAudio ? recordingCredit(track.artist) : item.creator,
      ...(publicAudio ? { itemTitle: item.title, itemCreator: item.creator, fileCreator: recordingCredit(track.creator) } : {}),
      sourceUrl: item.detailsUrl, licenseUrl: item.licenseUrl, fileName: track.name },
  };
}

const searchableText = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const alternateRecording = /\b(cover|covers|tribute|karaoke|remix|mash\s?up|instrumental|isolated|acappella|acapella|recreation|multitracks?)\b/;
const alternateDescription = /\b(cover version|cover of|my cover|karaoke|isolated vocals|multitracks?|recreation|remix of)\b/;
const searchCache = new Map<string, { expires: number; songs: Promise<{ results: ArchiveSong[] }> }>();

/** Check public file delivery before exposing a choice; import repeats metadata and reads the complete file. */
async function downloadableSong(song: ArchiveSong): Promise<boolean> {
  const res = await fetchArchiveOnce(
    `${DOWNLOAD_BASE}/${encodeURIComponent(song.archiveId)}/${encodeURIComponent(song.archiveFile)}`,
    7000, { Range: 'bytes=0-65535' }
  );
  const mediaType = responseMediaType(res);
  const range = /^bytes 0-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') || '');
  const fullSize = res.status === 206 && range ? Number(range[2]) : Number(res.headers.get('content-length'));
  if (![200, 206].includes(res.status) || fullSize !== song.bytes ||
      (res.status === 206 && (!range || Number(range[1]) !== Math.min(65535, song.bytes - 1))) ||
      !['audio/mpeg', 'audio/mp3', 'application/octet-stream'].includes(mediaType) || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    return false;
  }
  const reader = res.body.getReader(), prefix = new Uint8Array(Math.min(65536, song.bytes));
  let read = 0;
  try {
    while (read < prefix.length) {
      const part = await reader.read();
      if (part.done) break;
      const take = Math.min(part.value.length, prefix.length - read);
      prefix.set(part.value.subarray(0, take), read); read += take;
    }
  } finally { await reader.cancel().catch(() => undefined); }
  if (read !== prefix.length) return false;
  // Some MP3s begin with an embedded cover larger than the probe. The full
  // import validates the complete MPEG frame sequence and decodes the audio.
  return hasMpegAudioFrame(prefix, true) ||
    (asciiAt(prefix, 0, 'ID3') && prefix.length >= 10 &&
      [prefix[6], prefix[7], prefix[8], prefix[9]].every(byte => byte < 128) &&
      (() => {
        const start = 10 + (prefix[6] << 21 | prefix[7] << 14 | prefix[8] << 7 | prefix[9]) + (prefix[5] & 16 ? 10 : 0);
        return start >= prefix.length && start <= 256 * 1024 && start + 8 < song.bytes;
      })());
}

async function mapLimited<T, R>(values: T[], width: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  let next = 0;
  const results = new Array<R>(values.length);
  await Promise.all(Array.from({ length: Math.min(width, values.length) }, async () => {
    while (next < values.length) { const index = next++; results[index] = await fn(values[index]); }
  }));
  return results;
}

/** The main field searches public downloads. The separate open-license Crate keeps its existing scope. */
export async function searchArchiveSongs(query: string): Promise<{ results: ArchiveSong[] }> {
  const term = displayText(query, '', MAX_TERM_LENGTH), normalized = searchableText(term);
  const tokens = normalized.split(' ').filter(Boolean).slice(0, 8);
  if (normalized.length < 2 || !tokens.length) return { results: [] };
  const now = Date.now();
  for (const [key, value] of searchCache) if (value.expires <= now) searchCache.delete(key);
  const cached = searchCache.get(normalized);
  if (cached) return cached.songs;
  const songs = findArchiveSongs(tokens);
  if (searchCache.size >= 30) searchCache.delete(searchCache.keys().next().value!);
  searchCache.set(normalized, { expires: now + 60000, songs });
  try { return await songs; } catch (error) { searchCache.delete(normalized); throw error; }
}

async function findArchiveSongs(tokens: string[]): Promise<{ results: ArchiveSong[] }> {
  const base = 'mediatype:audio AND NOT access-restricted-item:true';
  const queries = [
    `${base} AND (${tokens.map(token => `(title:"${token}" OR creator:"${token}")`).join(' AND ')})`,
    `${base} AND (${tokens.map(token => `"${token}"`).join(' AND ')})`,
    `${base} AND (${tokens.map(token => `title:"${token}"`).join(' AND ')})`,
  ];
  const searches = await Promise.allSettled(queries.map(async (q, index) => {
    const url = new URL(SEARCH_API);
    url.searchParams.set('q', q);
    for (const field of ['identifier','title','creator']) url.searchParams.append('fl[]', field);
    if (index === 2) url.searchParams.append('sort[]', 'downloads desc');
    url.searchParams.set('rows', '16'); url.searchParams.set('output', 'json');
    const data = await fetchJson(url.toString(), 'search', 20000, 10000) as { response?: { docs?: { identifier?: unknown; title?: unknown; creator?: unknown }[] } };
    if (!Array.isArray(data?.response?.docs)) throw new ArchiveError('Internet Archive search is temporarily unavailable.');
    return data.response.docs;
  }));
  if (searches.every(result => result.status === 'rejected')) {
    const transient = searches.some(result => result.status === 'rejected' && result.reason instanceof ArchiveError && result.reason.retryable);
    throw new ArchiveError('Internet Archive search is temporarily unavailable.', transient ? 'archive_busy' : 'archive_fetch_failed', transient);
  }
  const docs = searches.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  const docScore = (doc: { title?: unknown; creator?: unknown }) => {
    const title = searchableText(displayText(doc.title)), artist = searchableText(displayText(doc.creator));
    return tokens.filter(token => title.includes(token)).length * 5 + tokens.filter(token => artist.includes(token)).length * 2 - (title + artist).length / 200;
  };
  docs.sort((a,b) => docScore(b) - docScore(a));
  const ids = [...new Set(docs.filter(doc => alternateRecording.test(tokens.join(' ')) || !alternateRecording.test(searchableText(displayText(doc.title))))
    .map(doc => doc?.identifier).filter((id): id is string => typeof id === 'string' && IDENTIFIER_PATTERN.test(id)))].slice(0, 16);
  const metadataDeadline = Date.now() + 18000;
  let metadataFailures = 0;
  const items = await mapLimited(ids, 4, async id => {
    if (Date.now() >= metadataDeadline) { metadataFailures++; return null; }
    try { return await fetchArchiveItem(id, { publicAudio: true, timeoutMs: Math.max(1, Math.min(9000, metadataDeadline - Date.now())) }); }
    catch (error) { if (error instanceof ArchiveError && error.retryable) metadataFailures++; return null; }
  });
  const candidates: (ArchiveSong & { score: number })[] = [];
  for (const item of items) {
    if (!item) continue;
    for (const track of item.tracks) {
      if (!track.importable) continue;
      const versions = searchableText(`${item.title} ${track.title} ${item.identifier}`);
      if (!alternateRecording.test(tokens.join(' ')) &&
          (alternateRecording.test(versions) || alternateDescription.test(searchableText(item.description || '')))) continue;
      const title = songTitle(item, track);
      const artist = recordingCredit(track.artist), fileCreator = recordingCredit(track.creator);
      // Item creator remains useful for finding a song, but never becomes its artist tag.
      const text = searchableText(`${title} ${artist} ${fileCreator} ${item.creator}`);
      // Matching only the album description would return unrelated tracks.
      if (!tokens.every(token => text.includes(token))) continue;
      const titleText = searchableText(title), artistText = searchableText(`${artist} ${fileCreator} ${item.creator}`);
      // A partial creator-name match alone is not a match for the requested song.
      // An exact artist query still returns that artist's available tracks.
      if (!tokens.some(token => titleText.includes(token)) &&
          ![artist, fileCreator, item.creator].some(credit => searchableText(credit) === tokens.join(' '))) continue;
      const score = tokens.filter(token => titleText.includes(token)).length * 5 + tokens.filter(token => artistText.includes(token)).length * 2
        + (titleText === tokens.join(' ') ? 6 : 0)
        + (track.artist && !/^(artist|unknown|unknown artist|various artists)$/i.test(track.artist) ? 2 : 0)
        - (/\b(demo|live|acoustic)\b/.test(versions) ? 4 : 0)
        - Math.abs(text.split(' ').length - tokens.length) * 0.2;
      candidates.push({ id: `${item.identifier}/${track.name}`, archiveId: item.identifier, archiveFile: track.name,
        title, artist, fileCreator, itemCreator: item.creator, itemDescription: item.description || '',
        durationSec: track.durationSec, bytes: track.bytes, sourceUrl: item.detailsUrl, itemTitle: item.title, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const results: ArchiveSong[] = [], seen = new Set<string>();
  for (let offset = 0; offset < Math.min(candidates.length, 24) && results.length < 8; offset += 6) {
    const batch = candidates.slice(offset, offset + 6);
    const available = await mapLimited(batch, 6, async song => {
      try { return await downloadableSong(song); } catch { return false; }
    });
    for (let i = 0; i < batch.length && results.length < 8; i++) {
      const { score: _score, ...song } = batch[i];
      const identity = song.id;
      if (available[i] && !seen.has(identity)) { seen.add(identity); results.push(song); }
    }
  }
  if (!results.length && metadataFailures) throw new ArchiveError('Internet Archive is responding slowly. Try the search again.', 'archive_busy', true);
  return { results };
}

const AUDIO_EXTENSIONS = ['.mp3', '.ogg', '.m4a', '.flac', '.wav', '.aiff', '.aif'];

/** MP3 first: smallest for the same job, and the separator takes it as-is. */
function extensionRank(name: string): number {
  const lower = name.toLowerCase();
  const index = AUDIO_EXTENSIONS.findIndex((ext) => lower.endsWith(ext));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function isAudioFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.includes('_spectrogram')) return false;
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

interface ArchiveFile {
  name?: string;
  title?: string;
  format?: string;
  size?: string;
  length?: string;
  creator?: string;
  artist?: string;
  private?: boolean | string;
}

function archiveFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

export async function fetchArchiveItem(identifier: string, options: { publicAudio?: boolean; timeoutMs?: number } = {}): Promise<ArchiveItem> {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new ArchiveError('That is not a valid Internet Archive identifier.', 'invalid_identifier');
  }

  const payload = await fetchJson(
    `${METADATA_API}/${encodeURIComponent(identifier)}`,
    'metadata', options.timeoutMs
  );
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ArchiveError('That Internet Archive item returned unreadable metadata.');
  }
  const rawPayload = payload as Record<string, unknown>;
  const meta = rawPayload.metadata;
  const rawFiles = rawPayload.files;
  if (
    !meta ||
    typeof meta !== 'object' ||
    Array.isArray(meta) ||
    !Array.isArray(rawFiles)
  ) {
    throw new ArchiveError('That Internet Archive item does not exist.', 'item_not_found');
  }
  if (rawFiles.length > MAX_METADATA_FILES) {
    throw new ArchiveError('That Internet Archive item has too many files to inspect.');
  }
  const metadata = meta as Record<string, unknown>;
  const files = rawFiles.filter(
    (file): file is ArchiveFile =>
      Boolean(file) && typeof file === 'object' && !Array.isArray(file)
  );

  if ([rawPayload.is_dark, metadata.is_dark, metadata['access-restricted-item'], metadata['no-download'], metadata.nodownload].some(archiveFlag)) {
    throw new ArchiveError('This recording is unavailable for public download.', 'archive_download_restricted');
  }
  const licenseUrl = firstString(metadata.licenseurl);
  if (!options.publicAudio && !licenseUrl) {
    throw new ArchiveError(
      'That item has no open licence, so it cannot be split here.',
      'license_missing'
    );
  }
  if (!options.publicAudio && !isOpenLicenseUrl(licenseUrl)) {
    throw new ArchiveError(
      'That item does not have a supported open licence, so it cannot be split here.',
      'license_not_open'
    );
  }
  if (licenseForbidsDerivatives(licenseUrl)) {
    throw new ArchiveError(
      'That item is NoDerivatives-licensed, which does not permit splitting it into stems.',
      'license_no_derivatives'
    );
  }

  const tracksByBase = new Map<string, ArchiveTrack>();
  for (const file of files) {
    const name = file.name;
    if (
      !name ||
      name.length > MAX_FILE_NAME_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(name) ||
      !isAudioFile(name) || archiveFlag(file.private) ||
      (options.publicAudio && !name.toLowerCase().endsWith('.mp3'))
    ) continue;

    // Items carry several derivatives of one track; keep the best-ranked file
    // per base name so the picker shows songs, not encodings.
    const base = name.replace(/\.[^.]+$/, '');
    const bytesValue = Number(file.size);
    const bytes = Number.isSafeInteger(bytesValue) && bytesValue > 0 ? bytesValue : 0;
    const durationSec = parseLength(file.length);
    const candidate: ArchiveTrack = {
      name,
      title: displayText(file.title, base.replace(/^\d+[\s._-]*/, '') || base),
      artist: displayText(file.artist),
      creator: displayText(file.creator),
      durationSec,
      bytes,
      importable:
        bytes > 0 &&
        bytes <= (options.publicAudio ? ARCHIVE_SEARCH_MAX_BYTES : MAX_AUDIO_BYTES) &&
        durationSec > 0 &&
        durationSec <= (options.publicAudio ? PUBLIC_AUDIO_MAX_SECONDS : MAX_DURATION_SECONDS),
    };
    const previous = tracksByBase.get(base);
    if (
      !previous ||
      (candidate.importable && !previous.importable) ||
      (candidate.importable === previous.importable &&
        (extensionRank(candidate.name) < extensionRank(previous.name) ||
          (extensionRank(candidate.name) === extensionRank(previous.name) &&
            candidate.name.localeCompare(previous.name) < 0)))
    ) {
      tracksByBase.set(base, candidate);
    }
  }

  const tracks = [...tracksByBase.values()];
  tracks.sort(
    (a, b) => extensionRank(a.name) - extensionRank(b.name) || a.name.localeCompare(b.name)
  );

  if (tracks.length === 0) {
    throw new ArchiveError('That item has no audio files to split.', 'no_audio_files');
  }

  return {
    identifier,
    title: displayText(metadata.title, identifier),
    creator: displayText(metadata.creator),
    description: itemDescription(metadata.description),
    year: toYear(metadata.year ?? metadata.date),
    license: options.publicAudio && !isOpenLicenseUrl(licenseUrl) ? '' : licenseLabel(licenseUrl),
    licenseUrl,
    detailsUrl: `https://archive.org/details/${encodeURIComponent(identifier)}`,
    tracks,
  };
}

/**
 * Downloads one track. Mirrors fetchYouTubeAudio()'s contract so the job route
 * can treat both imports identically.
 */
export async function fetchArchiveAudio(
  identifier: string,
  fileName: string | undefined,
  _env: Env,
  options: { maximumBytes?: number; remix?: boolean; publicAudio?: boolean } = {}
): Promise<ArchiveAudio & { fileName: string }> {
  const publicAudio = options.publicAudio === true && !options.remix;
  const item = await fetchArchiveItem(identifier, { publicAudio });
  const limit = publicAudio ? ARCHIVE_SEARCH_MAX_BYTES : MAX_AUDIO_BYTES;
  const durationLimit = publicAudio ? PUBLIC_AUDIO_MAX_SECONDS : MAX_DURATION_SECONDS;
  const maximumBytes = Math.min(options.maximumBytes ?? limit, limit);
  if (options.remix) {
    const license = new URL(item.licenseUrl);
    if (license.port || license.search || license.hash || !/^\/(?:licenses\/(?:by|by-sa|by-nc|by-nc-sa)\/(?:2\.0|2\.5|3\.0|4\.0)|publicdomain\/(?:zero|mark)\/1\.0)\/?$/.test(license.pathname)) {
      throw new ArchiveError('This source needs reviewed reuse terms before remixing.', 'license_not_open');
    }
  }

  const track = fileName
    ? item.tracks.find((candidate) => candidate.name === fileName)
    : item.tracks.find((candidate) => candidate.importable);

  if (!track) {
    throw new ArchiveError(
      fileName
        ? 'That track is not part of this Internet Archive item.'
        : `Choose a downloadable track under ${durationLimit / 60} minutes.`,
      'track_not_found'
    );
  }
  if (!track.importable && (track.durationSec <= 0 || track.bytes <= 0)) {
    throw new ArchiveError(
      'That track is missing reliable duration or size metadata.',
      'track_metadata_incomplete'
    );
  }
  if (track.durationSec > durationLimit) {
    throw new ArchiveError(`Choose a track under ${durationLimit / 60} minutes.`, 'track_too_long');
  }
  if (track.bytes > maximumBytes) {
    throw new ArchiveError(`That track is larger than ${Math.floor(maximumBytes / 1024 / 1024)} MB.`, 'track_too_large');
  }

  const url = `${DOWNLOAD_BASE}/${encodeURIComponent(identifier)}/${encodeURIComponent(track.name)}`;

  const { response: res, deadline } = await fetchWithBusyRetry(
    url,
    'download',
    AUDIO_FETCH_TIMEOUT_MS
  );
  if (res.status !== 200 || res.headers.has('content-range')) {
    await res.body?.cancel().catch(() => undefined);
    throw new ArchiveError(`Could not download that track (${res.status}).`, 'archive_download_unavailable');
  }

  const mediaType = responseMediaType(res);
  if (!mediaType.startsWith('audio/') && mediaType !== 'application/octet-stream') {
    await res.body?.cancel().catch(() => undefined);
    throw new ArchiveError(
      'The Internet Archive returned no usable audio for that track.',
      'invalid_audio_response',
      true
    );
  }
  const timedOut = () =>
    new ArchiveError('The Internet Archive download timed out.', 'archive_busy', true);
  let data = await readBoundedResponse(res, {
    maximumBytes,
    timeoutMs: await remainingArchiveBodyBudget(res, deadline, timedOut),
    errors: {
      tooLarge: () => new ArchiveError(`That track is larger than ${Math.floor(maximumBytes / 1024 / 1024)} MB.`, 'track_too_large'),
      timedOut,
      unreadable: () =>
        new ArchiveError(
          'The Internet Archive returned no usable audio for that track.',
          'invalid_audio_response',
          true
        ),
    },
  });
  if (data.byteLength < MIN_AUDIO_BYTES) {
    throw new ArchiveError('That track came back empty from the Internet Archive.');
  }
  if ((options.remix || publicAudio) && data.byteLength !== track.bytes) {
    throw new ArchiveError('This recording changed while loading. Search again to refresh its file.', 'archive_source_changed', true);
  }
  if (!matchesAudioSignature(track.name, new Uint8Array(data))) {
    throw new ArchiveError(
      'The Internet Archive returned no usable audio for that track.',
      'invalid_audio_response',
      true
    );
  }

  if (publicAudio) {
    // Some Archive MP3 exports append an empty JSON object after the complete
    // MPEG stream. These two nonaudio bytes are separate from the recording;
    // retain every frame and still require full duration and PCM validation.
    const bytes = new Uint8Array(data);
    if (bytes[bytes.length - 2] === 0x7b && bytes[bytes.length - 1] === 0x7d) {
      const framesOnly = data.slice(0, -2);
      if (mp3FrameInfo(framesOnly)) data = framesOnly;
    }
    const frames = mp3FrameInfo(data);
    if (!frames || Math.abs(frames.seconds - track.durationSec) > 2 ||
        (_env.validateStemAudio && !await _env.validateStemAudio(data))) {
      throw new ArchiveError('This recording returned incomplete audio. Choose another result.', 'archive_audio_incomplete');
    }
  }

  return {
    data,
    ...archiveAudioMetadata(item, track, publicAudio),
    durationSec: track.durationSec,
  };
}

export function archiveContentType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (lower.endsWith('.aiff') || lower.endsWith('.aif')) return 'audio/aiff';
  return 'audio/wav';
}

function matchesAudioSignature(fileName: string, bytes: Uint8Array): boolean {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.mp3')) return hasMpegAudioFrame(bytes);
  if (lower.endsWith('.ogg')) return asciiAt(bytes, 0, 'OggS');
  if (lower.endsWith('.m4a')) return asciiAt(bytes, 4, 'ftyp');
  if (lower.endsWith('.flac')) return asciiAt(bytes, 0, 'fLaC');
  if (lower.endsWith('.wav')) {
    return asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WAVE');
  }
  if (lower.endsWith('.aiff') || lower.endsWith('.aif')) {
    return (
      asciiAt(bytes, 0, 'FORM') &&
      (asciiAt(bytes, 8, 'AIFF') || asciiAt(bytes, 8, 'AIFC'))
    );
  }
  return false;
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function hasMpegAudioFrame(bytes: Uint8Array, requireStart = false): boolean {
  let offset = 0;
  if (asciiAt(bytes, 0, 'ID3')) {
    if (
      bytes.length < 10 ||
      [bytes[6], bytes[7], bytes[8], bytes[9]].some((byte) => byte & 0x80)
    ) return false;
    const tagSize = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
    offset = 10 + tagSize + (bytes[5] & 0x10 ? 10 : 0);
    if (offset >= bytes.length) return false;
  }
  const limit = Math.min(bytes.length - 3, offset + (requireStart ? 1 : 64 * 1024));
  for (let index = offset; index < limit; index += 1) {
    if (bytes[index] !== 0xff || (bytes[index + 1] & 0xe0) !== 0xe0) continue;
    const version = (bytes[index + 1] >> 3) & 0x03;
    const layer = (bytes[index + 1] >> 1) & 0x03;
    if (requireStart && layer !== 1) continue;
    const bitrate = (bytes[index + 2] >> 4) & 0x0f;
    const sampleRate = (bytes[index + 2] >> 2) & 0x03;
    if (
      version !== 0x01 &&
      layer !== 0 &&
      bitrate !== 0 &&
      bitrate !== 0x0f &&
      sampleRate !== 0x03
    ) return true;
  }
  return false;
}
