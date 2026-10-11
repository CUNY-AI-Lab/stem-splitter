import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchVimeoAudio, parseVimeoPlayerConfig, vimeoPlayerMetadata, vimeoAudioPlan, vimeoCdnUrl, validateVimeoInitialization, validateVimeoSegment } from '../src/vimeo.ts';
import { vimeoFixture, joinBytes, mp4Box } from './fixtures/vimeo.ts';

const VIDEO = 'https://vimeo.com/1084537';
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test('imports advertised audio in source order with the observed stable player request', async () => {
  const fixture = vimeoFixture(), calls: string[] = [], active = new Set<number>(); let maximum = 0;
  const result = await fetchVimeoAudio(VIDEO, { fetchImpl: (async (input, options) => {
    const url = String(input); calls.push(url);
    assert.equal(options?.redirect, 'manual'); assert.equal(options?.method, 'GET');
    const headers = new Headers(options?.headers);
    assert.equal(headers.has('Authorization'), false); assert.equal(headers.has('Cookie'), false);
    if (url.includes('player.vimeo.com')) {
      assert.equal(headers.get('Referer'), 'https://player.vimeo.com/video/1084537');
      assert.match(headers.get('Accept')!, /text\/html/); assert.match(headers.get('User-Agent')!, /Chrome\/147/);
    }
    if (url.endsWith('.m4s')) {
      const id = Number(url.at(-5)); active.add(id); maximum = Math.max(maximum, active.size);
      await new Promise(resolve => setTimeout(resolve, id === 1 ? 5 : 1)); active.delete(id);
    }
    return fixture.fetchImpl(input, options);
  }) as typeof fetch });
  assert.equal(calls.length, 4); assert.ok(maximum <= 4);
  assert.deepEqual(new Uint8Array(result.data), joinBytes(fixture.init, fixture.segment, fixture.segment));
  assert.equal(result.durationSec, 12); assert.equal(result.title, 'Public fixture');
});

test('balanced JSON accepts braces and escaped quotes inside titles and rejects script expressions', () => {
  const fixture = vimeoFixture(); fixture.config.video.title = 'A } brace and "quote"';
  assert.equal(parseVimeoPlayerConfig(`playerConfig = ${JSON.stringify(fixture.config)}; alert(1)`).video &&
    vimeoPlayerMetadata(parseVimeoPlayerConfig(`config = ${JSON.stringify(fixture.config)};`), '1084537').title, fixture.config.video.title);
  for (const html of ['playerConfig = (() => ({}))()', 'playerConfig = {', 'playerConfig = {"video": undefined}', '<div id="crawler_player"></div>']) {
    assert.throws(() => parseVimeoPlayerConfig(html), code('invalid_audio_response'));
  }
});

test('only HTTPS Vimeo CDN hosts resolve, including inherited relative paths', () => {
  assert.equal(vimeoCdnUrl('../audio/1.m4s', 'https://video.vimeocdn.com/path/master.json'), 'https://video.vimeocdn.com/audio/1.m4s');
  for (const url of ['http://video.vimeocdn.com/a', 'https://vimeocdn.com.evil/a', 'https://evilvimeocdn.com/a', 'https://user:pass@vimeocdn.com/a', 'https://vimeocdn.com:444/a', 'https://127.0.0.1/a', '//other.invalid/a', 'data:text/plain,a', 'https://vimeocdn.com/a#fragment']) {
    assert.throws(() => vimeoCdnUrl(url, 'https://video.vimeocdn.com/'), code('invalid_audio_response'));
  }
});

