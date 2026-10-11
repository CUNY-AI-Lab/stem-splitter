import test from 'node:test';
import assert from 'node:assert/strict';
import { CompositeBuffer, UmpWriter } from 'googlevideo/ump';
import { UMPPartId as P, FormatInitializationMetadata as F, MediaHeader as H, StreamProtectionStatus as S } from 'googlevideo/protos';
import { createCapturedUmpCollector } from './youtube-ump.mjs';
import { validateWebmInit } from './youtube-webm.mjs';

const options = { videoId: 'jNQXAC9IVRw', durationMs: 19000 };
const audioKey = { itag: 251, lastModified: '123456', xtags: '' }, videoKey = { itag: 395, lastModified: '123457', xtags: '' };
const code = expected => error => error.code === expected;
const element = (hex, payload) => Buffer.concat([Buffer.from(hex, 'hex'), Buffer.from([128 + payload.length]), payload]);
const init = Buffer.concat([element('1a45dfa3', element('4282', Buffer.from('webm'))), Buffer.from('18538067ff', 'hex'),
  element('1654ae6b', element('ae', Buffer.concat([element('83', Buffer.from([2])), element('86', Buffer.from('A_OPUS'))]))) ]);
const media = [Buffer.from('1f43b675880000000000000000', 'hex'), Buffer.from('1f43b675880000000000000001', 'hex')];
const format = (key = audioKey, videoId = options.videoId) => [P.FORMAT_INITIALIZATION_METADATA, F.encode({ videoId, formatId: key,
  mimeType: key === audioKey ? 'audio/webm; codecs="opus"' : 'video/mp4; codecs="av01"', endTimeMs: '19000', endSegmentNumber: '2', durationUnits: '19000', durationTimescale: '1000' }).finish()];
function segment(sequence, { data = sequence === 0 ? init : media[sequence - 1], key = audioKey, id = 0, start = sequence === 2 ? 10000 : 0,
  duration = sequence === 0 ? 0 : sequence === 1 ? 10000 : 9000, declared = data.length, videoId = options.videoId } = {}) {
  return [[P.MEDIA_HEADER, H.encode({ headerId: id, videoId, formatId: key, itag: key.itag, lmt: key.lastModified, xtags: '',
    isInitSeg: sequence === 0, sequenceNumber: sequence, startMs: String(start), durationMs: String(duration), contentLength: String(declared) }).finish()],
  [P.MEDIA, Buffer.concat([Buffer.from([id]), data])], [P.MEDIA_END, Buffer.from([id])]];
}
function body(...parts) {
  const buffer = new CompositeBuffer(), writer = new UmpWriter(buffer);
  for (const [type, bytes] of parts) writer.write(type, bytes);
  return Buffer.concat(buffer.chunks);
}
const first = () => body(format(), ...segment(0), ...segment(1));
const second = () => body(...segment(2));

