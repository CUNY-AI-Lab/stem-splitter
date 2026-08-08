// Internet Archive open-audio import, behind the fetchArchiveAudio() seam.
//
// Unlike the YouTube path this needs no third-party fetcher: archive.org serves
// public audio over plain HTTP with real Content-Length and no bot-check, so a
// direct Worker fetch is the whole story (and costs nothing per import).
//
// Two boundaries are enforced here rather than in the routes:
//   - the search query is assembled server-side so students can never widen it
//     past open-licensed audio (see buildQuery), and
//   - NoDerivatives (ND) licences are excluded, because separating a track into
//     stems produces a derivative work.
import type { Env } from './env';

// Crate-specific cap, tighter than the 15-minute YouTube/upload limit: the
// browse list only offers songs, and nothing over 5 minutes is shown or
// importable through it. Enforced here (not just in the UI) so a crafted API
// call cannot import past it.
const MAX_DURATION_SECONDS = 5 * 60;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const MIN_AUDIO_BYTES = 1024;
const SEARCH_ROWS = 24;
const MAX_SEARCH_PAGE = 20;
const MAX_TERM_LENGTH = 120;

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
  return typeof value === 'string' && value in ARCHIVE_SCOPES;
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
  /** False when the track breaks the duration or size cap; UI greys these out. */
  importable: boolean;
}

export interface ArchiveItem {
  identifier: string;
  title: string;
  creator: string;
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

  const identifier = decodeURIComponent(parts[1]);
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

/**
 * archive.org's frontends intermittently return 429/5xx under load — observed
 * live at roughly 1-in-5 downloads during evaluation — so every archive fetch
 * gets a short bounded retry rather than failing the student's import on the
 * first blip.
 */
async function fetchWithBusyRetry(url: string, label: string): Promise<Response> {
  let lastNetworkError: unknown;
  let sawBusy = false;

  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      const res = await fetch(url, { headers: { Accept: '*/*' } });
      if (res.status === 429 || res.status >= 500) {
        sawBusy = true;
        continue;
      }
      return res;
    } catch (err) {
      lastNetworkError = err;
      console.error(`archive ${label} network error (attempt ${attempt + 1})`, err);
    }
  }

  if (sawBusy) {
    throw new ArchiveError(
      'The Internet Archive is busy. Try again in a moment.',
      'archive_busy',
      true
    );
  }
  console.error(`archive ${label} unreachable`, lastNetworkError);
  throw new ArchiveError(
    'Could not reach the Internet Archive. Try again in a moment.',
    'archive_unreachable',
    true
  );
}

async function fetchJson(url: string, label: string): Promise<unknown> {
  const res = await fetchWithBusyRetry(url, label);
  if (!res.ok) {
    throw new ArchiveError(`Internet Archive ${label} failed (${res.status}).`);
  }

  return res.json().catch(() => {
    throw new ArchiveError(`Internet Archive ${label} returned an unreadable response.`);
  });
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

  const payload = (await fetchJson(url.toString(), 'search')) as {
    response?: { numFound?: number; docs?: Array<Record<string, unknown>> };
  };

  const docs = payload.response?.docs ?? [];
  return {
    page: safePage,
    total: payload.response?.numFound ?? 0,
    results: docs
      .filter((doc) => typeof doc.identifier === 'string')
      .map((doc) => {
        const licenseUrl = firstString(doc.licenseurl);
        return {
          identifier: String(doc.identifier),
          title: firstString(doc.title) || String(doc.identifier),
          creator: firstString(doc.creator),
          year: toYear(doc.year),
          license: licenseLabel(licenseUrl),
          licenseUrl,
          downloads: Number(doc.downloads) || 0,
        };
      }),
  };
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
}