test('identity, privacy, live and duration validation runs before manifest retrieval', async () => {
  for (const [patch, expected] of [[{ id: 123 }, 'invalid_audio_response'], [{ privacy: 'password' }, 'youtube_source_denied'], [{ duration: 901 }, 'video_too_long'], [{ duration: 0 }, 'invalid_audio_response'], [{ live_event: { status: 'started' } }, 'live_stream'], [{ drm: true }, 'youtube_source_denied']] as const) {
    const fixture = vimeoFixture(); Object.assign(fixture.config.video, patch); let calls = 0;
    await assert.rejects(fetchVimeoAudio(VIDEO, { fetchImpl: (async () => {
      calls++; return new Response(`playerConfig=${JSON.stringify(fixture.config)}`, { headers: { 'Content-Type': 'text/html' } });
    }) as typeof fetch }), code(expected)); assert.equal(calls, 1);
  }
});

test('unlisted access hashes must match returned metadata', () => {
  const config = { ...vimeoFixture().config, video: { ...vimeoFixture().config.video, privacy: 'unlisted', unlisted_hash: 'ab12cd34ef' } };
  assert.equal(vimeoPlayerMetadata(config, '1084537', 'ab12cd34ef').durationSec, 12);
  assert.throws(() => vimeoPlayerMetadata(config, '1084537'), code('youtube_source_denied'));
  assert.throws(() => vimeoPlayerMetadata(config, '1084537', '1234567890'), code('youtube_source_denied'));
});

test('manifest selects the highest fitting clear AAC track and bounds timelines, segment counts and URLs', () => {
  const fixture = vimeoFixture(), manifestUrl = fixture.config.request.files.dash.cdns.default.url;
  const low = structuredClone(fixture.manifest.audio[0]); low.bitrate = 64000;
  fixture.manifest.audio.unshift(low);
  assert.equal(vimeoAudioPlan(fixture.manifest, manifestUrl, 12).bitrate, 149000);
  for (const mutate of [
    (audio: any) => { audio.segments[1].start = 8; },
    (audio: any) => { audio.segments[1].end = 11; },
    (audio: any) => { audio.segments[0].url = 'https://private.invalid/audio'; },
    (audio: any) => { audio.segments = Array(257).fill(audio.segments[0]); },
    (audio: any) => { audio.init_segment = 'invalid@'; },
    (audio: any) => { audio.duration = 901; },
    (audio: any) => { audio.segments[0].size = 2 * 1024 * 1024 + 1; },
  ]) {
    const next = vimeoFixture().manifest; mutate(next.audio[0]);
    assert.throws(() => vimeoAudioPlan(next, manifestUrl, 12), code('invalid_audio_response'));
  }
  const encrypted = vimeoFixture().manifest; Object.assign(encrypted.audio[0], { drm: { scheme: 'cenc' } });
  assert.throws(() => vimeoAudioPlan(encrypted, manifestUrl, 12), code('youtube_source_denied'));
});

test('audio size selection uses total bytes across all declared segments', () => {
  const fixture = vimeoFixture(), audio = fixture.manifest.audio[0];
  audio.segments = Array.from({ length: 7 }, (_, i) => ({ start: i * 2, end: (i + 1) * 2, size: 2 * 1024 * 1024, url: `${i}.m4s` })); audio.duration = 14;
  assert.throws(() => vimeoAudioPlan(fixture.manifest, fixture.config.request.files.dash.cdns.default.url, 14), code('audio_too_large'));
  const lower = structuredClone(audio); lower.bitrate = 64000; for (const segment of lower.segments) segment.size = 2000;
  fixture.manifest.audio.push(lower);
  assert.equal(vimeoAudioPlan(fixture.manifest, fixture.config.request.files.dash.cdns.default.url, 14).bitrate, 64000);
});

