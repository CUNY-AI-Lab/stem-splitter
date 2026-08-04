// Objective, falsifiable checks on a finished split.
//
// The contract gate in src/separation/options.ts only checks that the track
// NAMES are right. It cannot tell you whether the bytes behind those names are
// the right audio — a provider that returned the same file twice under two
// names, or mapped `no_vocals` onto the wrong channel, passes it cleanly.
// These measures are the adversarial half: they test the audio itself.
//
//   node scripts/eval-stems.mjs --source mix.mp3 \
//     --stem vocals=vocals.mp3 --stem instrumental=instrumental.mp3 \
//     --expect-loud vocals,instrumental [--json out.json]
//
// Everything is computed from raw PCM decoded by ffmpeg, so the measures are
// codec-agnostic and tolerant of MP3 encoder delay (each comparison searches
// for its own best alignment before scoring).

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SAMPLE_RATE = 16000;
// LAME adds ~1100 samples of encoder delay; ±0.25 s covers that plus slack.
const MAX_LAG = Math.round(SAMPLE_RATE * 0.25);

// --- thresholds ------------------------------------------------------------
// Chosen to separate "obviously broken" from "plausibly fine". They are
// deliberately loose: this tool is here to catch gross failures without
// crying wolf on a legitimately quiet stem.
const T = {
  /** Below this a stem carries no usable signal but may still be valid. */
  quietDb: -50,
  /** Two stems correlating above this are almost certainly the same audio. */
  duplicateCorr: 0.98,
  /** Stem/source duration mismatch tolerated, in seconds. */
  durationSlackS: 0.35,
};

// Reconstruction thresholds depend on how the split was produced, and getting
// this wrong makes the whole measure useless: a first pass at this tool used
// one lenient threshold for everything and PASSED a deliberately mis-renamed
// 2-track split at 91.6% correlation — the exact failure it exists to catch.
//
// --complementary: the tracks are an arithmetic partition of the mix. Demucs
//   karaoke mode (`stem: vocals`, --other-method=add) sums the non-vocal
//   sources, so vocals + instrumental reconstructs the mix almost exactly.
//   Anything less means a channel was renamed onto the wrong audio.
// default: independently estimated sources. Demucs is near-conservative but
//   not exact, so real separation loss is expected.
const RECONSTRUCTION = {
  complementary: { minCorr: 0.99, maxResidualDb: -20 },
  // Provisional: calibrate against the first real Demucs run and record the
  // observed value in docs/acceptance/ before treating a WARN here as a bug.
  independent: { minCorr: 0.95, maxResidualDb: -12 },
};

function parseArgs(argv) {
  const args = { stems: new Map(), expectLoud: [], expectQuiet: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--source') (args.source = value), i++;
    else if (flag === '--stem') {
      const eq = value.indexOf('=');
      args.stems.set(value.slice(0, eq), value.slice(eq + 1));
      i++;
    } else if (flag === '--expect-loud') (args.expectLoud = value.split(',').filter(Boolean)), i++;
    else if (flag === '--expect-quiet') (args.expectQuiet = value.split(',').filter(Boolean)), i++;
    else if (flag === '--label') (args.label = value), i++;
    else if (flag === '--json') (args.json = value), i++;
    else if (flag === '--complementary') args.complementary = true;
  }
  return args;
}

/** Decode anything ffmpeg understands into mono float samples at SAMPLE_RATE. */
async function decode(path, filters = []) {
  const { stdout } = await run(
    'ffmpeg',
    [
      '-v', 'error', '-i', path,
      // Pin the first audio stream: corpus downloads often carry embedded cover
      // art, and letting ffmpeg choose leaves the measurement to stream order.
      '-map', '0:a:0',
      ...(filters.length ? ['-af', filters.join(',')] : []),
      '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-',
    ],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 * 512 }
  );
  const pcm = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
  return samples;
}

