#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASELINE_PATH = 'docs/acceptance/2026-08-31-yamnet-native-amd64/evidence.json';
const BASELINE_SCHEMA = 'stem-splitter.yamnet-native-amd64-acceptance.v1';
const CORPUS_SCHEMA = 'stem-splitter.efficientat-comparator-evaluation.v2';
const CONTROL_SCHEMA = 'stem-splitter.efficientat-control-evaluation.v1';
const COMPARISON_SCHEMA = 'stem-splitter.instrument-classifier-comparison.v1';
const VOCABULARY_SHA256 = '72b7ab09cc188bf5cb8b47acf55145c45703cd4368e94c372cce8130f96ba140';
const CORPUS_SHA256 = '6c7da157f2364c7cfa3fef0b346f14a6baf0ec89e2aec10a4e21c63c86e86771';
const EXPECTATIONS_SHA256 = 'c3fbe177004adbd01b1896dc2944c41cb216f3df5a69f308d0c7a0bbc521e1f3';
const CONTROL_MANIFEST_SHA256 = 'b2bdd54eed7c9e1bc36e384cbee4cdb61d1532a6502443b558731b6630689b0f';
const YAMNET_CLASSIFIER =
  'google-yamnet-tflite-v1-max-class-top3-patch-mean-second-window-v1@kaggle-version-763';
const EFFICIENTAT_CLASSIFIER =
  'efficientat-mn10-audioset-527-pcm22050-sinc32k-upstream-mel-single-clip-sigmoid-second-window-v1@github-release-v0.0.1';
const EFFICIENTAT_MODEL_SHA256 =
  '0bd7dc2443af498c289a2e739f02ebb515d6aa3fd3ab9db539c86123ae368a4e';
const EFFICIENTAT_CLASS_MAP_SHA256 =
  'cdd1049833c4b86127c2773ac0d14a2754b6a6d0d1798002ed5c66e699708429';
const EFFICIENTAT_MAPPING_SHA256 =
  'b8aa419a47b612144655b2f3409fbb6eb27aabed79b49717a20f96a0f15ad50d';
const EFFICIENTAT_SCORING_POLICY = {
  classAggregation: 'maximum',
  clipAggregation: 'single-sigmoid',
  trackAggregation: 'second-highest-window',
  singleWindowException: true,
  thresholdSelection: 'none',
};

type JsonRecord = Record<string, unknown>;

interface ComparisonInput {
  path: string;
  sha256: string;
  value: JsonRecord;
}

function record(value: unknown, context: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} is invalid`);
  }
  return value as JsonRecord;
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${context} is invalid`);
  return value;
}

