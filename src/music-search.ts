import { archiveSongSearchResponse } from './archive-search-response.ts';
import { searchOpenAudio, type OpenAudioTrack } from './open-audio.ts';
import { searchYouTube, type YouTubeTrack } from './youtube-search.ts';
import type { PublicSearchCache } from './musicbrainz.ts';
import { archiveSongSearchKey, creditMatchesQuery, hiddenFromGenreLists, isGenreOnlySearch, searchableText, SHORT_CLIP_SECONDS, type ArchiveSong } from './archive.ts';
// Library of Congress is not searched: www.loc.gov serves Workers a Cloudflare challenge,
// and its API is too slow and rate-limited for this path. See docs/audio-search-catalogs-20261104.md.
type Provider = 'archive' | 'commons' | 'freesound' | 'youtube';
type Track = ArchiveSong | OpenAudioTrack | YouTubeTrack;
type AudioTrack = Track & { providerName: string };
// YouTube is listed only where its audio can be fetched (see youtube-fetcher.ts).
type SearchResult = { results: AudioTrack[]; references: never[]; providers: Partial<Record<Provider, 'pending' | 'ready' | 'unavailable'>>; fallback?: boolean };
type Context = { db: D1Database; maximumSeconds: number; signal?: AbortSignal; cache?: PublicSearchCache; youtube?: boolean };

// The Archive holds nearly all full-length songs, so it gets more of the list.
const RESULT_SLOTS: Record<Provider, number> = { archive: 8, commons: 4, freesound: 4, youtube: 6 };
// Freesound is mostly short effects whose tags loosely match. Tracks must carry the
// search words, and short clips appear only when a search would otherwise find nothing.
const MIN_FREESOUND_SECONDS = 30;
// Just past the Archive's own limits. No slow source can hold a search open longer.
const SEARCH_HARD_LIMIT_MS = 9000;
// The Archive holds nearly all full-length songs. Until it has listed something, it gets its full extra time.
const SEARCH_ARCHIVE_EMPTY_LIMIT_MS = 16000;
const credits = (track: Track) => {
  const { artist, fileCreator, itemCreator } = track as { artist?: string; fileCreator?: string; itemCreator?: string };
  return [artist, fileCreator, itemCreator];
};
function relevantTrack(provider: Provider, track: Track, query: string): boolean {
  if (isGenreOnlySearch(archiveSongSearchKey(query).split(' ')) && hiddenFromGenreLists(`${track.title} ${credits(track).join(' ')}`)) return false;
  // Freesound tags and YouTube's own ranking both match loosely, so their tracks must carry every search word.
  if (provider !== 'freesound' && provider !== 'youtube') return true;
  const text = searchableText(`${track.title} ${credits(track).join(' ')}`);
  return archiveSongSearchKey(query).split(' ').every(token => text.includes(token));
}
/**
 * Named artists and exact titles first, then whole-word matches, with full-length sources breaking ties.
 * A search for a genre alone puts tagged music first and keeps the Archive's ranking among it, because a
 * credit such as "Jazz" names an uploader rather than a sound.
 */
function relevance(provider: Provider, track: Track, query: string): number {
  const phrase = archiveSongSearchKey(query), title = searchableText(track.title);
  const tagged = Boolean((track as { genre?: string }).genre);
  const words = new Set(searchableText(`${track.title} ${credits(track).join(' ')}`).split(' '));
  const titleMatch = title === phrase ? 80 : ` ${title} `.includes(` ${phrase} `) ? 60 : 0;
  const match = isGenreOnlySearch(phrase.split(' ')) ? (tagged ? 100 : titleMatch)
    : (credits(track).some(credit => creditMatchesQuery(credit, phrase)) ? 100 : 0) + titleMatch + (tagged ? 80 : 0)
      + (phrase.split(' ').every(token => words.has(token)) ? 20 : 0);
  // Enough to list a clip after full tracks with the same evidence, without dropping it below looser matches.
  return match + (provider === 'archive' ? 5 : provider === 'youtube' ? 4 : provider === 'freesound' ? 0 : 2) - (track.durationSec < SHORT_CLIP_SECONDS ? 40 : 0);
}