async function probe(path) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    // Without this, a file with cover art can report the image stream's codec
    // as the audio format.
    '-select_streams', 'a:0',
    '-show_entries', 'format=duration,bit_rate:stream=codec_name,sample_rate,channels',
    '-of', 'json', path,
  ]);
  const info = JSON.parse(stdout);
  const stream = info.streams?.[0] ?? {};
  return {
    durationS: Number(info.format?.duration ?? 0),
    bitrateKbps: Math.round(Number(info.format?.bit_rate ?? 0) / 1000),
    codec: stream.codec_name ?? 'unknown',
    sampleRate: Number(stream.sample_rate ?? 0),
    channels: Number(stream.channels ?? 0),
  };
}

const dB = (amplitude) => (amplitude <= 0 ? -Infinity : 20 * Math.log10(amplitude));

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function peak(samples) {
  let max = 0;
  for (let i = 0; i < samples.length; i++) max = Math.max(max, Math.abs(samples[i]));
  return max;
}

function isDigitalSilence(samples) {
  for (let i = 0; i < samples.length; i++) if (samples[i] !== 0) return false;
  return true;
}

/**
 * Normalized cross-correlation at the best alignment within ±MAX_LAG.
 * Alignment search is what makes this tolerant of MP3 encoder delay, so a
 * correct-but-delayed stem is not mistaken for a wrong one.
 */
function bestCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return { corr: 0, lag: 0 };
  const energyA = Math.sqrt(a.slice(0, n).reduce((acc, v) => acc + v * v, 0));
  const energyB = Math.sqrt(b.slice(0, n).reduce((acc, v) => acc + v * v, 0));
  if (!energyA || !energyB) return { corr: 0, lag: 0 };

  let best = { corr: -1, lag: 0 };
  // Coarse pass then refine: full-resolution search over ±4000 samples on a
  // multi-minute track is far too slow, and the delay we care about is small.
  for (const step of [16, 1]) {
    const centre = best.lag === 0 && step === 16 ? 0 : best.lag;
    const span = step === 16 ? MAX_LAG : 24;
    for (let lag = centre - span; lag <= centre + span; lag += step) {
      let dot = 0;
      const start = Math.max(0, -lag);
      const end = Math.min(n, n - lag);
      for (let i = start; i < end; i++) dot += a[i] * b[i + lag];
      const corr = dot / (energyA * energyB);
      if (corr > best.corr) best = { corr, lag };
    }
  }
  return best;
}

/**
 * Residual energy of (source - Σ stems), in dB relative to the source.
 *
 * Sum first, then align once. Every track in a result comes out of one decode
 * of one recording, so they share a single delay. Aligning each track to the
 * source independently invents relative shifts between them that no provider
 * can produce: a bass-dominated track has a broad correlation peak whose argmax
 * wanders by a few samples, and a 13-sample shift between two halves of an
 * exact partition takes the residual from -72 dB to -4 dB. Summing first makes
 * the alignment well conditioned (the sum is full-band) and keeps the tracks
 * rigid relative to each other, which is the only physically possible case.
 */
function reconstructionResidualDb(source, stems) {
  const n = Math.min(source.length, ...stems.map((s) => s.samples.length));
  const sum = new Float32Array(n);
  for (const stem of stems) {
    for (let i = 0; i < n; i++) sum[i] += stem.samples[i];
  }
  const sourceRms = rms(source.subarray(0, n));
  if (!sourceRms) return { residualDb: 0, sumCorr: 0 };

  const { lag, corr } = bestCorrelation(source.subarray(0, n), sum);
  const residual = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i + lag;
    residual[i] = source[i] - (j >= 0 && j < n ? sum[j] : 0);
  }
  return { residualDb: dB(rms(residual) / sourceRms), sumCorr: corr };
}

// --- main ------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (!args.source || !args.stems.size) {
  console.error('Usage: node scripts/eval-stems.mjs --source <file> --stem <name>=<file> ...');
  console.error('  [--expect-loud a,b] [--expect-quiet c,d] [--label name] [--json out.json]');
  process.exit(2);
}

const findings = [];
const fail = (code, message) => findings.push({ level: 'FAIL', code, message });
const warn = (code, message) => findings.push({ level: 'WARN', code, message });

const sourceProbe = await probe(args.source);
const sourceSamples = await decode(args.source);
const sourceRmsDb = dB(rms(sourceSamples));

