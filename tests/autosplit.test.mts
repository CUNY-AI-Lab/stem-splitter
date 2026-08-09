// AutoSplit classifier tests against programmatically composed tracks.
//
// Each archetype is synthesized from timbral roles — voice-like sustained
// harmonics, struck membranes, plucked strings, hammered keys, drones —
// deliberately spanning ensembles well beyond a standard rock/pop band.
// These compositions are the tuning corpus for the thresholds in
// public/autosplit.js: adjust there, verify here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/autosplit.js';

const AutoSplit = (globalThis as Record<string, any>).AutoSplit as {
  extractFeatures(samples: Float32Array, sampleRate: number): Record<string, number | boolean>;
  chooseSplit(features: Record<string, number | boolean>): { choice: string; reason: string };
  pickModel(choice: string, models: { id: string; stems: string[] }[]): string;
  downmix(audioBuffer: {
    sampleRate: number;
    length: number;
    numberOfChannels: number;
    getChannelData(channel: number): Float32Array;
  }): Float32Array;
  resample(samples: Float32Array, fromRate: number, toRate?: number): Float32Array;
  TWO: string;
  FOUR: string;
  SIX: string;
  MAX_ANALYSIS_SECONDS: number;
  ANALYSIS_SAMPLE_RATE: number;
  MAX_BROWSER_DECODE_BYTES: number;
  MAX_BROWSER_DECODE_SECONDS: number;
  browserDecodeAllowed(byteLength: number, durationSeconds: number): boolean;
};

const SR = 22050;
const SECONDS = 12;
let randomState = 0x5eed1234;
function random(): number {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return (randomState >>> 0) / 0x1_0000_0000;
}

// --- composition helpers ----------------------------------------------------

function silence(): Float32Array {
  return new Float32Array(SR * SECONDS);
}

function mixInto(dest: Float32Array, src: Float32Array, at: number, gain = 1) {
  const offset = Math.floor(at * SR);
  for (let i = 0; i < src.length && offset + i < dest.length; i++) {
    dest[offset + i] += src[i] * gain;
  }
}

/** Sustained voice-like tone: harmonic stack, vibrato, slow envelope. */
function voice(freq: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const vib = 1 + 0.008 * Math.sin(2 * Math.PI * 5.5 * t);
    const f = freq * vib;
    let s = 0;
    for (let h = 1; h <= 6; h++) s += Math.sin(2 * Math.PI * f * h * t) / (h * 1.5);
    const env = Math.min(1, t / 0.25) * Math.min(1, (seconds - t) / 0.4);
    out[i] = s * env * 0.25;
  }
  return out;
}

/** Struck membrane: pitch-dropping sine thump plus a short noise burst. */
function membrane(baseFreq: number, seconds = 0.35): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const f = baseFreq * (1 + 0.8 * Math.exp(-t * 30));
    const body = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 9);
    const snap = (random() * 2 - 1) * Math.exp(-t * 60) * 0.7;
    out[i] = (body + snap) * 0.8;
  }
  return out;
}

/** Shaker/hi-hat-like: bandpassed-ish noise burst, no pitch. */
function shaker(seconds = 0.09): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  let hp = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const n = random() * 2 - 1;
    hp = 0.6 * hp + n - (i ? out[i - 1] : 0) * 0; // crude brightening
    out[i] = (n - hp * 0.3) * Math.exp(-t * 45) * 0.5;
  }
  return out;
}

/** Plucked string via Karplus–Strong: kora, oud, guitar, lute family. */
function pluck(freq: number, seconds = 1.4): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  const period = Math.max(2, Math.round(SR / freq));
  const buf = new Float32Array(period);
  for (let i = 0; i < period; i++) buf[i] = random() * 2 - 1;
  for (let i = 0; i < out.length; i++) {
    const j = i % period;
    const next = buf[(j + 1) % period];
    buf[j] = (buf[j] + next) * 0.499; // slight loss = decay
    out[i] = buf[j] * 0.9;
  }
  return out;
}

/** Hammered key/lamellophone: bright harmonic hit with exponential decay. */
function hammered(freq: number, seconds = 1.2): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    let s = 0;
    for (let h = 1; h <= 8; h++) s += Math.sin(2 * Math.PI * freq * h * t) / h;
    out[i] = s * Math.exp(-t * 3.5) * 0.35;
  }
  return out;
}

