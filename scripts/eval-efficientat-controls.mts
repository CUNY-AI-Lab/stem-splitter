#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { endianness } from 'node:os';
import {
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ANALYSIS_SAMPLE_RATE } from '../audio-analysis/config.ts';
import {
  decoderVersion,
  inspectImage,
  loadMapping,
  runComparator,
  sha256File,
  trackScores,
  type ImageExecution,
} from './eval-efficientat-comparator.mts';
import {
  INSTRUMENT_CONTROL_MANIFEST_PATH,
  instrumentControlPath,
  loadInstrumentControlManifest,
  type InstrumentControl,
  type InstrumentControlManifest,
} from './lib/instrument-control-corpus.mts';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_SCHEMA = 'stem-splitter.efficientat-control-evaluation.v1';
const EVALUATOR_PATH = 'scripts/eval-efficientat-controls.mts';
const COMPARATOR_EVALUATOR_PATH = 'scripts/eval-efficientat-comparator.mts';
const CONTROL_MANIFEST_LIBRARY_PATH = 'scripts/lib/instrument-control-corpus.mts';
const CONTROL_HYDRATOR_PATH = 'scripts/hydrate-instrument-controls.mts';
const ANALYSIS_CONFIG_PATH = 'audio-analysis/config.ts';
const ANALYSIS_DECODER_PATH = 'audio-analysis/decoder.ts';
const DISCOVERY_WINDOW_POLICY_PATH = 'audio-analysis/discovery.ts';
const MAPPING_PATH = 'efficientat-comparator/mapping.json';
const VOCABULARY_PATH = 'instrument-discovery/vocabulary.json';
const MAX_SOURCE_DURATION_SECONDS = 120;
const DECODER_TIMEOUT_MS = 30_000;
const THRESHOLDS = Array.from({ length: 19 }, (_, index) => (index + 1) / 20);
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface PositiveScore {
  id: string;
  state: 'eligible' | 'unsupported';
  score: number | null;
  rank: number | null;
}

export interface EfficientatControlObservation {
  id: string;
  instrument: string;
  family: string;
  positiveIds: string[];
  sourceBytes: number;
  sourceSha256: string;
  sourceDurationSeconds: number;
  declaredDurationSeconds: number;
  analyzedSeconds: number;
  windowsAnalyzed: number;
  loadMs: number;
  inferenceMs: number;
  timingMs: number;
  trackScores: Record<string, number>;
  positives: PositiveScore[];
  specificPositive: PositiveScore;
  candidateNegativeCount: number;
  topCandidateNegatives: Array<{ id: string; score: number }>;
  topMapped: Array<{ id: string; score: number }>;
}

function safeId(value: string, context: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`${context} is invalid`);
  return value;
}

function loadVocabulary(): {
  ids: string[];
  familyById: Map<string, string>;
} {
  const value: unknown = JSON.parse(readFileSync(VOCABULARY_PATH, 'utf8'));
  if (!value || typeof value !== 'object' || !Array.isArray((value as { instruments?: unknown }).instruments)) {
    throw new Error('instrument vocabulary is invalid');
  }
  const ids: string[] = [];
  const familyById = new Map<string, string>();
  for (const item of (value as { instruments: unknown[] }).instruments) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof (item as { id?: unknown }).id !== 'string' ||
      typeof (item as { family?: unknown }).family !== 'string'
    ) {
      throw new Error('instrument vocabulary item is invalid');
    }
    const id = safeId((item as { id: string }).id, 'instrument vocabulary id');
    const family = safeId((item as { family: string }).family, 'instrument vocabulary family');
    if (familyById.has(id)) throw new Error('instrument vocabulary contains a duplicate id');
    ids.push(id);
    familyById.set(id, family);
  }
  return { ids, familyById };
}