test('split responses accumulate once, with response-local reused header IDs', () => {
  const collector = createCapturedUmpCollector(options);
  assert.deepEqual(collector.progress(), { complete: false, contiguousDurationMs: 0, nextMissingStartMs: 0, totalDurationMs: 19000, retainedAudioBytes: 0 });
  assert.equal(collector.result(), null);
  assert.deepEqual(collector.consume(first()), { complete: false, contiguousDurationMs: 10000, nextMissingStartMs: 10000, totalDurationMs: 19000, retainedAudioBytes: init.length + media[0].length });
  assert.equal(collector.result(), null);
  assert.equal(collector.consume(second()).complete, true);
  const result = collector.result(); assert.equal(result.mimeType, 'audio/webm');
  assert.deepEqual(Buffer.from(result.data), Buffer.concat([init, ...media]));
});
test('missing initialization keeps the next missing time at zero until it arrives', () => {
  const collector = createCapturedUmpCollector(options);
  collector.consume(body(format(), ...segment(1), ...segment(2)));
  assert.equal(collector.progress().contiguousDurationMs, 0); assert.equal(collector.progress().nextMissingStartMs, 0); assert.equal(collector.result(), null);
  assert.equal(collector.consume(body(...segment(0))).complete, true);
});
test('out-of-order segment completion exposes only the contiguous audio prefix', () => {
  const collector = createCapturedUmpCollector(options); collector.consume(body(format(), ...segment(0), ...segment(2)));
  assert.equal(collector.progress().nextMissingStartMs, 0);
  assert.equal(collector.consume(body(...segment(1))).complete, true);
});
test('identical duplicate segments preserve byte count and changed duplicates are terminal', () => {
  const collector = createCapturedUmpCollector(options); collector.consume(first()); collector.consume(second());
  const retained = collector.progress().retainedAudioBytes;
  collector.consume(first()); collector.consume(second()); assert.equal(collector.progress().retainedAudioBytes, retained);
  const changed = Buffer.from(media[1]); changed[changed.length - 1] ^= 1;
  assert.throws(() => collector.consume(body(...segment(2, { data: changed }))), code('segment_changed'));
  assert.throws(() => collector.result(), code('segment_changed'));
});
test('large ignored video payload is bounded by its response and never retained as audio', () => {
  const collector = createCapturedUmpCollector(options);
  const largeVideo = Buffer.alloc(3 * 1024 * 1024);
  const state = collector.consume(body(format(videoKey), ...segment(1, { data: largeVideo, key: videoKey }), format(), ...segment(0), ...segment(1)));
  assert.equal(state.retainedAudioBytes, init.length + media[0].length);
  collector.consume(second()); assert.deepEqual(Buffer.from(collector.result().data), Buffer.concat([init, ...media]));
});
test('individual response and cumulative observed limits also cover discarded video', () => {
  const collector = createCapturedUmpCollector(options);
  assert.throws(() => collector.consume(new Uint8Array(8 * 1024 * 1024 + 1)), code('input_bound'));
  const next = createCapturedUmpCollector(options), large = body(format(videoKey), ...segment(1, { data: Buffer.alloc(7 * 1024 * 1024), key: videoKey }));
  for (let i = 0; i < 13; i++) next.consume(large);
  assert.equal(next.progress().retainedAudioBytes, 0);
  assert.throws(() => next.consume(large), code('observed_bound'));
});
test('selected audio retains its own segment and total limits', () => {
  const collector = createCapturedUmpCollector(options);
  assert.throws(() => collector.consume(body(format(), ...segment(1, { declared: 2 * 1024 * 1024 + 1 }))), code('integer_bound'));
  const next = createCapturedUmpCollector({ ...options, maximumAudioBytes: init.length + media[0].length }); next.consume(first());
  assert.throws(() => next.consume(second()), code('audio_bound'));
});
test('wrong identity, source protection, encryption and changed metadata poison the collector', () => {
  for (const [input, expected] of [
    [body(format(audioKey, 'abcdefghijk')), 'fixture_mismatch'],
    [body([P.STREAM_PROTECTION_STATUS, S.encode({ status: 3 }).finish()]), 'source_protection_required'],
    [body([P.ONESIE_ENCRYPTED_MEDIA, new Uint8Array()]), 'source_protection_or_error'],
  ]) { const collector = createCapturedUmpCollector(options); assert.throws(() => collector.consume(input), code(expected)); assert.throws(() => collector.progress(), code(expected)); }
  const collector = createCapturedUmpCollector(options); collector.consume(first());
  const changed = F.decode(format()[1]); changed.endSegmentNumber = '3';
  assert.throws(() => collector.consume(body([P.FORMAT_INITIALIZATION_METADATA, F.encode(changed).finish()])), code('format_changed'));
});
test('incomplete response frames and incomplete response-local media stay terminal', () => {
  const collector = createCapturedUmpCollector(options), raw = first();
  assert.throws(() => collector.consume(raw.subarray(0, raw.length - 1)), code('incomplete_ump'));
  const next = createCapturedUmpCollector(options);
  assert.throws(() => next.consume(body(format(), ...segment(1).slice(0, 2))), code('incomplete_segment'));
});
test('adjacent segment timing must match before completion', () => {
  const collector = createCapturedUmpCollector(options); collector.consume(first());
  assert.throws(() => collector.consume(body(...segment(2, { start: 10500, duration: 8500 }))), code('coverage_gap'));
});
test('input buffers are released after audio is copied', () => {
  const collector = createCapturedUmpCollector(options), a = first(), b = second();
  collector.consume(a); collector.consume(b); a.fill(0); b.fill(0);
  assert.deepEqual(Buffer.from(collector.result().data), Buffer.concat([init, ...media]));
});

