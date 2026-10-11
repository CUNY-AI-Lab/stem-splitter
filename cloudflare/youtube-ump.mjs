import { CompositeBuffer, UmpReader, UmpWriter } from 'googlevideo/ump';
import { UMPPartId, FormatInitializationMetadata, MediaHeader, StreamProtectionStatus } from 'googlevideo/protos';
import { UmpAudioError, validateWebmInit } from './youtube-webm.mjs';

const BODY_LIMIT = 8 * 1024 * 1024, OBSERVED_LIMIT = 96 * 1024 * 1024;
const AUDIO_LIMIT = 12 * 1024 * 1024, SEGMENT_LIMIT = 2 * 1024 * 1024, INIT_LIMIT = 128 * 1024;
const MIME = 'audio/webm; codecs="opus"';
const check = (condition, code) => { if (!condition) throw new UmpAudioError(code); };
const whole = (value, maximum = Number.MAX_SAFE_INTEGER) => {
  check(typeof value === 'string' ? /^\d+$/.test(value) : Number.isSafeInteger(value), 'invalid_integer');
  const number = Number(value); check(Number.isSafeInteger(number) && number >= 0 && number <= maximum, 'integer_bound'); return number;
};
const concatenate = chunks => {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0; for (const chunk of chunks) { output.set(chunk, at); at += chunk.length; } return output;
};
const same = (a, b) => a.length === b.length && a.every((byte, at) => byte === b[at]);
const formatKey = format => {
  check(format && whole(format.itag, 10000) > 0 && /^\d{1,24}$/.test(String(format.lastModified))
    && typeof format.xtags === 'string' && format.xtags.length <= 1024, 'invalid_format');
  return JSON.stringify([format.itag, String(format.lastModified), format.xtags]);
};