/** Sustained low-pitched line (bass role — any instrument holding the floor). */
function lowLine(freqs: number[], noteSeconds: number): Float32Array {
  const out = new Float32Array(Math.floor(freqs.length * noteSeconds * SR));
  for (let n = 0; n < freqs.length; n++) {
    const start = Math.floor(n * noteSeconds * SR);
    const len = Math.floor(noteSeconds * SR);
    for (let i = 0; i < len && start + i < out.length; i++) {
      const t = i / SR;
      const env = Math.min(1, t / 0.03) * Math.min(1, (noteSeconds - t) / 0.08);
      out[start + i] =
        (Math.sin(2 * Math.PI * freqs[n] * t) + 0.4 * Math.sin(2 * Math.PI * freqs[n] * 2 * t)) *
        env *
        0.5;
    }
  }
  return out;
}

/** Drone: static harmonic bed (tanpura/shruti/organ pedal role). */
function drone(freq: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    out[i] =
      (Math.sin(2 * Math.PI * freq * t) +
        0.5 * Math.sin(2 * Math.PI * freq * 2 * t) +
        0.3 * Math.sin(2 * Math.PI * freq * 3 * t)) *
      0.12;
  }
  return out;
}

function everyBeat(dest: Float32Array, make: () => Float32Array, interval: number, gain = 1) {
  for (let t = 0; t < SECONDS; t += interval) mixInto(dest, make(), t, gain);
}

function classify(track: Float32Array) {
  return AutoSplit.chooseSplit(AutoSplit.extractFeatures(track, SR));
}

// --- archetypes ---------------------------------------------------------------

test('solo voice over a drone chooses 2 parts', () => {
  const track = silence();
  mixInto(track, drone(110, SECONDS), 0);
  mixInto(track, voice(220, 5), 0.5);
  mixInto(track, voice(247, 5), 6);
  assert.equal(classify(track).choice, AutoSplit.TWO);
});

test('unaccompanied choir chooses 2 parts', () => {
  const track = silence();
  mixInto(track, voice(196, SECONDS), 0, 0.8);
  mixInto(track, voice(247, SECONDS), 0, 0.7);
  mixInto(track, voice(294, SECONDS), 0, 0.6);
  assert.equal(classify(track).choice, AutoSplit.TWO);
});

test('voice with frame drum and low line chooses 4 parts', () => {
  const track = silence();
  mixInto(track, voice(260, SECONDS), 0, 0.6);
  everyBeat(track, () => membrane(80), 0.5, 0.9);
  everyBeat(track, () => shaker(), 0.25, 0.4);
  mixInto(track, lowLine([65, 73, 65, 58, 65, 73, 65, 58], 1.5), 0, 0.8);
  assert.equal(classify(track).choice, AutoSplit.FOUR);
});

test('percussion ensemble with sustained low drums chooses 4 parts', () => {
  const track = silence();
  everyBeat(track, () => membrane(60, 0.6), 0.75, 1);
  everyBeat(track, () => membrane(140, 0.25), 0.375, 0.6);
  everyBeat(track, () => shaker(), 0.1875, 0.35);
  mixInto(track, lowLine([49, 49, 55, 49], 3), 0, 0.7);
  assert.equal(classify(track).choice, AutoSplit.FOUR);
});

test('a moving low line can justify 4 parts without bright percussion', () => {
  const track = silence();
  mixInto(track, voice(260, SECONDS), 0, 0.35);
  mixInto(track, lowLine([55, 73, 65, 82, 55, 73, 65, 82], 1.5), 0, 1);
  const verdict = classify(track);
  assert.equal(verdict.choice, AutoSplit.FOUR);
  assert.match(verdict.reason, /low-end/);
});

test('diffuse live rhythm cues keep sustained reeds out of the two-part route', () => {
  const verdict = AutoSplit.chooseSplit({
    onsetsPerSecond: 0.3,
    pitchedAttacksPerSecond: 0.05,
    sustainedLow: 0.15,
    percussiveHigh: 0.18,
    silent: false,
  });
  assert.equal(verdict.choice, AutoSplit.FOUR);
  assert.match(verdict.reason, /percussive and low-end/);
});

test('generic electronic pitched attacks do not promise guitar and piano channels', () => {
  const verdict = AutoSplit.chooseSplit({
    onsetsPerSecond: 3.61,
    pitchedAttacksPerSecond: 0.96,
    sustainedLow: 0.27,
    percussiveHigh: 0.16,
    silent: false,
  });
  assert.equal(verdict.choice, AutoSplit.FOUR);
  assert.match(verdict.reason, /percussive and low-end/);
});

test('high-rate pitched attacks still earn the six-track contract', () => {
  const verdict = AutoSplit.chooseSplit({
    onsetsPerSecond: 2.9,
    pitchedAttacksPerSecond: 1.49,
    sustainedLow: 0.5,
    percussiveHigh: 0.03,
    silent: false,
  });
  assert.equal(verdict.choice, AutoSplit.SIX);
});