test('MP4 validation rejects protected tracks, malformed box bounds and video initialization', () => {
  const fixture = vimeoFixture(); validateVimeoInitialization(fixture.init); validateVimeoSegment(fixture.segment);
  assert.throws(() => validateVimeoSegment(joinBytes(mp4Box('moof', mp4Box('traf', mp4Box('senc'))), mp4Box('mdat'))), code('youtube_source_denied'));
  assert.throws(() => validateVimeoInitialization(joinBytes(fixture.init, mp4Box('pssh'))), code('youtube_source_denied'));
  const video = fixture.init.slice(), at = new TextDecoder().decode(video).indexOf('soun'); video.set(new TextEncoder().encode('vide'), at);
  assert.throws(() => validateVimeoInitialization(video), code('invalid_audio_response'));
  assert.throws(() => validateVimeoSegment(new Uint8Array([255, 255, 255, 255, 109, 100, 97, 116])), code('invalid_audio_response'));
});

test('access refusal and rate limit stop at one request without a provider or source fallback', async () => {
  for (const [status, expected] of [[401, 'youtube_source_denied'], [403, 'youtube_source_denied'], [451, 'youtube_source_denied'], [429, 'youtube_fetch_busy']] as const) {
    let calls = 0;
    await assert.rejects(fetchVimeoAudio(VIDEO, { fetchImpl: (async () => { calls++; return new Response('', { status }); }) as typeof fetch }), code(expected));
    assert.equal(calls, 1);
  }
});

test('rejects off-origin redirects, metadata size declarations and unexpected response types', async () => {
  for (const response of [new Response(null, { status: 302, headers: { Location: 'https://example.com/' } }),
    new Response('', { headers: { 'Content-Type': 'text/html', 'Content-Length': String(2 * 1024 * 1024 + 1) } }),
    new Response('{}', { headers: { 'Content-Type': 'application/json' } })]) {
    let calls = 0;
    await assert.rejects(fetchVimeoAudio(VIDEO, { fetchImpl: (async () => { calls++; return response; }) as typeof fetch }));
    assert.equal(calls, 1);
  }
});

test('cancels concurrent segment requests upon one refusal and rejects truncated media', async () => {
  for (const refused of [false, true]) {
    const fixture = vimeoFixture(); let calls = 0;
    await assert.rejects(fetchVimeoAudio(VIDEO, { fetchImpl: (async (input, options) => {
      calls++;
      if (String(input).endsWith('1.m4s')) return refused ? new Response(null, { status: 403 }) : new Response(fixture.segment.subarray(0, 100), { headers: { 'Content-Type': 'audio/mp4' } });
      return fixture.fetchImpl(input, options);
    }) as typeof fetch }), code(refused ? 'youtube_source_denied' : 'invalid_audio_response'));
    assert.ok(calls <= 4);
  }
});

test('deadline includes stalled bodies and an expired original operation starts no request', async () => {
  let calls = 0;
  await assert.rejects(fetchVimeoAudio(VIDEO, { now: () => 100, deadline: 99, fetchImpl: (async () => { calls++; throw new Error(); }) as typeof fetch }), code('youtube_fetch_timeout'));
  assert.equal(calls, 0);
  let canceled = false;
  await assert.rejects(fetchVimeoAudio(VIDEO, { deadline: Date.now() + 30, fetchImpl: (async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'Content-Type': 'text/html' } })) as typeof fetch }), code('youtube_fetch_timeout'));
  assert.equal(canceled, true);
});

test('manifest redirects retain approved origins and resolve media against the final location', async () => {
  const fixture = vimeoFixture(), calls: string[] = [];
  await fetchVimeoAudio(VIDEO, { fetchImpl: (async (input, options) => {
    const url = String(input); calls.push(url);
    if (url === fixture.config.request.files.dash.cdns.default.url) return new Response(null, { status: 302, headers: { Location: 'https://other.vimeocdn.com/relocated/master.json' } });
    if (url.endsWith('/relocated/master.json')) return Response.json(fixture.manifest);
    if (url.startsWith('https://other.vimeocdn.com/relocated/audio/')) return new Response(fixture.segment, { headers: { 'Content-Type': 'video/mp4' } });
    return fixture.fetchImpl(input, options);
  }) as typeof fetch });
  assert.equal(calls.length, 5);
  assert.equal(calls.filter(url => url.startsWith('https://other.vimeocdn.com/relocated/audio/')).length, 2);
});