const stems = [];
for (const [name, path] of args.stems) {
  const samples = await decode(path);
  // Fraction of energy below 200 Hz. Bass and kick live there; an isolated
  // lead vocal essentially never does. This is the only signal that can tell
  // vocals from instrumental when reconstruction cannot (see the swap check).
  const low = await decode(path, ['lowpass=f=200']);
  const full = rms(samples);
  stems.push({
    name,
    path,
    probe: await probe(path),
    samples,
    lowRatio: full > 0 ? rms(low) / full : 0,
  });
}

// 1. Format and duration consistency.
for (const stem of stems) {
  if (stem.probe.codec !== 'mp3') {
    fail('format', `${stem.name} is ${stem.probe.codec}, expected mp3`);
  }
  if (stem.probe.bitrateKbps && Math.abs(stem.probe.bitrateKbps - 192) > 24) {
    warn('bitrate', `${stem.name} is ${stem.probe.bitrateKbps} kbps, expected ~192`);
  }
  const drift = Math.abs(stem.probe.durationS - sourceProbe.durationS);
  if (drift > T.durationSlackS) {
    fail(
      'duration',
      `${stem.name} is ${stem.probe.durationS.toFixed(2)}s but the source is ` +
        `${sourceProbe.durationS.toFixed(2)}s (drift ${drift.toFixed(2)}s)`
    );
  }
}

// 2. Level per stem — and the distinction the 2026-07-30 spec insists on
//    between "quiet but valid" and "blank".
const levels = stems.map((stem) => {
  const stemRmsDb = dB(rms(stem.samples));
  const stemPeakDb = dB(peak(stem.samples));
  const silent = isDigitalSilence(stem.samples);
  if (silent) fail('blank', `${stem.name} is digital silence (all zero samples)`);
  return { name: stem.name, rmsDb: stemRmsDb, peakDb: stemPeakDb, digitalSilence: silent };
});

for (const name of args.expectLoud) {
  const level = levels.find((l) => l.name === name);
  if (!level) fail('missing', `expected a loud "${name}" track, which is not present`);
  else if (level.rmsDb < T.quietDb) {
    fail('unexpected-quiet', `${name} should carry signal but is ${level.rmsDb.toFixed(1)} dBFS`);
  }
}
for (const name of args.expectQuiet) {
  const level = levels.find((l) => l.name === name);
  if (!level) continue;
  if (level.rmsDb > T.quietDb) {
    warn(
      'unexpected-signal',
      `${name} was expected near-silent for this source but is ${level.rmsDb.toFixed(1)} dBFS`
    );
  } else if (!level.digitalSilence) {
    findings.push({
      level: 'NOTE',
      code: 'quiet-but-valid',
      message: `${name} is quiet (${level.rmsDb.toFixed(1)} dBFS) but not blank — correct for this source`,
    });
  }
}

// 3. Duplicate detection. Two names, one file, is a provider failure the
//    name-based contract check cannot see.
const pairs = [];
for (let i = 0; i < stems.length; i++) {
  for (let j = i + 1; j < stems.length; j++) {
    const { corr } = bestCorrelation(stems[i].samples, stems[j].samples);
    pairs.push({ a: stems[i].name, b: stems[j].name, corr });
    if (corr > T.duplicateCorr) {
      fail(
        'duplicate',
        `${stems[i].name} and ${stems[j].name} are ${(corr * 100).toFixed(1)}% correlated — ` +
          `the provider likely returned the same audio twice`
      );
    }
  }
}

// 4. Reconstruction. Demucs is near-conservative, and for the 2-track split
//    the instrumental is literally the sum of the other sources, so the stems
//    must add back up to the mix. This is what falsifies a wrong output-name
//    mapping: rename the wrong channel and the sum stops matching.
const { residualDb, sumCorr } = reconstructionResidualDb(
  sourceSamples,
  stems.filter((s) => !isDigitalSilence(s.samples))
);
const mode = args.complementary ? 'complementary' : 'independent';
const limits = RECONSTRUCTION[mode];
if (sumCorr < limits.minCorr) {
  fail(
    'reconstruction',
    `summed tracks correlate only ${(sumCorr * 100).toFixed(2)}% with the source ` +
      `(${mode} split expects >${(limits.minCorr * 100).toFixed(0)}%) — a track is missing or renamed onto the wrong audio`
  );
}
if (residualDb > limits.maxResidualDb) {
  // For a complementary split this is arithmetic, not estimation, so a high
  // residual is a defect rather than a quality observation.
  const report = args.complementary ? fail : warn;
  report(
    'residual',
    `residual after summing tracks is ${residualDb.toFixed(1)} dB relative to source ` +
      `(${mode} split expects <${limits.maxResidualDb} dB)`
  );
}

