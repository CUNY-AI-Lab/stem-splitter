import candidates from '../public/search-samples.json' with { type: 'json' };
import { archiveSongSearchKey, verifyArchiveSample, type SongResults } from './archive.ts';

// Only this public catalog may bypass sign-in. Ordinary searches, imports and
// account data retain their existing access checks.
type AllowedTrack = {artist:string;title:string;archiveId:string;archiveFile:string};
export function isPlaylistSample(request: Request, allowedCandidates: readonly AllowedTrack[] = candidates): boolean {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  return url.pathname === '/api/music/search' && allowedCandidates.some(track =>
    url.searchParams.get('sampleItem') === track.archiveId && url.searchParams.get('sampleFile') === track.archiveFile &&
    archiveSongSearchKey(url.searchParams.get('q') || '') === archiveSongSearchKey(`${track.artist} ${track.title}`));
}

const pending = new Map<string, Promise<SongResults>>();
const verified = new Map<string, { expires: number; data: SongResults }>();
export async function playlistSampleResponse(request: Request, storage?: Pick<Cache, 'match' | 'put'>, allowedCandidates: readonly AllowedTrack[] = candidates): Promise<Response> {
  if (!isPlaylistSample(request, allowedCandidates)) return Response.json({ results: [] }, { status: 400 });
  const url = new URL(request.url);
  const key = new URLSearchParams({ q: archiveSongSearchKey(url.searchParams.get('q') || ''), sampleItem: url.searchParams.get('sampleItem')!, sampleFile: url.searchParams.get('sampleFile')! }).toString();
  const cacheRequest = new Request(new URL('/__playlist-sample/v3?' + key, url.origin));
  const respond = (data: SongResults) => Response.json(data, { headers: { 'Cache-Control': 'public, max-age=60' } });
  const cached = verified.get(key);
  if (cached && cached.expires > Date.now()) return respond(cached.data);
  verified.delete(key);
  try {
    const hit = await storage?.match(cacheRequest);
    if (hit?.ok) return respond(await hit.json() as SongResults);
  } catch { /* Cache failures do not block live verification. */ }
  let work = pending.get(key);
  if (!work) {
    work = verifyArchiveSample(url.searchParams.get('q')!, url.searchParams.get('sampleItem')!, url.searchParams.get('sampleFile')!, 300)
      .catch(() => ({ results: [] }))
      .then(async data => {
        if (data.results.length) {
          if (verified.size >= 64) verified.delete(verified.keys().next().value!);
          verified.set(key, { expires: Date.now() + 60000, data });
          try { await storage?.put(cacheRequest, respond(data)); } catch { /* Optional cache. */ }
        }
        return data;
      }).finally(() => pending.delete(key));
    pending.set(key, work);
  }
  const data = await work;
  return data.results.length ? respond(data) : Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
}