/** Collect completed ordinary browser responses once. This module performs no requests. */
export function createCapturedUmpCollector({ videoId, durationMs: expectedDurationMs, maximumAudioBytes = AUDIO_LIMIT } = {}) {
  check(typeof videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(videoId), 'invalid_fixture');
  check(Number.isFinite(expectedDurationMs) && expectedDurationMs > 0 && expectedDurationMs <= 900000, 'invalid_expected_duration');
  check(Number.isSafeInteger(maximumAudioBytes) && maximumAudioBytes > 0 && maximumAudioBytes <= AUDIO_LIMIT, 'invalid_audio_limit');
  const formats = new Map(), segments = new Map(), protectionStatuses = new Set();
  let selected, audioBytes = 0, observedBytes = 0, bodyCount = 0, partCount = 0, failure;

  // A terminal parse failure invalidates the collector, including prior partial audio.
  const guarded = operation => {
    if (failure) throw failure;
    try { return operation(); }
    catch (error) { failure = error instanceof UmpAudioError ? error : new UmpAudioError('invalid_ump'); throw failure; }
  };
  const progress = () => guarded(() => {
    const totalDurationMs = selected?.durationMs ?? expectedDurationMs;
    let end = 0, through = 0;
    if (selected && segments.has(0)) {
      for (let sequence = 1; sequence <= selected.endSequence; sequence++) {
        const segment = segments.get(sequence); if (!segment) break;
        check(Math.abs(segment.start - end) <= 50, 'coverage_gap');
        end = segment.start + segment.duration; through = sequence;
      }
    }
    const allSegments = Boolean(selected && segments.has(0) && through === selected.endSequence);
    if (allSegments) {
      check(Math.abs(end - totalDurationMs) <= 50, 'incomplete_duration');
      validateWebmInit(segments.get(0).data, audioBytes);
    }
    return { complete: allSegments, contiguousDurationMs: end, nextMissingStartMs: allSegments ? null : end,
      totalDurationMs, retainedAudioBytes: audioBytes };
  });
  const metadataPart = part => {
    check(part.size <= 65536, 'metadata_bound'); return concatenate(part.data.chunks);
  };
  const acceptFormat = raw => {
    check(raw.videoId === videoId, 'fixture_mismatch');
    const key = formatKey(raw.formatId);
    check(typeof raw.mimeType === 'string' && raw.mimeType.length <= 160, 'invalid_format');
    // Retain only fields needed for stable identity and audio completeness.
    const value = { key, itag: raw.formatId.itag, mimeType: raw.mimeType };
    if (value.mimeType === MIME) {
      const scale = whole(raw.durationTimescale);
      value.durationMs = scale > 0 ? whole(raw.durationUnits) * 1000 / scale : whole(raw.endTimeMs);
      value.endSequence = whole(raw.endSegmentNumber, 256);
      check(value.endSequence > 0 && value.durationMs > 0 && value.durationMs <= 900000
        && Math.abs(value.durationMs - expectedDurationMs) <= 1000, 'duration_bound');
      check(!selected || selected.key === key, 'ambiguous_audio_track');
    }
    const previous = formats.get(key);
    check(!previous || JSON.stringify(previous) === JSON.stringify(value), 'format_changed');
    check(previous || formats.size < 32, 'format_count');
    formats.set(key, value);
    if (value.mimeType === MIME) selected = value;
  };
  const consume = bytes => guarded(() => {
    check(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= BODY_LIMIT, 'input_bound');
    observedBytes += bytes.length;
    check(observedBytes <= OBSERVED_LIMIT && ++bodyCount <= 256, 'observed_bound');
    // Header IDs are local to a single response; only completed audio segments survive it.
    const pending = new Map(); let consumedBytes = 0;
    const incomplete = new UmpReader(new CompositeBuffer([bytes])).read(part => {
      check(++partCount <= 32768 && part.size <= BODY_LIMIT, 'part_bound');
      const prefix = new CompositeBuffer(), writer = new UmpWriter(prefix);
      writer.writeVarInt(part.type); writer.writeVarInt(part.size); consumedBytes += prefix.getLength() + part.size;
      if ([UMPPartId.SABR_ERROR, UMPPartId.ONESIE_ENCRYPTED_MEDIA].includes(part.type)) throw new UmpAudioError('source_protection_or_error');
      if (part.type === UMPPartId.STREAM_PROTECTION_STATUS) {
        const status = StreamProtectionStatus.decode(metadataPart(part)).status;
        check([0, 1, 2].includes(status), 'source_protection_required'); protectionStatuses.add(status);
      } else if (part.type === UMPPartId.FORMAT_INITIALIZATION_METADATA) {
        acceptFormat(FormatInitializationMetadata.decode(metadataPart(part)));
      } else if (part.type === UMPPartId.MEDIA_HEADER) {
        const header = MediaHeader.decode(metadataPart(part)), id = whole(header.headerId, 255);
        check(header.videoId === videoId, 'fixture_mismatch'); check(!pending.has(id), 'header_reused');
        const key = formatKey(header.formatId ?? { itag: header.itag, lastModified: header.lmt, xtags: header.xtags });
        check(formats.has(key), 'unknown_format'); check(header.compressionAlgorithm === 0, 'compressed_media');
        const wanted = selected?.key === key;
        const length = whole(header.contentLength, wanted ? (header.isInitSeg ? INIT_LIMIT : SEGMENT_LIMIT) : BODY_LIMIT);
        check(length > 0, 'invalid_segment_length');
        let sequence, start, duration;
        if (wanted) {
          sequence = whole(header.sequenceNumber, 256);
          check(header.isInitSeg === (sequence === 0) && sequence <= selected.endSequence, 'invalid_segment_sequence');
          const scale = header.timeRange ? whole(header.timeRange.timescale) : 0;
          start = scale ? whole(header.timeRange.startTicks) * 1000 / scale : whole(header.startMs);
          duration = scale ? whole(header.timeRange.durationTicks) * 1000 / scale : whole(header.durationMs);
          check(sequence === 0 ? start === 0 && duration === 0 : duration > 0 && start + duration <= selected.durationMs + 50, 'invalid_segment_duration');
        }
        pending.set(id, { wanted, sequence, start, duration, length, received: 0, chunks: [] });
      } else if (part.type === UMPPartId.MEDIA || part.type === UMPPartId.MEDIA_END) {
        check(part.size >= 1, 'invalid_media_part');
        const id = part.data.getUint8(0), item = pending.get(id); check(item, 'unknown_media_header');
        if (part.type === UMPPartId.MEDIA) {
          item.received += part.size - 1; check(item.received <= item.length, 'segment_size_mismatch');
          // Discard video directly, without concatenating/copying its payload.
          if (item.wanted) item.chunks.push(...part.data.split(1).remainingBuffer.chunks);
        } else {
          check(part.size === 1 && item.received === item.length, 'incomplete_segment'); pending.delete(id);
          if (!item.wanted) return;
          const data = concatenate(item.chunks), existing = segments.get(item.sequence);
          if (existing) check(existing.start === item.start && existing.duration === item.duration && same(existing.data, data), 'segment_changed');
          else {
            check(audioBytes + data.length <= maximumAudioBytes, 'audio_bound');
            if (item.sequence === 0) validateWebmInit(data);
            audioBytes += data.length;
            segments.set(item.sequence, { start: item.start, duration: item.duration, data });
          }
        }
      }
    });
    check(!incomplete && consumedBytes === bytes.length, 'incomplete_ump');
    check(pending.size === 0, 'incomplete_segment');
    return progress();
  });
  const result = () => guarded(() => {
    if (!progress().complete) return null;
    const chunks = [];
    for (let sequence = 0; sequence <= selected.endSequence; sequence++) chunks.push(segments.get(sequence).data);
    return { data: concatenate(chunks), mimeType: 'audio/webm', durationMs: selected.durationMs,
      metadata: { fixtureId: videoId, itag: selected.itag, container: 'webm', codec: 'opus', mimeType: MIME,
        durationSeconds: selected.durationMs / 1000, segments: selected.endSequence, bytes: audioBytes,
        protectionStatuses: [...protectionStatuses].sort() } };
  });
  return Object.freeze({ consume, progress, result });
}