test('plucked-lute ensemble with percussion chooses 6 parts', () => {
  const track = silence();
  const scale = [220, 247, 262, 294, 330, 349, 392];
  for (let t = 0, n = 0; t < SECONDS; t += 0.33, n++) {
    mixInto(track, pluck(scale[n % scale.length]), t, 0.9);
  }
  everyBeat(track, () => membrane(90), 0.66, 0.5);
  mixInto(track, lowLine([73, 82, 73, 65], 3), 0, 0.6);
  assert.equal(classify(track).choice, AutoSplit.SIX);
});

test('hammered keys with voice and rhythm section chooses 6 parts', () => {
  const track = silence();
  const chord = [262, 330, 392];
  for (let t = 0; t < SECONDS; t += 0.5) {
    for (const f of chord) mixInto(track, hammered(f), t, 0.7);
  }
  mixInto(track, voice(330, SECONDS), 0, 0.4);
  everyBeat(track, () => membrane(70), 0.5, 0.5);
  mixInto(track, lowLine([65, 73, 82, 73], 1.5), 0, 0.6);
  assert.equal(classify(track).choice, AutoSplit.SIX);
});

test('lamellophone and shaker duet chooses 6 parts', () => {
  const track = silence();
  const pattern = [392, 440, 523, 440, 392, 330];
  for (let t = 0, n = 0; t < SECONDS; t += 0.25, n++) {
    mixInto(track, hammered(pattern[n % pattern.length], 0.8), t, 0.8);
  }
  everyBeat(track, () => shaker(), 0.25, 0.5);
  mixInto(track, lowLine([98, 110, 98, 87], 3), 0, 0.5);
  assert.equal(classify(track).choice, AutoSplit.SIX);
});

// --- held-out archetypes ---------------------------------------------------
//
// Not used to tune the thresholds. Each one probes a different edge of the
// role vocabulary: harmonic-but-never-struck, harmonic-and-sustained-over-
// percussion, and broadband-but-unpitched.

/** Bowed sustain: harmonic like a pluck, but the energy arrives gradually. */
function bowed(freq: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    let s = 0;
    for (let h = 1; h <= 10; h++) s += Math.sin(2 * Math.PI * freq * h * t) / h;
    const env = Math.min(1, t / 0.35) * Math.min(1, (seconds - t) / 0.35);
    out[i] = s * env * 0.18;
  }
  return out;
}

/** Reed/pipe: odd-harmonic sustain with breath noise. */
function reed(freq: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    let s = 0;
    for (let h = 1; h <= 9; h += 2) s += Math.sin(2 * Math.PI * freq * h * t) / h;
    const env = Math.min(1, t / 0.2) * Math.min(1, (seconds - t) / 0.2);
    out[i] = (s + (random() * 2 - 1) * 0.06) * env * 0.22;
  }
  return out;
}

/**
 * Speech: voiced syllables (a real harmonic stack, so this is NOT just noise)
 * whose pitch glides within each syllable, plus consonant noise between them.
 * The glide is the point — it is what separates a spoken syllable from a
 * struck or plucked note, which holds one pitch while it rings.
 */
function speech(seconds: number): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  const syllableRate = 3.5;
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const pos = (t * syllableRate) % 1;
    const env = pos < 0.55 ? Math.sin((Math.PI * pos) / 0.55) : 0;
    // f0 glides ~110 -> 150 Hz across each syllable.
    const f0 = 110 + 40 * pos;
    phase += (2 * Math.PI * f0) / SR;
    let s = 0;
    for (let h = 1; h <= 12; h++) s += Math.sin(phase * h) / h;
    const consonant = pos > 0.55 && pos < 0.68 ? (random() * 2 - 1) * 0.5 : 0;
    out[i] = (s * env * 0.22 + consonant * 0.3) * 0.9;
  }
  return out;
}

test('held out: bowed string ensemble chooses 2 parts', () => {
  const track = silence();
  mixInto(track, bowed(147, SECONDS), 0, 0.9);
  mixInto(track, bowed(220, SECONDS), 0, 0.8);
  mixInto(track, bowed(294, SECONDS), 0, 0.7);
  assert.equal(classify(track).choice, AutoSplit.TWO);
});

test('held out: reed ensemble over hand percussion chooses 4 parts', () => {
  const track = silence();
  mixInto(track, reed(330, SECONDS), 0, 0.9);
  mixInto(track, reed(392, SECONDS), 0, 0.7);
  everyBeat(track, () => membrane(85), 0.4, 0.9);
  everyBeat(track, () => shaker(), 0.2, 0.5);
  mixInto(track, lowLine([82, 82, 98, 87], 3), 0, 0.7);
  assert.equal(classify(track).choice, AutoSplit.FOUR);
});

test('held out: spoken word over a quiet field recording chooses 2 parts', () => {
  const track = silence();
  mixInto(track, speech(SECONDS), 0, 0.9);
  mixInto(track, drone(70, SECONDS), 0, 0.3);
  assert.equal(classify(track).choice, AutoSplit.TWO);
});

