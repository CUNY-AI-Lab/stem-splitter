import { archiveSongSearchResponse } from './archive-search-response.ts';
import { searchOpenAudio, type OpenAudioTrack } from './open-audio.ts';
import type { PublicSearchCache } from './musicbrainz.ts';
import type { ArchiveSong } from './archive.ts';
type Provider = 'archive' | 'commons' | 'freesound' | 'loc';
type AudioTrack = (ArchiveSong | OpenAudioTrack) & { providerName: string };
type SearchResult = { results: AudioTrack[]; references: never[]; providers: Record<Provider, 'pending' | 'ready' | 'unavailable'> };
type Context = { db: D1Database; maximumSeconds: number; signal?: AbortSignal; cache?: PublicSearchCache };

/** Federate discovery only. Every import still passes its existing provider's rights/byte checks. */
export async function musicSearchResponse(query: string, streaming: boolean, context: Context): Promise<Response> {
  if (query.trim().length < 2 || query.length > 120) return Response.json({ error: 'Enter a song or artist using 2–120 characters.' }, { status: 400 });
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, ...(context.signal ? [context.signal] : [])]);
  const headers = { 'Cache-Control': 'private, no-store' };
  const run = async (emit: (value: SearchResult) => void): Promise<SearchResult> => {
    const tracks = new Map<string, AudioTrack>();
    const counts = { archive: 0, commons: 0, freesound: 0, loc: 0 };
    const result: SearchResult = { results: [], references: [], providers: { archive: 'pending', commons: 'pending', freesound: 'pending', loc: 'pending' } };
    const publish = () => { result.results = [...tracks.values()]; if (!signal.aborted) emit(result); };
    const add = (provider: Provider, items: (ArchiveSong | OpenAudioTrack)[]) => {
      for (const track of items.slice(0, 4)) {
        const key = `${provider}:${track.id}`;
        if (!tracks.has(key)) {
          if (counts[provider] >= 4) continue;
          counts[provider]++;
        }
        tracks.set(key, { ...track, providerName: provider === 'archive' ? 'Internet Archive' : (track as OpenAudioTrack).providerName });
      }
      publish();
    };
    const provider = async (name: Provider, work: () => Promise<void>) => {
      try { signal.throwIfAborted(); await work(); result.providers[name] = 'ready'; }
      catch { result.providers[name] = 'unavailable'; }
      publish();
    };
    await Promise.all([
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
              if (Array.isArray(batch.results)) add('archive', batch.results);
              if (batch.done) done = true;
            }
          }
          if (!done) throw new Error('Archive search interrupted');
        } finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }),
      ...(['commons', 'freesound', 'loc'] as const).map(name => provider(name, async () => {
        const key = context.cache && new Request(new URL('/__audio-search/v2/' + name + '?seconds=' + context.maximumSeconds + '&q=' + encodeURIComponent(query.trim().toLowerCase()), context.cache.origin));
        let value: { results: OpenAudioTrack[] } | undefined;
        if (key && context.cache) { try { const hit = await context.cache.storage.match(key); if (hit?.ok) value = await hit.json(); } catch {} }
        if (!value) {
          value = await searchOpenAudio(name, query, { ...context, signal });
          if (key && context.cache && !signal.aborted) { try { await context.cache.storage.put(key, Response.json(value, { headers: { 'Cache-Control': 'public, max-age=600' } })); } catch {} }
        }
        add(name, value.results);
      })),
    ]);
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