/** Federate discovery only. Every import still passes its existing provider's rights/byte checks. */
export async function musicSearchResponse(query: string, streaming: boolean, context: Context): Promise<Response> {
  if (query.trim().length < 2 || query.length > 120) return Response.json({ error: 'Enter a song or artist using 2–120 characters.' }, { status: 400 });
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, ...(context.signal ? [context.signal] : [])]);
  const headers = { 'Cache-Control': 'private, no-store' };
  const run = async (emit: (value: SearchResult) => void): Promise<SearchResult> => {
    const tracks = new Map<string, AudioTrack>();
    const counts = { archive: 0, commons: 0, freesound: 0, youtube: 0 };
    const result: SearchResult = { results: [], references: [], providers: { archive: 'pending', commons: 'pending', freesound: 'pending', ...(context.youtube ? { youtube: 'pending' as const } : {}) } };
    const publish = () => {
      result.results = [...tracks.entries()]
        .map(([key, track]) => ({ track, score: relevance(key.split(':')[0] as Provider, track, query) }))
        .sort((a, b) => b.score - a.score).map(entry => entry.track);
      if (!signal.aborted) emit(result);
    };
    const shortClips: OpenAudioTrack[] = [];
    const add = (provider: Provider, candidates: Track[]) => {
      let items = candidates.filter(track => relevantTrack(provider, track, query));
      // Archive batches are rolling rankings, so each one replaces the last and a better late match can win.
      if (provider === 'archive') {
        for (const key of [...tracks.keys()]) if (key.startsWith('archive:')) tracks.delete(key);
        counts.archive = 0;
      }
      if (provider === 'freesound') {
        shortClips.push(...items.filter(track => track.durationSec < MIN_FREESOUND_SECONDS) as OpenAudioTrack[]);
        items = items.filter(track => track.durationSec >= MIN_FREESOUND_SECONDS);
      }
      for (const track of items.slice(0, RESULT_SLOTS[provider])) {
        const key = `${provider}:${track.id}`;
        if (!tracks.has(key)) {
          if (counts[provider] >= RESULT_SLOTS[provider]) continue;
          counts[provider]++;
        }
        tracks.set(key, { ...track, providerName: provider === 'archive' ? 'Internet Archive' : (track as OpenAudioTrack | YouTubeTrack).providerName });
      }
      publish();
    };
    const provider = async (name: Provider, work: () => Promise<void>) => {
      try { signal.throwIfAborted(); await work(); result.providers[name] = 'ready'; }
      catch { result.providers[name] = 'unavailable'; }
      publish();
    };
    const everySource = Promise.all([
      provider('archive', async () => {
        // Reuse the existing shared Archive search/cache and unsubscribe on cancellation.
        const response = await archiveSongSearchResponse(query, true, context.cache, context.maximumSeconds);
        const reader = response.body!.getReader(), decoder = new TextDecoder();
        const cancel = () => { void reader.cancel().catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        let pending = '', done = false;
        try {
          for (;;) {
            const chunk = await reader.read(); if (chunk.done) break;
            pending += decoder.decode(chunk.value, { stream: true });
            let newline;
            while ((newline = pending.indexOf('\n')) >= 0) {
              const batch = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
              if (batch.error) throw new Error('Archive unavailable');
              if (batch.fallback) result.fallback = true;
              if (Array.isArray(batch.results)) add('archive', batch.results);
              if (batch.done) done = true;
            }
          }
          if (!done) throw new Error('Archive search interrupted');
        } finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }),
      ...(['commons', 'freesound', ...(context.youtube ? ['youtube'] as const : [])] as const).map(name => provider(name, async () => {
        const key = context.cache && new Request(new URL('/__audio-search/v2/' + name + '?seconds=' + context.maximumSeconds + '&q=' + encodeURIComponent(query.trim().toLowerCase()), context.cache.origin));
        let value: { results: (OpenAudioTrack | YouTubeTrack)[] } | undefined;
        if (key && context.cache) { try { const hit = await context.cache.storage.match(key); if (hit?.ok) value = await hit.json(); } catch {} }
        if (!value) {
          value = name === 'youtube' ? await searchYouTube(query, { maximumSeconds: context.maximumSeconds, signal })
            : await searchOpenAudio(name, query, { ...context, signal });
          if (key && context.cache && !signal.aborted) { try { await context.cache.storage.put(key, Response.json(value, { headers: { 'Cache-Control': 'public, max-age=600' } })); } catch {} }
        }
        add(name, value.results);
      })),
    ]);
    const settled = everySource.then(() => false);
    const waitUpTo = async (ms: number) => {
      let endLimit = () => {};
      const timedOut = await Promise.race([settled, new Promise<boolean>(resolve => {
        const limit = setTimeout(() => resolve(true), ms);
        endLimit = () => clearTimeout(limit);
      })]);
      endLimit();
      return timedOut;
    };
    let timedOut = await waitUpTo(SEARCH_HARD_LIMIT_MS);
    for (let waited = SEARCH_HARD_LIMIT_MS; timedOut && result.providers.archive === 'pending' && !counts.archive && waited < SEARCH_ARCHIVE_EMPTY_LIMIT_MS; waited += 250) timedOut = await waitUpTo(250);
    if (timedOut) {
      for (const name of Object.keys(result.providers) as Provider[]) if (result.providers[name] === 'pending') result.providers[name] = 'unavailable';
      abort.abort();
    }
    if (!tracks.size && shortClips.length) {
      for (const track of shortClips.slice(0, RESULT_SLOTS.freesound)) tracks.set(`freesound:${track.id}`, track as AudioTrack);
      publish();
    }
    return result;
  };
  if (!streaming) return Response.json(await run(() => {}), { headers });
  let closed = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (value: unknown) => { if (!closed) controller.enqueue(encoder.encode(JSON.stringify(value) + '\n')); };
      send({ results: [], references: [], done: false });
      void run(value => send({ ...value, done: false })).then(value => send({ ...value, done: true }))
        .catch(() => send({ error: 'Song search is temporarily unavailable.', done: true }))
        .finally(() => { if (!closed) { closed = true; controller.close(); } });
    },
    cancel() { closed = true; abort.abort(); },
  });
  return new Response(body, { headers: { ...headers, 'Content-Type': 'application/x-ndjson' } });
}