function approvedControlAudioPath(
  manifest: InstrumentControlManifest,
  control: InstrumentControl
): { path: string; bytes: number; sha256: string } {
  const path = instrumentControlPath(REPOSITORY_ROOT, manifest, control);
  const outputRoot = resolve(REPOSITORY_ROOT, manifest.downloadPolicy.outputDirectory);
  let outputStat;
  let sourceStat;
  try {
    outputStat = lstatSync(outputRoot);
    sourceStat = lstatSync(path);
  } catch {
    throw new Error(`${control.id}: hydrate the pinned control corpus before evaluation`);
  }
  if (
    outputStat.isSymbolicLink() ||
    !outputStat.isDirectory() ||
    sourceStat.isSymbolicLink() ||
    !sourceStat.isFile() ||
    sourceStat.size !== control.media.bytes ||
    realpathSync(outputRoot) !== outputRoot ||
    realpathSync(path) !== path ||
    !path.startsWith(`${outputRoot}${sep}`)
  ) {
    throw new Error(`${control.id}: hydrated control path is not the pinned regular file`);
  }
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (digest !== control.media.sha256) {
    throw new Error(`${control.id}: hydrated control SHA-256 does not match`);
  }
  return { path, bytes: sourceStat.size, sha256: digest };
}

function scoreObservation(
  control: InstrumentControl,
  family: string,
  scores: Record<string, number>,
  supportedIds: string[]
): Pick<
  EfficientatControlObservation,
  'positives' | 'specificPositive' | 'candidateNegativeCount' | 'topCandidateNegatives' | 'topMapped'
> {
  const ranking = Object.entries(scores).sort(
    ([leftId, leftScore], [rightId, rightScore]) =>
      rightScore - leftScore || leftId.localeCompare(rightId)
  );
  const rankById = new Map(ranking.map(([id], index) => [id, index + 1]));
  const supported = new Set(supportedIds);
  const positives: PositiveScore[] = control.positiveIds.map((id) =>
    supported.has(id)
      ? { id, state: 'eligible', score: scores[id], rank: rankById.get(id) ?? null }
      : { id, state: 'unsupported', score: null, rank: null }
  );
  const specificPositive = positives.find((positive) => positive.id === control.instrument);
  if (!specificPositive) throw new Error(`${control.id}: specific positive is missing`);
  const positiveSet = new Set(control.positiveIds);
  const candidateNegatives = ranking
    .filter(([id]) => !positiveSet.has(id))
    .map(([id, score]) => ({ id, score }));
  if (candidateNegatives.length !== supportedIds.length - positives.filter((item) => item.state === 'eligible').length) {
    throw new Error(`${control.id}: candidate-negative partition is invalid`);
  }
  if (!family) throw new Error(`${control.id}: family is missing`);
  return {
    positives,
    specificPositive,
    candidateNegativeCount: candidateNegatives.length,
    topCandidateNegatives: candidateNegatives.slice(0, 12),
    topMapped: ranking.slice(0, 12).map(([id, score]) => ({ id, score })),
  };
}

export function summarizeEfficientatControlObservations(
  observations: EfficientatControlObservation[],
  thresholds = THRESHOLDS
) {
  const eligible = observations.filter(
    (observation) => observation.specificPositive.state === 'eligible'
  );
  const unsupported = observations.filter(
    (observation) => observation.specificPositive.state === 'unsupported'
  );
  const hits = (maximumRank: number) =>
    eligible.filter(
      (observation) =>
        (observation.specificPositive.rank ?? Number.POSITIVE_INFINITY) <= maximumRank
    ).length;
  const reciprocalRank = eligible.reduce(
    (sum, observation) =>
      sum + (observation.specificPositive.rank ? 1 / observation.specificPositive.rank : 0),
    0
  );
  return {
    controls: observations.length,
    eligibleSpecificPositives: eligible.length,
    unsupportedSpecificPositives: unsupported.length,
    top1SpecificPositives: hits(1),
    top3SpecificPositives: hits(3),
    top5SpecificPositives: hits(5),
    top10SpecificPositives: hits(10),
    meanReciprocalRankBasisPoints: eligible.length
      ? Math.round((reciprocalRank / eligible.length) * 10_000)
      : 0,
    candidateNegativeAnnotations: observations.reduce(
      (sum, observation) => sum + observation.candidateNegativeCount,
      0
    ),
    thresholdSweep: thresholds.map((threshold) => ({
      threshold,
      eligibleSpecificPositives: eligible.length,
      specificPositiveHits: eligible.filter(
        (observation) => (observation.specificPositive.score ?? 0) >= threshold
      ).length,
      candidateNegativeAlerts: observations.reduce(
        (sum, observation) =>
          sum +
          Object.entries(observation.trackScores).filter(
            ([id, score]) => !observation.positiveIds.includes(id) && score >= threshold
          ).length,
        0
      ),
      precisionClaim: 'none-review-pending' as const,
    })),
    totalLoadMs: observations.reduce((sum, observation) => sum + observation.loadMs, 0),
    totalInferenceMs: observations.reduce((sum, observation) => sum + observation.inferenceMs, 0),
    totalComparatorMs: observations.reduce((sum, observation) => sum + observation.timingMs, 0),
  };
}

