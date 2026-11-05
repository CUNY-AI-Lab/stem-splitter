import { getRecordingReference, type RecordingReference, type PublicSearchCache } from './musicbrainz.ts';
import { parseArchiveIdentifier, searchReferencedArchiveItem, verifyArchiveSample, type ArchiveSong } from './archive.ts';
import { resolveCommonsRecordingPage, type OpenAudioTrack } from './open-audio.ts';

type Context = { db: D1Database; maximumSeconds: number; signal?: AbortSignal; cache?: PublicSearchCache };

/** Catalog links discover candidates, never grant rights or replace source IDs. */
export async function resolveReferenceAudio(references: RecordingReference[], context: Context,
  emit: (provider: 'archive' | 'commons', tracks: (ArchiveSong | OpenAudioTrack)[]) => void) {
  const signal = AbortSignal.any([AbortSignal.timeout(18000), ...(context.signal ? [context.signal] : [])]);
  const visited = new Set<string>();
  let pages = 0;
  // Bound extra metadata reads and repository lookups for an otherwise empty search.
  for (const reference of references.slice(0, 2)) {
    if (signal.aborted || pages >= 2) break;
    let detail: RecordingReference;
    try { detail = await getRecordingReference(reference.id, { ...context, signal }); } catch { continue; }
    for (const relation of detail.relations ?? []) {
      if (signal.aborted || pages >= 2) break;
      let url: URL; try { url = new URL(relation.url); } catch { continue; }
      if (visited.has(url.href)) continue;
      const archiveId = url.origin === 'https://archive.org' && !url.username && !url.password && !url.search && !url.hash
        ? parseArchiveIdentifier(url.href) : null;
      const commons = url.origin === 'https://commons.wikimedia.org' && url.pathname.startsWith('/wiki/File:');
      if (!archiveId && !commons) continue;
      visited.add(url.href); pages++;
      try {
        if (archiveId) {
          const query = `${detail.artist} ${detail.title}`.trim();
          if (!detail.artist || !detail.title || query.length > 120) continue;
          const parts = url.pathname.split('/');
          // An explicit file must never fall back to a different file in the item.
          if (!['download', 'details'].includes(parts[1])) continue;
          const file = decodeURIComponent(parts.slice(3).join('/'));
          const result = file ? await verifyArchiveSample(query, archiveId, file, context.maximumSeconds, signal)
            : await searchReferencedArchiveItem(archiveId, query, context.maximumSeconds, signal);
          if (!signal.aborted) emit('archive', result.results);
        } else {
          const result = await resolveCommonsRecordingPage(url.href, { ...context, signal });
          if (!signal.aborted) emit('commons', result.results);
        }
      } catch { /* One unavailable reference must not suppress other usable files. */ }
    }
  }
}
