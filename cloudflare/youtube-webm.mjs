// Validate only the initialization delivered by ordinary browser playback.
const AUDIO_LIMIT = 12 * 1024 * 1024;
export class UmpAudioError extends Error { constructor(code) { super(code); this.code = code; } }
const check = (condition, code) => { if (!condition) throw new UmpAudioError(code); };
const text = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

/** A bounded EBML walk over initialization only: one clear Opus audio track. */
export function validateWebmInit(bytes, totalAudioBytes) {
  check(bytes.length >= 32 && bytes.length <= 128 * 1024, 'invalid_initialization');
  const vint = (at, id) => {
    check(at < bytes.length && bytes[at] !== 0, 'invalid_ebml');
    let width = 1, mask = 128;
    while (!(bytes[at] & mask)) { width++; mask >>= 1; }
    check(width <= (id ? 4 : 8) && at + width <= bytes.length, 'invalid_ebml');
    let value = BigInt(id ? bytes[at] : bytes[at] & (mask - 1));
    for (let i = 1; i < width; i++) value = value * 256n + BigInt(bytes[at + i]);
    return { value, width, unknown: !id && value === (1n << BigInt(width * 7)) - 1n };
  };
  let docType = '', tracks = 0, trackType = 0, codec = '', elements = 0;
  const walk = (from, until, depth = 0) => {
    check(depth < 12, 'invalid_ebml');
    for (let at = from; at < until;) {
      check(++elements <= 1024, 'invalid_ebml');
      const id = vint(at, true); at += id.width;
      const size = vint(at, false); at += size.width;
      check(!size.unknown || id.value === 0x18538067n, 'invalid_ebml');
      const declaredEnd = at + Number(size.value);
      if (id.value === 0x18538067n && !size.unknown) {
        check(declaredEnd <= AUDIO_LIMIT && (totalAudioBytes === undefined || declaredEnd === totalAudioBytes), 'segment_container_length');
      }
      // A WebM initialization contains the beginning of Segment; its declared
      // length includes the separately delivered media clusters.
      const end = size.unknown || id.value === 0x18538067n ? Math.min(until, size.unknown ? until : declaredEnd) : declaredEnd;
      check(Number.isSafeInteger(end) && end <= until && end >= at, 'invalid_ebml');
      const number = Number(id.value);
      check(![0x6d80, 0x5035, 0xe0].includes(number), 'protected_or_video_track');
      if (number === 0x4282) docType = text(bytes.subarray(at, end));
      if (number === 0xae) tracks++;
      if (number === 0x83) { check(end - at === 1, 'invalid_ebml'); trackType = bytes[at]; }
      if (number === 0x86) codec = text(bytes.subarray(at, end));
      if ([0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe1].includes(number)) walk(at, end, depth + 1);
      at = end;
    }
  };
  check(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) === 0x1a45dfa3, 'invalid_initialization'); walk(0, bytes.length);
  check(docType === 'webm' && tracks === 1 && trackType === 2 && codec === 'A_OPUS', 'invalid_audio_track');
}
