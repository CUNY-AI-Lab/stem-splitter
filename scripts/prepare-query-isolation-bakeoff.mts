import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildQueryIsolationEvaluationInput,
  loadQueryIsolationBakeoffManifest,
  QUERY_ISOLATION_BAKEOFF_MANIFEST_PATH,
  QUERY_ISOLATION_BAKEOFF_OUTPUT_DIRECTORY,
  QUERY_ISOLATION_BAKEOFF_VERSION,
  reconstructionResidualDb,
  scaleInvariantSdrDb,
} from './lib/query-isolation-bakeoff.mts';
import {
  INSTRUMENT_CONTROL_MANIFEST_PATH,
  instrumentControlPath,
  loadInstrumentControlManifest,
  type InstrumentControl,
} from './lib/instrument-control-corpus.mts';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_SCHEMA = 'stem-splitter.query-isolation-fixtures.v1';
const EVIDENCE_FILE = 'fixture-evidence.json';
const MAX_DECODE_BYTES = 24 * 32_000 * 4 + 4096;

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function regularPinnedControl(control: InstrumentControl): string {
  const manifest = loadInstrumentControlManifest(REPOSITORY_ROOT);
  const path = instrumentControlPath(REPOSITORY_ROOT, manifest, control);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${control.id}: hydrate the pinned instrument control before fixture preparation`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== control.media.bytes) {
    throw new Error(`${control.id}: hydrated control is not the pinned regular file`);
  }
  if (sha256File(path) !== control.media.sha256) {
    throw new Error(`${control.id}: hydrated control SHA-256 does not match`);
  }
  return path;
}

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-y', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function decodeF32(path: string, sampleRate: number): Float32Array {
  const bytes = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-i',
      path,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      String(sampleRate),
      '-f',
      'f32le',
      '-',
    ],
    { encoding: 'buffer', timeout: 30_000, maxBuffer: MAX_DECODE_BYTES }
  );
  if (bytes.byteLength % 4 !== 0 || bytes.byteLength > MAX_DECODE_BYTES) {
    throw new Error('generated fixture PCM is invalid or oversized');
  }
  const view = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  return new Float32Array(view);
}

function ffmpegVersion(): string {
  return execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split(/\r?\n/, 1)[0];
}

function generatedFile(path: string): { bytes: number; sha256: string } {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 44) {
    throw new Error(`${path}: generated fixture is not a regular WAV file`);
  }
  return { bytes: stat.size, sha256: sha256File(path) };
}

function rmsWindow(samples: Float32Array, sampleRate: number, span: readonly [number, number]): number {
  const start = Math.max(0, Math.floor(span[0] * sampleRate));
  const end = Math.min(samples.length, Math.floor(span[1] * sampleRate));
  if (end <= start) throw new Error('fixture span does not contain audio samples');
  let energy = 0;
  for (let index = start; index < end; index += 1) energy += samples[index] * samples[index];
  return Math.sqrt(energy / (end - start));
}

function verifySpanConstruction(
  samples: Float32Array,
  policy: ReturnType<typeof loadQueryIsolationBakeoffManifest>['fixturePolicy'],
  caseId: string
): { positiveRms: number; negativeRms: number[] } {
  const positiveRms = rmsWindow(samples, policy.sampleRate, policy.positiveSpan);
  const negativeRms = policy.negativeSpans.map((span) =>
    rmsWindow(samples, policy.sampleRate, span)
  );
  if (positiveRms <= 1e-5 || negativeRms.some((value) => value > 1e-8)) {
    throw new Error(`${caseId}: target reference does not match its positive/negative span anchors`);
  }
  return { positiveRms, negativeRms };
}

function createTarget(
  source: string,
  destination: string,
  policy: ReturnType<typeof loadQueryIsolationBakeoffManifest>['fixturePolicy']
): void {
  const [start, end] = policy.positiveSpan;
  const filter =
    `atrim=duration=${policy.durationSeconds},asetpts=PTS-STARTPTS,` +
    `aformat=sample_rates=${policy.sampleRate}:channel_layouts=mono,` +
    `volume='if(between(t,${start},${end}),${policy.targetGain},0)':eval=frame`;
  ffmpeg([
    '-i',
    source,
    '-map',
    '0:a:0',
    '-af',
    filter,
    '-t',
    String(policy.durationSeconds),
    '-c:a',
    'pcm_f32le',
    destination,
  ]);
}

function createResidual(
  sources: string[],
  destination: string,
  policy: ReturnType<typeof loadQueryIsolationBakeoffManifest>['fixturePolicy']
): void {
  const inputArgs = sources.flatMap((source) => ['-i', source]);
  const filters = sources.map(
    (_source, index) =>
      `[${index}:a:0]atrim=duration=${policy.durationSeconds},asetpts=PTS-STARTPTS,` +
      `aformat=sample_rates=${policy.sampleRate}:channel_layouts=mono,` +
      `volume=${policy.interfererGain}[r${index}]`
  );
  filters.push(
    `${sources.map((_source, index) => `[r${index}]`).join('')}` +
      `amix=inputs=${sources.length}:duration=longest:normalize=0[residual]`
  );
  ffmpeg([
    ...inputArgs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[residual]',
    '-t',
    String(policy.durationSeconds),
    '-c:a',
    'pcm_f32le',
    destination,
  ]);
}

function createMixture(target: string, residual: string, destination: string): void {
  ffmpeg([
    '-i',
    target,
    '-i',
    residual,
    '-filter_complex',
    '[0:a:0][1:a:0]amix=inputs=2:duration=longest:normalize=0[mixture]',
    '-map',
    '[mixture]',
    '-c:a',
    'pcm_f32le',
    destination,
  ]);
}

function verifyFixtureDirectory(outputDirectory: string): Record<string, unknown> {
  const manifest = loadQueryIsolationBakeoffManifest(REPOSITORY_ROOT);
  const evidencePath = resolve(outputDirectory, EVIDENCE_FILE);
  const evidence: unknown = JSON.parse(readFileSync(evidencePath, 'utf8'));
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('fixture evidence is invalid');
  }
  const record = evidence as Record<string, unknown>;
  if (
    record.schemaVersion !== EVIDENCE_SCHEMA ||
    record.bakeoffVersion !== QUERY_ISOLATION_BAKEOFF_VERSION ||
    record.manifestSha256 !== sha256File(resolve(REPOSITORY_ROOT, QUERY_ISOLATION_BAKEOFF_MANIFEST_PATH)) ||
    !Array.isArray(record.cases) ||
    record.cases.length !== manifest.objectiveCases.length
  ) {
    throw new Error('fixture evidence does not match the pinned bake-off manifest');
  }
  const byId = new Map(
    (record.cases as Array<Record<string, unknown>>).map((candidate) => [candidate.id, candidate])
  );
  for (const candidate of manifest.objectiveCases) {
    const stored = byId.get(candidate.id);
    if (!stored || typeof stored.files !== 'object' || !stored.files) {
      throw new Error(`${candidate.id}: fixture evidence is missing`);
    }
    const files = stored.files as Record<string, Record<string, unknown>>;
    for (const role of ['mixture', 'target', 'residual']) {
      const path = resolve(outputDirectory, candidate.id, `${role}.wav`);
      const actual = generatedFile(path);
      if (files[role]?.bytes !== actual.bytes || files[role]?.sha256 !== actual.sha256) {
        throw new Error(`${candidate.id}: ${role} fixture identity drifted`);
      }
    }
    const mixture = decodeF32(
      resolve(outputDirectory, candidate.id, 'mixture.wav'),
      manifest.fixturePolicy.sampleRate
    );
    const target = decodeF32(
      resolve(outputDirectory, candidate.id, 'target.wav'),
      manifest.fixturePolicy.sampleRate
    );
    const residual = decodeF32(
      resolve(outputDirectory, candidate.id, 'residual.wav'),
      manifest.fixturePolicy.sampleRate
    );
    verifySpanConstruction(target, manifest.fixturePolicy, candidate.id);
    if (reconstructionResidualDb(mixture, target, residual) > -100) {
      throw new Error(`${candidate.id}: fixture references no longer reconstruct the mixture`);
    }
  }
  return record;
}

function prepareFixtures(): Record<string, unknown> {
  const manifest = loadQueryIsolationBakeoffManifest(REPOSITORY_ROOT);
  const controls = loadInstrumentControlManifest(REPOSITORY_ROOT);
  const byId = new Map(controls.controls.map((control) => [control.id, control]));
  const outputDirectory = resolve(REPOSITORY_ROOT, QUERY_ISOLATION_BAKEOFF_OUTPUT_DIRECTORY);
  if (existsSync(outputDirectory)) return verifyFixtureDirectory(outputDirectory);
  mkdirSync(dirname(outputDirectory), { recursive: true });
  const temporaryDirectory = mkdtempSync(resolve(dirname(outputDirectory), '.query-isolation-v1-'));
  try {
    const cases: Array<Record<string, unknown>> = [];
    for (const candidate of manifest.objectiveCases) {
      const targetControl = byId.get(candidate.targetControlId);
      const interfererControls = candidate.interfererControlIds.map((id) => byId.get(id));
      if (!targetControl || interfererControls.some((control) => !control)) {
        throw new Error(`${candidate.id}: pinned controls disappeared after validation`);
      }
      const caseDirectory = resolve(temporaryDirectory, candidate.id);
      mkdirSync(caseDirectory);
      const targetPath = resolve(caseDirectory, 'target.wav');
      const residualPath = resolve(caseDirectory, 'residual.wav');
      const mixturePath = resolve(caseDirectory, 'mixture.wav');
      createTarget(
        regularPinnedControl(targetControl),
        targetPath,
        manifest.fixturePolicy
      );
      createResidual(
        interfererControls.map((control) => regularPinnedControl(control!)),
        residualPath,
        manifest.fixturePolicy
      );
      createMixture(targetPath, residualPath, mixturePath);

      const mixture = decodeF32(mixturePath, manifest.fixturePolicy.sampleRate);
      const target = decodeF32(targetPath, manifest.fixturePolicy.sampleRate);
      const residual = decodeF32(residualPath, manifest.fixturePolicy.sampleRate);
      const reconstructionDb = reconstructionResidualDb(mixture, target, residual);
      const spanRms = verifySpanConstruction(target, manifest.fixturePolicy, candidate.id);
      if (reconstructionDb > -100 || scaleInvariantSdrDb(target, target) < 100) {
        throw new Error(`${candidate.id}: generated reference audio failed its construction gate`);
      }
      const sourceUrl = `https://evaluation.invalid/${candidate.id}/mixture.wav`;
      cases.push({
        id: candidate.id,
        targetControl: {
          id: targetControl.id,
          sha256: targetControl.media.sha256,
        },
        interfererControls: interfererControls.map((control) => ({
          id: control!.id,
          sha256: control!.media.sha256,
        })),
        files: {
          mixture: generatedFile(mixturePath),
          target: generatedFile(targetPath),
          residual: generatedFile(residualPath),
        },
        reconstructionResidualDb: reconstructionDb,
        spanRms,
        evaluationInputs: candidate.modes.map((mode) =>
          buildQueryIsolationEvaluationInput(manifest, candidate, mode, sourceUrl)
        ),
      });
    }
    const evidence = {
      schemaVersion: EVIDENCE_SCHEMA,
      bakeoffVersion: QUERY_ISOLATION_BAKEOFF_VERSION,
      manifestSha256: sha256File(
        resolve(REPOSITORY_ROOT, QUERY_ISOLATION_BAKEOFF_MANIFEST_PATH)
      ),
      controlManifestSha256: sha256File(
        resolve(REPOSITORY_ROOT, INSTRUMENT_CONTROL_MANIFEST_PATH)
      ),
      generatedAt: new Date().toISOString(),
      ffmpegVersion: ffmpegVersion(),
      cases,
    };
    writeFileSync(resolve(temporaryDirectory, EVIDENCE_FILE), `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporaryDirectory, outputDirectory);
    return evidence;
  } finally {
    if (existsSync(temporaryDirectory)) rmSync(temporaryDirectory, { recursive: true });
  }
}

const args = process.argv.slice(2);
if (args.some((argument) => argument !== '--verify')) {
  throw new Error(`unknown query-isolation fixture flag: ${args.join(', ')}`);
}
const outputDirectory = resolve(REPOSITORY_ROOT, QUERY_ISOLATION_BAKEOFF_OUTPUT_DIRECTORY);
const evidence = args.includes('--verify')
  ? verifyFixtureDirectory(outputDirectory)
  : prepareFixtures();
console.log(
  JSON.stringify(
    {
      schemaVersion: (evidence as Record<string, unknown>).schemaVersion,
      bakeoffVersion: (evidence as Record<string, unknown>).bakeoffVersion,
      cases: ((evidence as Record<string, unknown>).cases as unknown[]).length,
      outputDirectory: QUERY_ISOLATION_BAKEOFF_OUTPUT_DIRECTORY,
      providerCalls: 0,
    },
    null,
    2
  )
);
