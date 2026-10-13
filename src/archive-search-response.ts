import { ArchiveError, searchArchiveSongs } from './archive.ts';

/** Called after the route's access check; ordinary JSON clients retain their contract. */
export async function archiveSongSearchResponse(query: string, streaming: boolean): Promise<Response> {
  const message = (error: unknown) => error instanceof ArchiveError ? error.message : 'Song search is temporarily unavailable.';
  if (!streaming) {
    try { return Response.json(await searchArchiveSongs(query)); }
    catch (error) { return Response.json({ error: message(error) }, { status: 502 }); }
  }
  let closed = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (value: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(JSON.stringify(value) + '\n'));
      };
      send({ results: [], done: false });
      void searchArchiveSongs(query, results => send({ ...results, done: false }))
        .then(results => send({ ...results, done: true }), error => send({ error: message(error), done: true }))
        .finally(() => { if (!closed) { closed = true; controller.close(); } });
    },
    cancel() { closed = true; },
  });
  return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'private, no-store' } });
}