function integer(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${context} is invalid`);
  }
  return value as number;
}

function string(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${context} is invalid`);
  return value;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function load(path: string, context: string): ComparisonInput {
  const normalized = resolve(path);
  const bytes = readFileSync(normalized);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${context} is not JSON`);
  }
  return { path, sha256: sha256(bytes), value: record(value, context) };
}

function metric(source: JsonRecord, key: string, context: string): number {
  return integer(source[key], `${context} ${key}`);
}

function candidateIdentity(report: JsonRecord, context: string): JsonRecord {
  const candidate = record(report.candidate, `${context} candidate`);
  if (
    candidate.classifierVersion !== EFFICIENTAT_CLASSIFIER ||
    candidate.modelSha256 !== EFFICIENTAT_MODEL_SHA256 ||
    candidate.classMapSha256 !== EFFICIENTAT_CLASS_MAP_SHA256 ||
    candidate.mappingSha256 !== EFFICIENTAT_MAPPING_SHA256 ||
    candidate.vocabularyVersion !== 'classroom-instruments-v1' ||
    candidate.vocabularySha256 !== VOCABULARY_SHA256 ||
    JSON.stringify(candidate.scoringPolicy) !== JSON.stringify(EFFICIENTAT_SCORING_POLICY) ||
    !Array.isArray(candidate.supportedIds) ||
    candidate.supportedIds.length !== 37 ||
    new Set(candidate.supportedIds).size !== 37 ||
    !Array.isArray(candidate.unsupported) ||
    candidate.unsupported.length !== 14
  ) {
    throw new Error(`${context} candidate identity does not match`);
  }
  return candidate;
}

function validateBaseline(input: ComparisonInput): {
  candidate: JsonRecord;
  corpus: JsonRecord;
  controls: JsonRecord;
} {
  const baseline = input.value;
  const source = record(baseline.source, 'YAMNet source evidence');
  const artifact = record(baseline.artifact, 'YAMNet artifact evidence');
  const safety = record(baseline.safety, 'YAMNet safety evidence');
  const humanReview = record(baseline.humanReview, 'YAMNet human review evidence');
  const candidate = record(baseline.candidate, 'YAMNet candidate evidence');
  const corpus = record(baseline.corpus, 'YAMNet corpus evidence');
  const controls = record(baseline.controls, 'YAMNet control evidence');
  const files = array(artifact.files, 'YAMNet artifact files');
  const expectedFiles = new Map([
    ['yamnet-native-amd64-corpus.json', '6254494f4fcc4b397b3d95713f361229132288c4502bdd2332756b3b85d8a4be'],
    ['yamnet-native-amd64-controls.json', 'c897a4a024978d51eee5ac82741b9bb13354f00a26c05fecb43f90962c77bf82'],
  ]);
  for (const item of files) {
    const file = record(item, 'YAMNet artifact file');
    const name = typeof file.name === 'string' ? file.name : '';
    if (expectedFiles.has(name) && file.sha256 !== expectedFiles.get(name)) {
      throw new Error(`YAMNet artifact hash drifted for ${name}`);
    }
    expectedFiles.delete(name);
  }
  if (
    baseline.$schema !== BASELINE_SCHEMA ||
    baseline.status !== 'passed-comparison-only' ||
    source.runId !== '33450445790' ||
    source.commit !== '76ea7c004d70cffa8aadcfcc177301ee74d2fe2b' ||
    expectedFiles.size !== 0 ||
    candidate.classifierVersion !== YAMNET_CLASSIFIER ||
    candidate.vocabularySha256 !== VOCABULARY_SHA256 ||
    candidate.thresholdSelected !== null ||
    candidate.promotionEligible !== false ||
    humanReview.instrumentReviewAccepted !== false ||
    humanReview.isolatedControlReviewAccepted !== false ||
    safety.railwayServiceCreated !== false ||
    safety.featureFlagChanged !== false ||
    safety.thresholdSelected !== false ||
    safety.promotionAuthorized !== false
  ) {
    throw new Error('YAMNet baseline is not the accepted comparison-only evidence');
  }
  return { candidate, corpus, controls };
}

function validateEfficientat(
  corpusInput: ComparisonInput,
  controlsInput: ComparisonInput
): { candidate: JsonRecord; corpus: JsonRecord; controls: JsonRecord; execution: JsonRecord } {
  const corpusReport = corpusInput.value;
  const controlsReport = controlsInput.value;
  const candidate = candidateIdentity(corpusReport, 'EfficientAT corpus');
  const controlCandidate = candidateIdentity(controlsReport, 'EfficientAT controls');
  const corpus = record(corpusReport.summary, 'EfficientAT corpus summary');
  const controls = record(controlsReport.summary, 'EfficientAT control summary');
  const execution = record(corpusReport.execution, 'EfficientAT execution');
  const controlExecution = record(controlsReport.execution, 'EfficientAT control execution');
  const evaluationSources = record(corpusReport.evaluationSources, 'EfficientAT evaluation sources');
  const controlCorpus = record(controlsReport.corpus, 'EfficientAT control corpus');
  if (
    corpusReport.$schema !== CORPUS_SCHEMA ||
    corpusReport.status !== 'comparison-only-no-threshold' ||
    corpusReport.promotionEligible !== false ||
    candidate.scoringPolicyVersion !== 'single-clip-sigmoid-second-window-v1' ||
    candidate.officialLicense !== 'MIT' ||
    candidate.upstreamRepository !== 'fschmid56/EfficientAT' ||
    candidate.upstreamReleaseTag !== 'v0.0.1' ||
    candidate.upstreamRevision !== '7e30f2bbe85439c15feedd9ba5ad8bff0a600fee' ||
    controlsReport.$schema !== CONTROL_SCHEMA ||
    controlsReport.status !== 'dataset-authored-controls-awaiting-teacher-listening' ||
    controlsReport.promotionEligible !== false ||
    controlsReport.thresholdSelected !== null ||
    controlsReport.precisionClaim !== 'none-review-pending' ||
    candidate.modelSha256 !== controlCandidate.modelSha256 ||
    candidate.classMapSha256 !== controlCandidate.classMapSha256 ||
    candidate.mappingSha256 !== controlCandidate.mappingSha256 ||
    execution.id !== controlExecution.id ||
    execution.platform !== 'linux/amd64' ||
    execution.host !== 'linux/x64' ||
    execution.emulated !== false ||
    evaluationSources.corpusSha256 !== CORPUS_SHA256 ||
    evaluationSources.groundTruthSha256 !== EXPECTATIONS_SHA256 ||
    controlCorpus.manifestSha256 !== CONTROL_MANIFEST_SHA256 ||
    metric(corpus, 'sources', 'EfficientAT corpus') !== 11 ||
    metric(controls, 'controls', 'EfficientAT controls') !== 8 ||
    metric(corpus, 'eligibleExpectedGroups', 'EfficientAT corpus') +
      metric(corpus, 'unsupportedExpectedGroups', 'EfficientAT corpus') !==
      42 ||
    metric(controls, 'eligibleSpecificPositives', 'EfficientAT controls') +
      metric(controls, 'unsupportedSpecificPositives', 'EfficientAT controls') !==
      8
  ) {
    throw new Error('EfficientAT evidence is not a comparable native observation set');
  }
  return { candidate, corpus, controls, execution };
}

function scorecard(candidate: JsonRecord, corpus: JsonRecord, controls: JsonRecord): JsonRecord {
  return {
    classifierVersion: string(candidate.classifierVersion, 'classifier version'),
    supportedLabels: Array.isArray(candidate.supportedIds)
      ? candidate.supportedIds.length
      : integer(candidate.supportedLabels, 'supported labels'),
    corpus: {
      sources: metric(corpus, 'sources', 'corpus'),
      eligibleExpectedGroups: metric(corpus, 'eligibleExpectedGroups', 'corpus'),
      unsupportedExpectedGroups: metric(corpus, 'unsupportedExpectedGroups', 'corpus'),
      top3ExpectedGroups: metric(corpus, 'top3ExpectedGroups', 'corpus'),
      top5ExpectedGroups: metric(corpus, 'top5ExpectedGroups', 'corpus'),
      top10ExpectedGroups: metric(corpus, 'top10ExpectedGroups', 'corpus'),
      meanReciprocalRankBasisPoints: metric(corpus, 'meanReciprocalRankBasisPoints', 'corpus'),
      totalComparatorMs: metric(corpus, 'totalComparatorMs', 'corpus'),
    },
    controls: {
      sources: integer(controls.sources ?? controls.controls, 'control sources'),
      eligibleSpecificPositives: metric(controls, 'eligibleSpecificPositives', 'controls'),
      unsupportedSpecificPositives: metric(controls, 'unsupportedSpecificPositives', 'controls'),
      top1SpecificPositives: metric(controls, 'top1SpecificPositives', 'controls'),
      top3SpecificPositives: metric(controls, 'top3SpecificPositives', 'controls'),
      top5SpecificPositives: metric(controls, 'top5SpecificPositives', 'controls'),
      top10SpecificPositives: metric(controls, 'top10SpecificPositives', 'controls'),
      meanReciprocalRankBasisPoints: metric(controls, 'meanReciprocalRankBasisPoints', 'controls'),
      candidateNegativeAnnotations: metric(controls, 'candidateNegativeAnnotations', 'controls'),
      totalComparatorMs: metric(controls, 'totalComparatorMs', 'controls'),
    },
  };
}

export function buildComparison(
  baselineInput: ComparisonInput,
  corpusInput: ComparisonInput,
  controlsInput: ComparisonInput,
  generatedAt = new Date().toISOString()
): JsonRecord {
  const baseline = validateBaseline(baselineInput);
  const efficientat = validateEfficientat(corpusInput, controlsInput);
  const yamnetCandidate = {
    ...baseline.candidate,
    supportedLabels: 36,
  };
  const yamnet = scorecard(yamnetCandidate, baseline.corpus, baseline.controls);
  const candidate = scorecard(efficientat.candidate, efficientat.corpus, efficientat.controls);
  const yamnetCorpus = record(yamnet.corpus, 'YAMNet scorecard corpus');
  const candidateCorpus = record(candidate.corpus, 'EfficientAT scorecard corpus');
  const yamnetControls = record(yamnet.controls, 'YAMNet scorecard controls');
  const candidateControls = record(candidate.controls, 'EfficientAT scorecard controls');
  return {
    $schema: COMPARISON_SCHEMA,
    generatedAt,
    status: 'abstained-pending-human-review',
    promotionEligible: false,
    precisionClaim: 'none-review-pending',
    comparability: {
      nativeAmd64: true,
      sameCorpusManifest: true,
      sameExpectationManifest: true,
      sameControlManifest: true,
      sameVocabulary: true,
      scoringPoliciesDiffer: true,
      scoresDirectlyInterchangeable: false,
    },
    inputs: {
      yamnetAcceptance: {
        path: baselineInput.path,
        sha256: baselineInput.sha256,
        runId: '33450445790',
      },
      efficientatCorpus: { path: corpusInput.path, sha256: corpusInput.sha256 },
      efficientatControls: { path: controlsInput.path, sha256: controlsInput.sha256 },
    },
    classifiers: { yamnet, efficientat: candidate },
    diagnosticDelta: {
      supportedLabels: integer(candidate.supportedLabels, 'EfficientAT supported labels') - 36,
      addedDirectLabels: ['ukulele'],
      corpusTop3ExpectedGroups:
        metric(candidateCorpus, 'top3ExpectedGroups', 'EfficientAT corpus scorecard') -
        metric(yamnetCorpus, 'top3ExpectedGroups', 'YAMNet corpus scorecard'),
      corpusTop5ExpectedGroups:
        metric(candidateCorpus, 'top5ExpectedGroups', 'EfficientAT corpus scorecard') -
        metric(yamnetCorpus, 'top5ExpectedGroups', 'YAMNet corpus scorecard'),
      corpusMeanReciprocalRankBasisPoints:
        metric(candidateCorpus, 'meanReciprocalRankBasisPoints', 'EfficientAT corpus scorecard') -
        metric(yamnetCorpus, 'meanReciprocalRankBasisPoints', 'YAMNet corpus scorecard'),
      controlTop3SpecificPositives:
        metric(candidateControls, 'top3SpecificPositives', 'EfficientAT control scorecard') -
        metric(yamnetControls, 'top3SpecificPositives', 'YAMNet control scorecard'),
      controlMeanReciprocalRankBasisPoints:
        metric(candidateControls, 'meanReciprocalRankBasisPoints', 'EfficientAT control scorecard') -
        metric(yamnetControls, 'meanReciprocalRankBasisPoints', 'YAMNet control scorecard'),
    },
    decision: {
      selectedClassifier: null,
      thresholdSelected: null,
      result: 'abstain',
      reason: 'exhaustive-label-and-isolated-control-review-incomplete',
      requiredBeforeSelection: [
        'teacher-review-all-19-instrument-observations',
        'teacher-review-isolated-control-positives-and-candidate-negatives',
        'reviewed-cross-classifier-threshold-policy',
        'explicit-promotion-authorization',
      ],
    },
  };
}

function parseArguments(args: string[]): { corpus: string; controls: string; output: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!['--efficientat-corpus', '--efficientat-controls', '--output'].includes(flag) || !value) {
      throw new Error('usage: compare-instrument-classifiers.mts --efficientat-corpus FILE --efficientat-controls FILE --output FILE');
    }
    if (values.has(flag) || value.startsWith('--')) throw new Error(`${flag} is invalid`);
    values.set(flag, value);
  }
  const corpus = values.get('--efficientat-corpus');
  const controls = values.get('--efficientat-controls');
  const output = values.get('--output');
  if (!corpus || !controls || !output || values.size !== 3) {
    throw new Error('all classifier comparison paths are required');
  }
  return { corpus, controls, output };
}

function main(): void {
  const paths = parseArguments(process.argv.slice(2));
  const comparison = buildComparison(
    load(BASELINE_PATH, 'YAMNet acceptance'),
    load(paths.corpus, 'EfficientAT corpus report'),
    load(paths.controls, 'EfficientAT control report')
  );
  writeFileSync(paths.output, `${JSON.stringify(comparison, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'classifier comparison failed'}\n`);
    process.exitCode = 1;
  }
}