test('silence falls back to 4 parts with an honest reason', () => {
  const verdict = classify(silence());
  assert.equal(verdict.choice, AutoSplit.FOUR);
  assert.match(verdict.reason, /could not hear/);
});

// --- model mapping --------------------------------------------------------------

const CATALOGUE = [
  { id: 'vocals_instrumental', stems: ['vocals', 'instrumental'] },
  { id: 'htdemucs_ft', stems: ['vocals', 'drums', 'bass', 'other'] },
  { id: 'htdemucs_6s', stems: ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'] },
];

test('pickModel maps choices onto the advertised catalogue', () => {
  assert.equal(AutoSplit.pickModel(AutoSplit.TWO, CATALOGUE), 'vocals_instrumental');
  assert.equal(AutoSplit.pickModel(AutoSplit.FOUR, CATALOGUE), 'htdemucs_ft');
  assert.equal(AutoSplit.pickModel(AutoSplit.SIX, CATALOGUE), 'htdemucs_6s');
});

test('pickModel falls back to the nearest track count', () => {
  const twoAndFour = CATALOGUE.slice(0, 2);
  assert.equal(AutoSplit.pickModel(AutoSplit.SIX, twoAndFour), 'htdemucs_ft');
});

test('downmix samples the beginning, middle, and end within its analysis budget', () => {
  const sampleRate = 100;
  const length = 90 * sampleRate;
  const channels = [new Float32Array(length), new Float32Array(length)];
  for (let i = 0; i < length; i++) {
    channels[0][i] = i;
    channels[1][i] = i + 2;
  }

  const samples = AutoSplit.downmix({
    sampleRate,
    length,
    numberOfChannels: channels.length,
    getChannelData: (channel) => channels[channel],
  });

  assert.equal(samples.length, AutoSplit.MAX_ANALYSIS_SECONDS * sampleRate);
  assert.equal(samples[0], 1);
  assert.equal(samples[1499], 1500);
  assert.equal(samples[1500], 3751);
  assert.equal(samples[3000], 7501);
});

test('downmix analyzes a source shorter than the budget in full', () => {
  const sampleRate = 100;
  const length = 30 * sampleRate;
  const channel = Float32Array.from({ length }, (_, index) => index);

  const samples = AutoSplit.downmix({
    sampleRate,
    length,
    numberOfChannels: 1,
    getChannelData: () => channel,
  });

  assert.equal(samples.length, length);
  assert.equal(samples[0], 0);
  assert.equal(samples[length - 1], length - 1);
});

test('browser analysis resamples to the fixed server parity rate', () => {
  const source = Float32Array.from([0, 1, 0, -1]);
  const samples = AutoSplit.resample(source, 4, 8);
  assert.equal(AutoSplit.ANALYSIS_SAMPLE_RATE, 22_050);
  assert.equal(samples.length, 8);
  assert.deepEqual(Array.from(samples.slice(0, 5)), [0, 0.5, 1, 0.5, 0]);
});

test('browser downsampling rejects frequencies above the analysis Nyquist limit', () => {
  const sourceRate = 48_000;
  const seconds = 0.25;
  const tone = (frequency: number) =>
    Float32Array.from(
      { length: sourceRate * seconds },
      (_, index) => Math.sin((2 * Math.PI * frequency * index) / sourceRate)
    );
  const rms = (samples: Float32Array) =>
    Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);

  const inBand = AutoSplit.resample(tone(1_000), sourceRate);
  const aboveNyquist = AutoSplit.resample(tone(15_000), sourceRate);
  assert.ok(rms(inBand) > 0.65, 'an audible in-band tone should survive');
  assert.ok(rms(aboveNyquist) < 0.02, 'out-of-band energy must not alias into classifier bands');
});

test('browser decode policy caps advisory source proxies before classification', () => {
  assert.equal(
    AutoSplit.browserDecodeAllowed(
      AutoSplit.MAX_BROWSER_DECODE_BYTES,
      AutoSplit.MAX_BROWSER_DECODE_SECONDS
    ),
    true
  );
  assert.equal(
    AutoSplit.browserDecodeAllowed(
      AutoSplit.MAX_BROWSER_DECODE_BYTES + 1,
      AutoSplit.MAX_BROWSER_DECODE_SECONDS
    ),
    false
  );
  assert.equal(
    AutoSplit.browserDecodeAllowed(
      AutoSplit.MAX_BROWSER_DECODE_BYTES,
      AutoSplit.MAX_BROWSER_DECODE_SECONDS + 0.001
    ),
    false
  );
  assert.equal(AutoSplit.browserDecodeAllowed(1, Number.NaN), false);
});
