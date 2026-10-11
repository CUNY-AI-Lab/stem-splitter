/** Structural MP4 fixtures for importer tests; they contain no source URLs or media. */
export function mp4Box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(8 + parts.reduce((sum, part) => sum + part.length, 0));
  new DataView(result.buffer).setUint32(0, result.length);
  result.set(new TextEncoder().encode(type), 4);
  let offset = 8;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
export function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
export function vimeoFixture() {
  const handler = new Uint8Array(12); handler.set(new TextEncoder().encode('soun'), 8);
  const stsdHeader = new Uint8Array(8); new DataView(stsdHeader.buffer).setUint32(4, 1);
  const init = joinBytes(mp4Box('ftyp', new TextEncoder().encode('isom0000')),
    mp4Box('moov', mp4Box('trak', mp4Box('mdia', mp4Box('hdlr', handler),
      mp4Box('minf', mp4Box('stbl', mp4Box('stsd', stsdHeader, mp4Box('mp4a', new Uint8Array(28)))))))));
  const segment = joinBytes(mp4Box('moof', mp4Box('traf')), mp4Box('mdat', new Uint8Array(1200)));
  const config = { view: 1, video: { id: 1084537, title: 'Public fixture', duration: 12, privacy: 'anybody', embed_permission: 'public', live_event: null },
    request: { files: { dash: { default_cdn: 'default', cdns: { default: { url: 'https://video.vimeocdn.com/path/master.json' } } } } } };
  const manifest = { clip_id: 'fixture', base_url: './', audio: [{ id: 'aac', base_url: 'audio/', format: 'mp42', mime_type: 'audio/mp4', codecs: 'mp4a.40.2',
    bitrate: 149000, duration: 12, channels: 2, sample_rate: 48000, init_segment: btoa(String.fromCharCode(...init)),
    segments: [{ start: 0, end: 6, url: '1.m4s', size: segment.byteLength }, { start: 6, end: 12, url: '2.m4s', size: segment.byteLength }] }] };
  const html = `<html><script>const playerConfig = ${JSON.stringify(config)};</script></html>`;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://player.vimeo.com/video/1084537') return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    if (url === config.request.files.dash.cdns.default.url) return Response.json(manifest);
    if (/^https:\/\/video\.vimeocdn\.com\/path\/audio\/[12]\.m4s$/.test(url)) return new Response(segment, { headers: { 'Content-Type': 'audio/mp4' } });
    throw new Error('Unexpected fixture request');
  }) as typeof fetch;
  return { config, manifest, html, init, segment, fetchImpl };
}
