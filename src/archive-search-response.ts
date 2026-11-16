import { ArchiveError, archiveSongSearchKey, searchArchiveSongs, type SongResults } from './archive.ts';

type SearchCache = { storage: Pick<Cache, 'match' | 'put'>; origin: string };

/** Called after access checks. Cache only public, verified results, never an account response. */
export async function archiveSongSearchResponse(query: string, streaming: boolean, cache?: SearchCache, maximumSeconds = 300): Promise<Response> {
  const message = (error: unknown) => error instanceof ArchiveError ? error.message : 'Song search is temporarily unavailable.';
  // Bump this path when result eligibility changes; imports always revalidate.
  const durationLimit = maximumSeconds === 900 ? 900 : 300;
  const address = (path: string) => cache && new Request(new URL(`${path}?seconds=${durationLimit}&q=` + encodeURIComponent(archiveSongSearchKey(query)), cache.origin));
  const key = address('/__stem-search-cache/v5');
  // Kept for a week, and read only when a search fails. Imports re-check the file, so an old list cannot import stale audio.
  const lastGoodKey = address('/__stem-search-cache/v5/last-good');
  let cached: SongResults | undefined;
  if (cache && key) {
    try {
      const hit = await cache.storage.match(key);
      if (hit?.ok) {
        const value = await hit.json() as SongResults;
        if (Array.isArray(value.results) && value.results.length > 0 && value.results.length <= 8) cached = value;
      }
    } catch { /* Cache availability must never block Archive search. */ }
  }
  const headers = { 'Cache-Control': 'private, no-store', 'X-Stem-Search-Cache': cached ? 'hit' : cache ? 'miss' : 'bypass' };
  const lastGood = async (): Promise<SongResults | undefined> => {
    if (!cache || !lastGoodKey) return undefined;
    try {
      const hit = await cache.storage.match(lastGoodKey);
      if (!hit?.ok) return undefined;
      const value = await hit.json() as SongResults;
      return Array.isArray(value.results) && value.results.length > 0 && value.results.length <= 8 ? { ...value, fallback: true } : undefined;
    } catch { return undefined; }
  };
  const search = async (onResults?: (results: SongResults) => void) => {
    if (cached) return cached;
    let result: SongResults;
    try { result = await searchArchiveSongs(query, onResults, durationLimit); }
    catch (error) {
      const earlier = await lastGood();
      if (!earlier) throw error;
      onResults?.(earlier);
      return earlier;
    }
    if (cache && key && lastGoodKey && result.results.length) {
      // Results remain usable when cache writes fail.
      await Promise.allSettled([
        cache.storage.put(key, Response.json(result, { headers: { 'Cache-Control': 'public, max-age=60' } })),
        cache.storage.put(lastGoodKey, Response.json(result, { headers: { 'Cache-Control': 'public, max-age=604800' } })),
      ]);
    }
    return result;
  };
  if (!streaming) {
    try { return Response.json(await search(), { headers }); }
    catch (error) { return Response.json({ error: message(error) }, { status: 502, headers }); }
  }
  let closed = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (value: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(JSON.stringify(value) + '\n'));
      };
      send({ results: [], done: false });
      void search(results => send({ ...results, done: false }))
        .then(results => send({ ...results, done: true }), error => send({ error: message(error), done: true }))
        .finally(() => { if (!closed) { closed = true; controller.close(); } });
    },
    cancel() { closed = true; },
  });
  return new Response(body, { headers: { ...headers, 'Content-Type': 'application/x-ndjson' } });
}
