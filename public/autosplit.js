// AutoSplit: pick the best split (2 / 4 / 6 parts) for a track from the audio
// itself, before any money is spent on separation.
//
// The classifier listens for timbral ROLES, not genres or a standard band:
//   - percussive onsets           -> is a percussion stem worth having?
//   - sustained low-pitched energy -> is a low-end stem worth having?
//   - plucked/hammered mid-range harmonic content -> are the plucked-strings
//     and keys stems (guitar-/piano-trained nets) likely to catch anything?
// A voice-and-drone piece, a percussion ensemble, a kora duet, and a piano
// trio all get sensible answers without any of them being treated as the
// "default" kind of music.
//
// Runs in the browser (from an AudioBuffer) and in Node tests (from raw
// sample arrays composed programmatically) — same code path, no dependencies.

(function attach(root) {
  const FRAME = 2048;
  const HOP = 1024;
  // Three short windows spread across the song are both faster and more
  // representative than listening only to a long intro. The browser decodes
  // the file once, then transfers at most this many seconds to a Web Worker.
  const MAX_ANALYSIS_SECONDS = 45;
  const ANALYSIS_SEGMENTS = 3;

  // --- tiny DSP ------------------------------------------------------------

  function hann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    return w;
  }

  // Real-input radix-2 FFT magnitude via the classic iterative complex FFT.
  function fftMagnitudes(frame) {
    const n = frame.length;
    const re = Float64Array.from(frame);
    const im = new Float64Array(n);
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1;
        let ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k];
          const ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr;
          im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr;
          im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
    const mags = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) mags[i] = Math.hypot(re[i], im[i]);
    return mags;
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // --- feature extraction ----------------------------------------------------

  /**
   * samples: Float32Array (mono), sampleRate: number.
   * Returns role-level features, all roughly 0..1.
   */
  function extractFeatures(samples, sampleRate) {
    const limit = Math.min(samples.length, MAX_ANALYSIS_SECONDS * sampleRate);
    const window = hann(FRAME);
    const binHz = sampleRate / FRAME;
    const band = (lo, hi) => [Math.max(1, Math.round(lo / binHz)), Math.round(hi / binHz)];
    const [lowLo, lowHi] = band(40, 200); // low-end role
    const [midLo, midHi] = band(200, 2200); // pitched accompaniment
    const [highLo, highHi] = band(4000, 11000); // percussive sizzle

    let prev = null;
    const flux = [0];
    const lowEnergy = [];
    const harmonicStrength = [];
    const highRatio = [];
    const frameEnergy = [];

    for (let start = 0; start + FRAME <= limit; start += HOP) {
      const frame = new Float64Array(FRAME);
      let energy = 0;
      for (let i = 0; i < FRAME; i++) {
        frame[i] = samples[start + i] * window[i];
        energy += frame[i] * frame[i];
      }
      frameEnergy.push(energy);
      const mags = fftMagnitudes(frame);

      let total = 1e-12;
      let low = 0;
      let high = 0;
      for (let i = 1; i < mags.length; i++) total += mags[i];
      for (let i = lowLo; i <= lowHi && i < mags.length; i++) low += mags[i];
      for (let i = highLo; i <= highHi && i < mags.length; i++) high += mags[i];
      lowEnergy.push(low / total);
      highRatio.push(high / total);

      // Harmonic Product Spectrum over the mid band. For each candidate
      // fundamental, ∛(S[f]·S[2f]·S[3f]) survives only if all three partials
      // are really there. A plucked string, a struck tine, a bowed or blown
      // note, a sung vowel — all combs, all score high. A tuned drum head is
      // one swept partial, so its 2f and 3f terms are empty and the product
      // collapses; noise averages out against the band mean. This is the line
      // between "a pitched instrument sounded" and "something was hit".
      let midSum = 1e-12;
      for (let i = midLo; i <= midHi && i < mags.length; i++) midSum += mags[i];
      let hps = 0;
      for (let i = midLo; i * 3 <= midHi && i * 3 < mags.length; i++) {
        const p = Math.cbrt(mags[i] * mags[i * 2] * mags[i * 3]);
        if (p > hps) hps = p;
      }
      harmonicStrength.push(hps / (midSum / (midHi - midLo + 1)));

      if (prev) {
        let f = 0;
        for (let i = 1; i < mags.length; i++) {
          const d = mags[i] - prev[i];
          if (d > 0) f += d;
        }
        flux.push(f / total);
      }
      prev = mags;
    }

    const frames = frameEnergy.length || 1;
    const framesPerSecond = sampleRate / HOP;
    const trackSeconds = frames / framesPerSecond;

    // Onsets first — every "attack" question is asked at these instants only,
    // so sustained material (a drone, a held vowel, a bowed pedal) can never
    // masquerade as something being struck or plucked.
    const fluxMedian = median(flux);
    const onsetFrames = [];
    let lastOnset = -Infinity;
    for (let i = 1; i < flux.length - 1; i++) {
      const isPeak = flux[i] > flux[i - 1] && flux[i] >= flux[i + 1];
      if (isPeak && flux[i] > fluxMedian * 2.5 + 0.01 && i - lastOnset > framesPerSecond * 0.09) {
        onsetFrames.push(i);
        lastOnset = i;
      }
    }
    const onsetsPerSecond = onsetFrames.length / trackSeconds;

    // A pitched attack is an onset whose sounding body is a harmonic comb.
    // Look at the onset frame and the one after it: the very first frame of an
    // attack is transient noise, the tone arrives just behind it.
    //
    // 4.5 sits in the measured gap between struck membranes and shakers
    // (2.0–2.7 per attack) and plucked/hammered pitched material (5.8–7.8).
    // See tests/autosplit.test.mts for the corpus those numbers come from.
    const HARMONIC_ATTACK = 4.5;
    let pitchedAttacks = 0;
    for (const i of onsetFrames) {
      const here = harmonicStrength[i] || 0;
      const next = harmonicStrength[i + 1] || 0;
      if (Math.max(here, next) > HARMONIC_ATTACK) pitchedAttacks++;
    }
    const pitchedAttacksPerSecond = pitchedAttacks / trackSeconds;

    // Sustained low end: median (not mean) low-band share, so isolated drum
    // thumps don't read as a low-pitched instrument holding the floor.
    const sustainedLow = median(lowEnergy);

    // Percussiveness: broadband high-frequency content across the track.
    const percussiveHigh = median(highRatio);

    return {
      onsetsPerSecond,
      pitchedAttacksPerSecond,
      sustainedLow,
      percussiveHigh,
      silent: median(frameEnergy) < 1e-7,
    };
  }

  // --- decision --------------------------------------------------------------

  const TWO = 'two';
  const FOUR = 'four';
  const SIX = 'six';

  /**
   * Returns { choice: 'two'|'four'|'six', reason: string }.
   * Thresholds are tuned against the programmatically composed archetypes in
   * tests/autosplit.test.mts — change them there first.
   */
  function chooseSplit(features) {
    const {
      onsetsPerSecond,
      pitchedAttacksPerSecond,
      sustainedLow,
      percussiveHigh,
      silent,
    } = features;

    if (silent) {
      return { choice: FOUR, reason: 'could not hear enough to judge — using the 4-part split' };
    }

    const hasPercussion = onsetsPerSecond > 1.1 && percussiveHigh > 0.02;
    // A moving bass line can justify its own channel even without bright
    // percussion. Requiring some attacks keeps a bowed/drone low register from
    // being mistaken for a rhythm section merely because it is low-pitched.
    const hasMovingLowEnd = sustainedLow > 0.08 && onsetsPerSecond > 0.45;
    const hasPitchedAttacks = pitchedAttacksPerSecond > 0.8;

    if (hasPitchedAttacks) {
      return {
        choice: SIX,
        reason: 'plucked or hammered pitched layers — 6 parts can pull them out',
      };
    }
    if (!hasPercussion && !hasMovingLowEnd) {
      return {
        choice: TWO,
        reason: 'mostly voice-like or sustained material — 2 parts keeps it clean',
      };
    }
    return {
      choice: FOUR,
        reason: hasPercussion
          ? 'percussion and low end present — 4 parts fits'
          : 'a moving low-end layer is present — 4 parts can pull it out',
    };
  }

  /** Map a choice to a concrete model id from /api/separation-options. */
  function pickModel(choice, models) {
    const byCount = { [TWO]: 2, [FOUR]: 4, [SIX]: 6 };
    const want = byCount[choice];
    const exact = models.find((m) => m.stems.length === want);
    if (exact) return exact.id;
    // Nearest available track count wins (e.g. a backend with no 6-part split).
    const sorted = [...models].sort(
      (a, b) => Math.abs(a.stems.length - want) - Math.abs(b.stems.length - want)
    );
    return sorted[0]?.id || '';
  }

  function downmix(audioBuffer) {
    const sampleRate = audioBuffer.sampleRate;
    const maxFrames = Math.min(audioBuffer.length, MAX_ANALYSIS_SECONDS * sampleRate);
    const segmentFrames = Math.max(1, Math.floor(maxFrames / ANALYSIS_SEGMENTS));
    const availableStart = Math.max(0, audioBuffer.length - segmentFrames);
    const starts = audioBuffer.length <= maxFrames
      ? [0]
      : [0, Math.floor(availableStart / 2), availableStart];
    const out = new Float32Array(Math.min(audioBuffer.length, segmentFrames * starts.length));

    let offset = 0;
    for (const start of starts) {
      const take = Math.min(segmentFrames, audioBuffer.length - start, out.length - offset);
      for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
        const data = audioBuffer.getChannelData(ch);
        for (let i = 0; i < take; i++) {
          out[offset + i] += data[start + i] / audioBuffer.numberOfChannels;
        }
      }
      offset += take;
    }
    return offset === out.length ? out : out.slice(0, offset);
  }

  root.AutoSplit = {
    extractFeatures,
    chooseSplit,
    pickModel,
    downmix,
    TWO,
    FOUR,
    SIX,
    MAX_ANALYSIS_SECONDS,
  };
})(globalThis);