function initialization({ trackType = 2, codec = 'A_OPUS', extra = Buffer.alloc(0), tracks = 1, knownSize = false } = {}) {
  const track = element('ae', Buffer.concat([element('83', Buffer.from([trackType])), element('86', Buffer.from(codec)), extra]));
  const payload = element('1654ae6b', Buffer.concat(Array.from({ length: tracks }, () => track)));
  const header = element('1a45dfa3', element('4282', Buffer.from('webm')));
  const segmentHeader = Buffer.concat([Buffer.from('18538067', 'hex'), Buffer.from([knownSize ? 128 + payload.length + media.reduce((sum, data) => sum + data.length, 0) : 255])]);
  return Buffer.concat([header, segmentHeader, payload]);
}

test('WebM initialization identifies a single clear Opus audio track', () => {
  validateWebmInit(initialization());
  for (const option of [{ trackType: 1 }, { codec: 'A_VORBIS' }, { tracks: 2 }]) {
    assert.throws(() => validateWebmInit(initialization(option)), code('invalid_audio_track'));
  }
  for (const tag of ['6d80', '5035', 'e0']) {
    assert.throws(() => validateWebmInit(initialization({ extra: element(tag, Buffer.alloc(0)) })), code('protected_or_video_track'));
  }
  const collector = createCapturedUmpCollector(options);
  assert.throws(() => collector.consume(body(format(), ...segment(0, { data: initialization({ extra: element('6d80', Buffer.alloc(0)) }) }))), code('protected_or_video_track'));
  assert.throws(() => collector.result(), code('protected_or_video_track'));
});

test('known WebM container length is checked against fully assembled audio', () => {
  const known = initialization({ knownSize: true }), total = known.length + media.reduce((sum, data) => sum + data.length, 0);
  validateWebmInit(known); validateWebmInit(known, total);
  assert.throws(() => validateWebmInit(known, total - 1), code('segment_container_length'));
  const collector = createCapturedUmpCollector(options);
  collector.consume(body(format(), ...segment(0, { data: known }), ...segment(1), ...segment(2)));
  assert.equal(collector.result().data.length, total);
});

test('truncated and malformed initialization remains terminal', () => {
  assert.throws(() => validateWebmInit(init.subarray(0, 15)), code('invalid_initialization'));
  const malformed = Buffer.from(init); malformed[4] = 0;
  assert.throws(() => validateWebmInit(malformed), code('invalid_ebml'));
  const foreignContainer = Buffer.from(init); foreignContainer[0] = 0;
  assert.throws(() => validateWebmInit(foreignContainer), code('invalid_initialization'));
});

test('advertised MP4 audio is never labeled or assembled as WebM', () => {
  const metadata = F.decode(format()[1]); metadata.mimeType = 'audio/mp4; codecs="mp4a.40.2"';
  const collector = createCapturedUmpCollector(options);
  collector.consume(body([P.FORMAT_INITIALIZATION_METADATA, F.encode(metadata).finish()], ...segment(0), ...segment(1), ...segment(2)));
  assert.equal(collector.progress().retainedAudioBytes, 0); assert.equal(collector.result(), null);
});

test('duration, metadata changes, and distinct audio identities are bounded independently', () => {
  assert.throws(() => createCapturedUmpCollector({ ...options, durationMs: 900001 }), code('invalid_expected_duration'));
  const mismatch = createCapturedUmpCollector({ ...options, durationMs: 30000 });
  assert.throws(() => mismatch.consume(first()), code('duration_bound'));
  const ambiguous = createCapturedUmpCollector(options); ambiguous.consume(first());
  const metadata = F.decode(format()[1]); metadata.formatId.lastModified = '999999';
  assert.throws(() => ambiguous.consume(body([P.FORMAT_INITIALIZATION_METADATA, F.encode(metadata).finish()])), code('ambiguous_audio_track'));
});