// 5. Swap detection. Reconstruction is structurally blind to two stems being
//    exchanged — the sum is identical either way — so a rename that lands the
//    vocal audio on "instrumental" and vice versa would otherwise pass every
//    check above. Low-frequency content is the discriminator: the instrumental
//    carries the bass and kick, the isolated vocal does not.
const vocalsStem = stems.find((s) => s.name === 'vocals');
const instrumentalStem = stems.find((s) => s.name === 'instrumental');
if (vocalsStem && instrumentalStem && !isDigitalSilence(vocalsStem.samples)) {
  if (vocalsStem.lowRatio > instrumentalStem.lowRatio) {
    warn(
      'possible-swap',
      `"vocals" holds more sub-200Hz energy than "instrumental" ` +
        `(${vocalsStem.lowRatio.toFixed(3)} vs ${instrumentalStem.lowRatio.toFixed(3)}) — ` +
        `the two channels may be swapped. Confirm by ear before trusting the rename.`
    );
  }
}

const report = {
  label: args.label ?? args.source,
  source: { path: args.source, ...sourceProbe, rmsDb: Number(sourceRmsDb.toFixed(2)) },
  stems: stems.map((stem, i) => ({
    name: stem.name,
    ...stem.probe,
    rmsDb: Number(levels[i].rmsDb.toFixed(2)),
    peakDb: Number(levels[i].peakDb.toFixed(2)),
    digitalSilence: levels[i].digitalSilence,
    lowFreqRatio: Number(stem.lowRatio.toFixed(4)),
  })),
  pairwiseCorrelation: pairs.map((p) => ({ ...p, corr: Number(p.corr.toFixed(4)) })),
  reconstruction: {
    mode,
    summedCorrelation: Number(sumCorr.toFixed(4)),
    residualDb: Number(residualDb.toFixed(2)),
    limits,
  },
  findings,
  verdict: findings.some((f) => f.level === 'FAIL') ? 'FAIL' : 'PASS',
};

console.log(`\n── ${report.label} ─────────────────────────────`);
console.log(
  `source   ${sourceProbe.durationS.toFixed(1)}s  ${sourceRmsDb.toFixed(1)} dBFS  ` +
    `${sourceProbe.codec} ${sourceProbe.sampleRate}Hz`
);
for (const stem of report.stems) {
  console.log(
    `  ${stem.name.padEnd(13)} ${String(stem.rmsDb).padStart(7)} dBFS  ` +
      `peak ${String(stem.peakDb).padStart(6)}  ${stem.durationS.toFixed(1)}s  ${stem.bitrateKbps}kbps`
  );
}
console.log(
  `reconstruction  corr ${(sumCorr * 100).toFixed(2)}%  residual ${residualDb.toFixed(1)} dB  ` +
    `(${mode}: needs >${(limits.minCorr * 100).toFixed(0)}%, <${limits.maxResidualDb} dB)`
);
const worstPair = pairs.slice().sort((a, b) => b.corr - a.corr)[0];
if (worstPair) {
  console.log(
    `most similar pair  ${worstPair.a} / ${worstPair.b}  ${(worstPair.corr * 100).toFixed(1)}%`
  );
}
for (const finding of findings) {
  console.log(`  ${finding.level.padEnd(5)} [${finding.code}] ${finding.message}`);
}
console.log(`verdict: ${report.verdict}`);

if (args.json) {
  await writeFile(args.json, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${args.json}`);
}

process.exit(report.verdict === 'FAIL' ? 1 : 0);
