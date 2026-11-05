import { readBoundedResponse, responseMediaType } from './http/bounded-response.ts';
import { retryAt, setCooldown } from './reliability/retry.ts';

export type PublicSearchCache = { storage: Pick<Cache, 'match' | 'put'>; origin: string };
export type RecordingReference = {
  id: string; title: string; artist: string; disambiguation: string;
  durationSec: number | null; firstReleaseDate: string; sourceUrl: string;
  kind: 'metadata'; providerName: 'MusicBrainz';
  relations?: { label: string; url: string }[];
};
type Context = { db: D1Database; signal?: AbortSignal; cache?: PublicSearchCache };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT = 'StemSplitter/0.1 (https://github.com/CUNY-AI-Lab/stem-splitter)';
const PROVIDER = 'musicbrainz';
const REQUEST_MS = 5000, SPACING_MS = 1100, LEASE_MS = 15000;
const clean = (value: unknown, max = 300) => typeof value === 'string'
  ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '';

export class MusicBrainzError extends Error {
  constructor(readonly code: 'invalid_reference' | 'metadata_unavailable' | 'metadata_busy', readonly notBefore?: number) {
    super(code === 'invalid_reference' ? 'Invalid recording reference.' : 'MusicBrainz references are temporarily unavailable.');
  }
}

function reference(row: any): RecordingReference | null {
  if (!row || typeof row.id !== 'string' || !UUID.test(row.id) || !clean(row.title)) return null;
  const artist = Array.isArray(row['artist-credit']) ? row['artist-credit'].slice(0, 12)
    .map((credit: any) => clean(credit?.name || credit?.artist?.name) +
      (typeof credit?.joinphrase === 'string' ? credit.joinphrase.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 30) : '')).join('').trim() : '';
  return {
    id: row.id.toLowerCase(), title: clean(row.title), artist,
    disambiguation: clean(row.disambiguation),
    durationSec: Number.isSafeInteger(row.length) && row.length > 0 ? row.length / 1000 : null,
    firstReleaseDate: /^\d{4}(?:-\d{2})?(?:-\d{2})?$/.test(row['first-release-date'] ?? '') ? row['first-release-date'] : '',
    sourceUrl: `https://musicbrainz.org/recording/${row.id.toLowerCase()}`,
    kind: 'metadata', providerName: 'MusicBrainz',
  };
}

function relatedPages(row: any): { label: string; url: string }[] {
  if (!Array.isArray(row.relations)) return [];
  const seen = new Set<string>();
  return row.relations.slice(0, 100).flatMap((relation: any) => {
    if (relation?.['target-type'] !== 'url' || typeof relation.url?.resource !== 'string' || relation.url.resource.length > 2048) return [];
    try {
      const url = new URL(relation.url.resource);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || seen.has(url.href)) return [];
      seen.add(url.href);
      return [{ label: `${clean(relation.type, 80) || 'Reference'} · ${url.hostname}`, url: url.href }];
    } catch { return []; }
  }).slice(0, 8);
}

async function pause(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new MusicBrainzError('metadata_unavailable')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** The existing D1 cooldown table serializes metadata calls across Worker isolates. */
async function reserveSlot(db: D1Database, signal?: AbortSignal) {
  const deadline = Date.now() + 3500;
  for (let attempt = 0; attempt < 8; attempt++) {
    signal?.throwIfAborted();
    const now = Date.now(), lease = now + LEASE_MS;
    const row = await db.prepare(`INSERT INTO provider_cooldowns(provider,until_ms) VALUES(?,?)
      ON CONFLICT(provider) DO UPDATE SET until_ms=excluded.until_ms WHERE until_ms<=? RETURNING until_ms`)
      .bind(PROVIDER, lease, now).first();
    if (row) {
      // A slow D1 response must never dispatch from an expired reservation.
      if (Date.now() + REQUEST_MS + SPACING_MS >= lease) throw new MusicBrainzError('metadata_busy');
      return lease;
    }
    const pending = await db.prepare('SELECT until_ms FROM provider_cooldowns WHERE provider=?').bind(PROVIDER).first<{ until_ms: number }>();
    const remaining = Math.max(1, (pending?.until_ms ?? Date.now() + SPACING_MS) - Date.now());
    // Briefly wait for an active lease to finish; longer Retry-After is final.
    if (remaining > LEASE_MS) throw new MusicBrainzError('metadata_busy');
    const wait = remaining > 1500 ? 250 : remaining + 10;
    if (Date.now() + wait > deadline) throw new MusicBrainzError('metadata_busy');
    await pause(wait, signal);
  }
  throw new MusicBrainzError('metadata_busy');
}

async function requestAttempt(path: string, context: Context): Promise<any> {
  const url = new URL(path, 'https://musicbrainz.org/ws/2/');
  url.searchParams.set('fmt', 'json');
  const lease = await reserveSlot(context.db, context.signal);
  const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_MS), ...(context.signal ? [context.signal] : [])]);
  let notBefore = 0;
  try {
    if (Date.now() + REQUEST_MS + SPACING_MS >= lease) throw new MusicBrainzError('metadata_busy');
    // Workers does not implement redirect: 'error'. Manual mode preserves our
    // no-redirect policy: the non-OK check below rejects every 3xx response.
    const response = await fetch(url, { redirect: 'manual', signal, headers: { 'User-Agent': AGENT, Accept: 'application/json' } });
    if (response.status === 429 || response.status === 503) {
      notBefore = retryAt(response.headers.get('retry-after'));
      await response.body?.cancel().catch(() => {});
      await setCooldown(context.db, PROVIDER, notBefore);
      throw new MusicBrainzError('metadata_busy', notBefore);
    }
    if (!response.ok || responseMediaType(response) !== 'application/json') {
      await response.body?.cancel().catch(() => {});
      throw new MusicBrainzError('metadata_unavailable');
    }
    const unavailable = () => new MusicBrainzError('metadata_unavailable');
    const body = await readBoundedResponse(response, { maximumBytes: 512 * 1024, timeoutMs: 5000,
      errors: { tooLarge: unavailable, timedOut: unavailable, unreadable: unavailable } });
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
  } catch (error) {
    if (error instanceof MusicBrainzError) throw error;
    throw new MusicBrainzError('metadata_unavailable');
  } finally {
    // Pace from actual completion, not the timestamp before the D1 round trip.
    // Compare the owned lease so a delayed release cannot shorten another call
    // or an upstream cooldown. If D1 fails, the longer lease expires safely.
    try {
      await context.db.prepare('UPDATE provider_cooldowns SET until_ms=? WHERE provider=? AND until_ms=?')
        .bind(Math.max(Date.now() + SPACING_MS, notBefore), PROVIDER, lease).run();
    } catch { /* Keep the existing lease on a transient D1 failure. */ }
  }
}

