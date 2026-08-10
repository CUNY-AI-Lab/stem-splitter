import {
  lstatSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

import { ANALYSIS_SAMPLE_RATE } from '../audio-analysis/config.ts';
import { decodeAnalysisWindows } from '../audio-analysis/decoder.ts';
import { discoveryWindowSampleCounts } from '../audio-analysis/discovery.ts';
import {
  PINNED_INSTRUMENT_CLASSIFIER_VERSION,
  PINNED_INSTRUMENT_MODEL_SHA256,
  PINNED_INSTRUMENT_VOCABULARY_SHA256,
  PINNED_INSTRUMENT_VOCABULARY_VERSION,
} from '../src/analysis/types.ts';
import {
  actualFileSha1,
  approvedCorpusAudioPath,
  loadAndValidateEvaluationInputs,
} from './eval-instrument-discovery.mts';

const INPUT_SCHEMA = 'stem-splitter.instrument-discovery-score-audit-input.v1';
const MAX_SOURCE_DURATION_SECONDS = 15 * 60;
const DECODER_TIMEOUT_MS = 60_000;

function normalizedSlug(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`invalid score-audit corpus slug: ${value}`);
  }
  return value;
}

async function main(): Promise<void> {
  const [rawOutputDirectory, ...requestedArguments] = process.argv.slice(2);
  if (!rawOutputDirectory) {
    throw new Error('score-audit preparation requires an empty output directory');
  }
  const requestedOutputDirectory = resolve(rawOutputDirectory);
  const outputStatus = lstatSync(requestedOutputDirectory);
  if (
    outputStatus.isSymbolicLink() ||
    !outputStatus.isDirectory() ||
    readdirSync(requestedOutputDirectory).length
  ) {
    throw new Error('score-audit output must be an empty, real directory');
  }
  const outputDirectory = realpathSync(requestedOutputDirectory);

  const requested = new Set(requestedArguments.map(normalizedSlug));
  const { corpusSources, expectations } = loadAndValidateEvaluationInputs();
  const expectationBySlug = new Map(
    expectations.sources.map((expectation) => [expectation.slug, expectation])
  );
  for (const slug of requested) {
    if (!expectationBySlug.has(slug)) throw new Error(`unknown score-audit corpus slug: ${slug}`);
  }

  const sources: Array<Record<string, unknown>> = [];
  for (const expectation of expectations.sources) {
    if (requested.size && !requested.has(expectation.slug)) continue;
    const source = corpusSources.find(
      (candidate) => candidate.kind === 'file' && candidate.slug === expectation.slug
    );
    if (!source) throw new Error(`${expectation.slug}: authorized file source is missing`);
    const approved = approvedCorpusAudioPath(source.source, expectation.slug);
    const sourceSha1 = await actualFileSha1(approved.path, approved.bytes);
    if (source.provenance?.sha1 && sourceSha1 !== source.provenance.sha1) {
      throw new Error(`${expectation.slug}: hydrated audio does not match the recorded Archive SHA-1`);
    }
    const decoded = await decodeAnalysisWindows(approved.path, {
      timeoutMs: DECODER_TIMEOUT_MS,
      maxSourceDurationSeconds: MAX_SOURCE_DURATION_SECONDS,
    });
    const windowSampleCounts = discoveryWindowSampleCounts(decoded);
    const pcmFile = `${expectation.slug}.f32le`;
    const pcmBytes = Buffer.from(
      decoded.samples.buffer,
      decoded.samples.byteOffset,
      decoded.samples.byteLength
    );
    writeFileSync(resolve(outputDirectory, pcmFile), pcmBytes, {
      flag: 'wx',
      mode: 0o600,
    });
    sources.push({
      slug: expectation.slug,
      pcmFile,
      pcmBytes: pcmBytes.byteLength,
      windowSampleCounts,
      sourceSha1,
      coverage: source.coverage ?? [],
      expectedGroups: expectation.expectedGroups,
      hardNegativeIds: expectation.hardNegativeIds,
    });
  }

  const manifest = {
    $schema: INPUT_SCHEMA,
    generatedAt: new Date().toISOString(),
    classifierVersion: PINNED_INSTRUMENT_CLASSIFIER_VERSION,
    weightsSha256: PINNED_INSTRUMENT_MODEL_SHA256,
    vocabularyVersion: PINNED_INSTRUMENT_VOCABULARY_VERSION,
    vocabularySha256: PINNED_INSTRUMENT_VOCABULARY_SHA256,
    sampleRate: ANALYSIS_SAMPLE_RATE,
    sources,
  };
  writeFileSync(
    resolve(outputDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 }
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'score-audit preparation failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