test('segment downloads are capped at four concurrent requests', async () => {
  const fixture = vimeoFixture(); fixture.config.video.duration = 48; fixture.manifest.audio[0].duration = 48;
  fixture.manifest.audio[0].segments = Array.from({ length: 8 }, (_, index) => ({ start: index * 6, end: (index + 1) * 6, url: `${index}.m4s`, size: fixture.segment.byteLength }));
  let active = 0, maximum = 0, total = 0;
  await fetchVimeoAudio(VIDEO, { fetchImpl: (async input => {
    const url = String(input);
    if (url.includes('player.vimeo.com')) return new Response(`playerConfig=${JSON.stringify(fixture.config)}`, { headers: { 'Content-Type': 'text/html' } });
    if (url.endsWith('master.json')) return Response.json(fixture.manifest);
    active++; maximum = Math.max(maximum, active); total++;
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return new Response(fixture.segment, { headers: { 'Content-Type': 'audio/mp4' } });
  }) as typeof fetch });
  assert.equal(maximum, 4); assert.equal(total, 8);
});

test('streamed metadata and media honor actual byte bounds without Content-Length', async () => {
  let metadataCanceled = false;
  await assert.rejects(fetchVimeoAudio(VIDEO, { fetchImpl: (async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel() { metadataCanceled = true; },
  }), { headers: { 'Content-Type': 'text/html' } })) as typeof fetch }), code('audio_too_large'));
  assert.equal(metadataCanceled, true);
  const fixture = vimeoFixture();
  await assert.rejects(fetchVimeoAudio(VIDEO, { fetchImpl: (async (input, options) => String(input).endsWith('.m4s')
    ? new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'audio/mp4' } })
    : fixture.fetchImpl(input, options)) as typeof fetch }), code('audio_too_large'));
});

test('manifest segment byte estimates may exceed or fall below the actual valid media size', async () => {
  for (const delta of [-4, 4]) {
    const fixture = vimeoFixture(); for (const segment of fixture.manifest.audio[0].segments) segment.size += delta;
    const result = await fetchVimeoAudio(VIDEO, { fetchImpl: (async (input, options) => String(input).endsWith('master.json')
      ? Response.json(fixture.manifest) : fixture.fetchImpl(input, options)) as typeof fetch });
    assert.equal(result.data.byteLength, fixture.init.byteLength + 2 * fixture.segment.byteLength);
    assert.deepEqual(new Uint8Array(result.data), joinBytes(fixture.init, fixture.segment, fixture.segment));
  }
});

test('actual aggregate bytes stop at12MiB even when manifest estimates fit', async () => {
  const fixture = vimeoFixture(); fixture.config.video.duration = 42; fixture.manifest.audio[0].duration = 42;
  fixture.manifest.audio[0].segments = Array.from({ length: 7 }, (_, index) => ({ start: index * 6, end: (index + 1) * 6, url: `${index}.m4s`, size: 1200 }));
  const media = joinBytes(mp4Box('moof', mp4Box('traf')), mp4Box('mdat', new Uint8Array(2 * 1024 * 1024 - 24)));
  let signals: AbortSignal[] = [];
  await assert.rejects(fetchVimeoAudio(VIDEO, { fetchImpl: (async (input, options) => {
    if (String(input).includes('player.vimeo.com')) return new Response(`playerConfig=${JSON.stringify(fixture.config)}`, { headers: { 'Content-Type': 'text/html' } });
    if (String(input).endsWith('master.json')) return Response.json(fixture.manifest);
    signals.push(options!.signal!);
    return new Response(media, { headers: { 'Content-Type': 'audio/mp4' } });
  }) as typeof fetch }), code('audio_too_large'));
  assert.ok(signals.every(signal => signal.aborted));
});