async function request(path: string, context: Context): Promise<any> {
  const signal = AbortSignal.any([AbortSignal.timeout(10000), ...(context.signal ? [context.signal] : [])]);
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await requestAttempt(path, { ...context, signal }); }
    catch (error) {
      // MusicBrainz can briefly return 503/429 with Retry-After: 0. Retry one
      // read after the normal shared spacing; never retry permission failures,
      // malformed data, local contention, or a long provider cooldown.
      if (attempt || !(error instanceof MusicBrainzError) || error.notBefore === undefined ||
          error.notBefore - Date.now() > 2000 || signal.aborted) throw error;
      await pause(Math.max(SPACING_MS, error.notBefore - Date.now()), signal);
    }
  }
  throw new MusicBrainzError('metadata_unavailable');
}

async function cached<T>(key: string, context: Context, load: () => Promise<T>): Promise<T> {
  const cache = context.cache;
  const cacheKey = cache && new Request(new URL('/__musicbrainz/v1/' + key, cache.origin));
  if (cache && cacheKey) {
    try { const hit = await cache.storage.match(cacheKey); if (hit?.ok) return await hit.json() as T; } catch { /* Optional public cache. */ }
  }
  const result = await load();
  if (cache && cacheKey && !context.signal?.aborted) {
    try { await cache.storage.put(cacheKey, Response.json(result, { headers: { 'Cache-Control': 'public, max-age=3600' } })); } catch { /* Optional public cache. */ }
  }
  return result;
}

export async function searchRecordingReferences(query: string, context: Context): Promise<RecordingReference[]> {
  // Quote literal tokens rather than allowing caller-supplied Lucene operators.
  const words = query.normalize('NFKC').match(/[\p{L}\p{N}]+/gu)?.slice(0, 12) ?? [];
  if (query.length > 120 || words.join('').length < 2) return [];
  const literal = words.map(word => `"${word}"`).join(' AND ');
  return cached('search?q=' + encodeURIComponent(literal.toLowerCase()), context, async () => {
    const data = await request('recording/?limit=6&query=' + encodeURIComponent(literal), context);
    if (!Array.isArray(data?.recordings)) throw new MusicBrainzError('metadata_unavailable');
    // A recording MBID identifies a recording/version, never a title-level work.
    const seen = new Set<string>();
    return data.recordings.slice(0, 6).flatMap((row: unknown) => {
      const value = reference(row);
      if (!value || seen.has(value.id)) return [];
      seen.add(value.id); return [value];
    });
  });
}

export async function getRecordingReference(id: string, context: Context): Promise<RecordingReference> {
  if (!UUID.test(id)) throw new MusicBrainzError('invalid_reference');
  return cached(id.toLowerCase(), context, async () => {
    const data = await request(`recording/${id.toLowerCase()}?inc=artist-credits+url-rels`, context);
    const result = reference(data);
    if (!result || result.id !== id.toLowerCase()) throw new MusicBrainzError('metadata_unavailable');
    return { ...result, relations: relatedPages(data) };
  });
}