function parseArguments(args: string[]): {
  image: string;
  outputPath?: string;
  ids: Set<string>;
} {
  let image = '';
  let outputPath: string | undefined;
  const ids = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--image' || argument === '--output') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      if (argument === '--image') {
        if (image) throw new Error('--image may be specified once');
        image = value;
      } else {
        if (outputPath) throw new Error('--output may be specified once');
        outputPath = value;
      }
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown EfficientAT control-evaluation flag: ${argument}`);
    } else {
      const id = safeId(argument, 'requested control id');
      if (ids.has(id)) throw new Error(`duplicate requested control id: ${id}`);
      ids.add(id);
    }
  }
  if (!image) throw new Error('--image is required');
  return { image, outputPath, ids };
}

async function main(): Promise<void> {
  if (endianness() !== 'LE') throw new Error('EfficientAT control evaluation requires a little-endian host');
  const { image, outputPath, ids } = parseArguments(process.argv.slice(2));
  const manifest = loadInstrumentControlManifest(REPOSITORY_ROOT);
  const vocabulary = loadVocabulary();
  const mapping = loadMapping(vocabulary.ids);
  const execution: ImageExecution = inspectImage(image);
  const knownIds = new Set(manifest.controls.map((control) => control.id));
  for (const id of ids) {
    if (!knownIds.has(id)) throw new Error(`unknown EfficientAT control id: ${id}`);
  }
  const [{ decodeAnalysisWindows }, { discoveryWindowSampleCounts }] = await Promise.all([
    import('../audio-analysis/decoder.ts'),
    import('../audio-analysis/discovery.ts'),
  ]);
  const observations: EfficientatControlObservation[] = [];
  for (const control of manifest.controls) {
    if (ids.size && !ids.has(control.id)) continue;
    const approved = approvedControlAudioPath(manifest, control);
    const decoded = await decodeAnalysisWindows(approved.path, {
      timeoutMs: DECODER_TIMEOUT_MS,
      maxSourceDurationSeconds: MAX_SOURCE_DURATION_SECONDS,
    });
    if (Math.abs(decoded.sourceDurationSeconds - control.media.durationSeconds) > 0.02) {
      throw new Error(`${control.id}: decoded duration does not match the manifest`);
    }
    const windowCounts = discoveryWindowSampleCounts(decoded);
    const pcm = Buffer.from(
      decoded.samples.buffer,
      decoded.samples.byteOffset,
      decoded.samples.byteLength
    );
    const result = runComparator(execution, control.id, pcm, windowCounts, mapping.supportedIds);
    const scores = trackScores(result, mapping.supportedIds);
    const family = vocabulary.familyById.get(control.instrument);
    if (!family) throw new Error(`${control.id}: instrument is absent from the vocabulary`);
    const scored = scoreObservation(control, family, scores, mapping.supportedIds);
    observations.push({
      id: control.id,
      instrument: control.instrument,
      family,
      positiveIds: control.positiveIds,
      sourceBytes: approved.bytes,
      sourceSha256: approved.sha256,
      sourceDurationSeconds: Number(decoded.sourceDurationSeconds.toFixed(6)),
      declaredDurationSeconds: control.media.durationSeconds,
      analyzedSeconds: Number(decoded.analyzedSeconds.toFixed(3)),
      windowsAnalyzed: windowCounts.length,
      loadMs: result.loadMs,
      inferenceMs: result.windows.reduce((sum, window) => sum + window.inferenceMs, 0),
      timingMs: result.timingMs,
      trackScores: scores,
      ...scored,
    });
  }
  const summary = summarizeEfficientatControlObservations(observations);
  const byFamily: Record<string, ReturnType<typeof summarizeEfficientatControlObservations>> = {};
  for (const family of [...new Set(observations.map((observation) => observation.family))].sort()) {
    byFamily[family] = summarizeEfficientatControlObservations(
      observations.filter((observation) => observation.family === family)
    );
  }
  const report = {
    $schema: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    status: 'dataset-authored-controls-awaiting-teacher-listening',
    promotionEligible: false,
    thresholdSelected: null,
    precisionClaim: 'none-review-pending',
    caveat:
      'ChoraleBricks identifies these as isolated instrument tracks, but an authorized teacher has not listened to each positive and candidate negative. Rankings and diagnostic alerts cannot select thresholds or support precision claims.',
    corpus: {
      manifestPath: INSTRUMENT_CONTROL_MANIFEST_PATH,
      manifestSha256: sha256File(INSTRUMENT_CONTROL_MANIFEST_PATH),
      version: manifest.version,
      reviewStatus: manifest.reviewStatus,
      negativePolicy: manifest.negativePolicy,
      dataset: manifest.dataset,
      audioDistribution: 'gitignored-hydrated-by-exact-sha256',
    },
    candidate: {
      classifierVersion: mapping.classifierVersion,
      modelSha256: mapping.modelSha256,
      classMapSha256: mapping.classMapSha256,
      mappingPath: MAPPING_PATH,
      mappingSha256: sha256File(MAPPING_PATH),
      vocabularyVersion: mapping.vocabularyVersion,
      vocabularySha256: mapping.vocabularySha256,
      scoringPolicy: mapping.scoringPolicy,
      supportedIds: mapping.supportedIds,
      unsupported: mapping.unsupported,
    },
    execution,
    evaluator: {
      path: EVALUATOR_PATH,
      sha256: sha256File(EVALUATOR_PATH),
      sourcePins: {
        comparatorEvaluator: {
          path: COMPARATOR_EVALUATOR_PATH,
          sha256: sha256File(COMPARATOR_EVALUATOR_PATH),
        },
        controlManifestLibrary: {
          path: CONTROL_MANIFEST_LIBRARY_PATH,
          sha256: sha256File(CONTROL_MANIFEST_LIBRARY_PATH),
        },
        controlHydrator: {
          path: CONTROL_HYDRATOR_PATH,
          sha256: sha256File(CONTROL_HYDRATOR_PATH),
        },
        analysisConfig: {
          path: ANALYSIS_CONFIG_PATH,
          sha256: sha256File(ANALYSIS_CONFIG_PATH),
        },
        analysisDecoder: {
          path: ANALYSIS_DECODER_PATH,
          sha256: sha256File(ANALYSIS_DECODER_PATH),
        },
        discoveryWindowPolicy: {
          path: DISCOVERY_WINDOW_POLICY_PATH,
          sha256: sha256File(DISCOVERY_WINDOW_POLICY_PATH),
        },
      },
      ffmpegVersion: decoderVersion('ffmpeg'),
      ffprobeVersion: decoderVersion('ffprobe'),
      analysisSampleRate: ANALYSIS_SAMPLE_RATE,
      maximumSourceDurationSeconds: MAX_SOURCE_DURATION_SECONDS,
    },
    summary,
    byFamily,
    observations,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    writeFileSync(outputPath, serialized, { flag: 'wx', mode: 0o600 });
  } else {
    process.stdout.write(serialized);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'EfficientAT control evaluation failed'}\n`
    );
    process.exitCode = 1;
  });
}