export async function fetchArchiveItem(identifier: string): Promise<ArchiveItem> {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new ArchiveError('That is not a valid Internet Archive identifier.', 'invalid_identifier');
  }

  const payload = (await fetchJson(`${METADATA_API}/${encodeURIComponent(identifier)}`, 'metadata')) as {
    metadata?: Record<string, unknown>;
    files?: ArchiveFile[];
  };

  const meta = payload.metadata;
  if (!meta || !payload.files) {
    throw new ArchiveError('That Internet Archive item does not exist.', 'item_not_found');
  }

  const licenseUrl = firstString(meta.licenseurl);
  if (!licenseUrl) {
    throw new ArchiveError(
      'That item has no open licence, so it cannot be split here.',
      'license_missing'
    );
  }
  if (licenseForbidsDerivatives(licenseUrl)) {
    throw new ArchiveError(
      'That item is NoDerivatives-licensed, which does not permit splitting it into stems.',
      'license_no_derivatives'
    );
  }

  const seen = new Set<string>();
  const tracks: ArchiveTrack[] = [];
  for (const file of payload.files) {
    const name = file.name;
    if (!name || !isAudioFile(name)) continue;

    // Items carry several derivatives of one track; keep the best-ranked file
    // per base name so the picker shows songs, not encodings.
    const base = name.replace(/\.[^.]+$/, '');
    if (seen.has(base)) continue;
    seen.add(base);

    const bytes = Number.parseInt(String(file.size ?? ''), 10) || 0;
    const durationSec = parseLength(file.length);
    tracks.push({
      name,
      title: file.title?.trim() || base.replace(/^\d+[\s._-]*/, '') || base,
      durationSec,
      bytes,
      importable:
        bytes > 0 &&
        bytes <= MAX_AUDIO_BYTES &&
        (durationSec === 0 || durationSec <= MAX_DURATION_SECONDS),
    });
  }

  tracks.sort((a, b) => extensionRank(a.name) - extensionRank(b.name) || a.name.localeCompare(b.name));

  if (tracks.length === 0) {
    throw new ArchiveError('That item has no audio files to split.', 'no_audio_files');
  }

  return {
    identifier,
    title: firstString(meta.title) || identifier,
    creator: firstString(meta.creator),
    year: toYear(meta.year ?? meta.date),
    license: licenseLabel(licenseUrl),
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
  _env: Env
): Promise<ArchiveAudio & { fileName: string }> {
  const item = await fetchArchiveItem(identifier);

  const track = fileName
    ? item.tracks.find((candidate) => candidate.name === fileName)
    : item.tracks.find((candidate) => candidate.importable);

  if (!track) {
    throw new ArchiveError(
      fileName
        ? 'That track is not part of this Internet Archive item.'
        : 'No track on this item is short enough to split (5 minute limit).',
      'track_not_found'
    );
  }
  if (track.durationSec > MAX_DURATION_SECONDS) {
    throw new ArchiveError('That track is longer than 5 minutes.', 'track_too_long');
  }
  if (track.bytes > MAX_AUDIO_BYTES) {
    throw new ArchiveError('That track is larger than 100 MB.', 'track_too_large');
  }

  const url = `${DOWNLOAD_BASE}/${encodeURIComponent(identifier)}/${encodeURIComponent(track.name)}`;

  const res = await fetchWithBusyRetry(url, 'download');
  if (!res.ok) {
    throw new ArchiveError(`Could not download that track (${res.status}).`);
  }

  // Trust the declared length when present; otherwise the byte check below is
  // still a hard stop, since the body is fully buffered before it reaches R2.
  const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
    throw new ArchiveError('That track is larger than 100 MB.', 'track_too_large');
  }

  const data = await res.arrayBuffer();
  if (data.byteLength < MIN_AUDIO_BYTES) {
    throw new ArchiveError('That track came back empty from the Internet Archive.');
  }
  if (data.byteLength > MAX_AUDIO_BYTES) {
    throw new ArchiveError('That track is larger than 100 MB.', 'track_too_large');
  }

  return {
    data,
    // Plain hyphen, not an em dash: sanitizeFilename() flattens punctuation it
    // does not recognise to "_", which reads badly in the mixer title.
    title: `${item.creator ? `${item.creator} - ` : ''}${track.title}`,
    durationSec: track.durationSec,
    fileName: track.name,
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
