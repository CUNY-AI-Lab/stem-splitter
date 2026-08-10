import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';

import { ANALYSIS_SAMPLE_RATE } from '../audio-analysis/config.ts';
import { loadAndValidateEvaluationInputs } from '../scripts/eval-instrument-discovery.mts';
import {
  loadMapping,
  yamnetEvaluationSourcePins,
} from '../scripts/eval-yamnet-comparator.mts';
import {
  captureYamnetInstrumentCandidate,
  createYamnetCandidateSourceReport,
  YAMNET_CANDIDATE_SOURCE_REPORT_SCHEMA,
} from '../scripts/lib/yamnet-candidate-capture.mts';
import {
  instrumentEvaluationPlanSha256,
  loadInstrumentEvaluationPlan,
  validateInstrumentCandidateObservations,
} from '../scripts/lib/instrument-evaluation.mts';
import { INSTRUMENT_REVIEW_OPTIONS } from '../src/analysis/instrument-review.ts';

const repositoryRoot = process.cwd();
const imageSourcePaths = [
  'instrument-discovery/vocabulary.json',
  'yamnet-comparator/Dockerfile',
  'yamnet-comparator/backend.py',
  'yamnet-comparator/cli.py',
  'yamnet-comparator/constants.py',
  'yamnet-comparator/contract.py',
  'yamnet-comparator/download_model.py',
  'yamnet-comparator/mapping.json',
];
const controlSourcePaths = {
  comparatorEvaluator: 'scripts/eval-yamnet-comparator.mts',
  controlManifestLibrary: 'scripts/lib/instrument-control-corpus.mts',
  controlHydrator: 'scripts/hydrate-instrument-controls.mts',
  analysisConfig: 'audio-analysis/config.ts',
  analysisDecoder: 'audio-analysis/decoder.ts',
  discoveryWindowPolicy: 'audio-analysis/discovery.ts',
};

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function relativeToRepository(path: string): string {
  return relative(repositoryRoot, path).split('\\').join('/');
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function candidateIdentity() {
  const mapping = loadMapping(INSTRUMENT_REVIEW_OPTIONS.map(({ id }) => id));
  return {
    mapping,
    corpus: {
      classifierVersion: mapping.classifierVersion,
      modelSha256: mapping.modelSha256,
      classMapSha256: mapping.classMapSha256,
      mappingSha256: sha256File('yamnet-comparator/mapping.json'),
      vocabularyVersion: mapping.vocabularyVersion,
      vocabularySha256: mapping.vocabularySha256,
      scoringPolicyVersion: 'max-class-top3-patch-mean-second-window-v1',
      scoringPolicy: mapping.scoringPolicy,
      supportedIds: mapping.supportedIds,
      unsupported: mapping.unsupported,
      officialLicense: 'Apache 2.0',
      kaggleVersionId: 763,
      tensorflowModelsRevision: '4d7bdd8c170ee90850f2f9ccef0f6d19b817de35',
    },
    control: {
      classifierVersion: mapping.classifierVersion,
      modelSha256: mapping.modelSha256,
      classMapSha256: mapping.classMapSha256,
      mappingPath: 'yamnet-comparator/mapping.json',
      mappingSha256: sha256File('yamnet-comparator/mapping.json'),
      vocabularyVersion: mapping.vocabularyVersion,
      vocabularySha256: mapping.vocabularySha256,
      scoringPolicy: mapping.scoringPolicy,
      supportedIds: mapping.supportedIds,
      unsupported: mapping.unsupported,
    },
  };
}

function nativeExecution() {
  return {
    id: `sha256:${'9'.repeat(64)}`,
    platform: 'linux/amd64',
    sizeBytes: 700_000_000,
    host: 'linux/x64',
    emulated: false,
    lockSha256: sha256File('yamnet-comparator/uv.lock'),
    sourceSha256: Object.fromEntries(
      imageSourcePaths.map((path) => [path, sha256File(path)])
    ),
  };
}

function scoreMap(ids: string[]): Record<string, number> {
  return Object.fromEntries(ids.map((id, index) => [id, (index + 1) / 100]));
}

function rankedScores(scores: Record<string, number>) {
  return Object.entries(scores)
    .sort(([leftId, left], [rightId, right]) => right - left || leftId.localeCompare(rightId))
    .map(([id, score]) => ({ id, score }));
}

function topMapped(scores: Record<string, number>) {
  return rankedScores(scores).slice(0, 12);
}

function nativeReports() {
  const plan = loadInstrumentEvaluationPlan(repositoryRoot);
  const identity = candidateIdentity();
  const execution = nativeExecution();
  const supported = new Set(identity.mapping.supportedIds);
  const familyById = new Map(INSTRUMENT_REVIEW_OPTIONS.map(({ id, family }) => [id, family]));
  const { corpusSources, expectations } = loadAndValidateEvaluationInputs();
  const expectationById = new Map(expectations.sources.map((source) => [source.slug, source]));
  const corpusById = new Map(corpusSources.map((source) => [source.slug, source]));
  const corpus = {
    $schema: 'stem-splitter.yamnet-comparator-evaluation.v2',
    generatedAt: '2026-01-01T18:00:00.000Z',
    status: 'comparison-only-no-threshold',
    promotionEligible: false,
    caveat: 'fixture candidate report',
    candidate: identity.corpus,
    execution: structuredClone(execution),
    evaluationSources: {
      nodeVersion: 'v22.23.1',
      corpusPath: 'tests/corpus/corpus.json',
      corpusSha256: plan.partitions[0].manifestSha256,
      groundTruthPath: 'tests/corpus/instrument-discovery-expectations.json',
      groundTruthSha256: plan.partitions[0].expectationsSha256,
      mappingPath: 'yamnet-comparator/mapping.json',
      mappingSha256: sha256File('yamnet-comparator/mapping.json'),
      evaluatorPath: 'scripts/eval-yamnet-comparator.mts',
      evaluatorSha256: sha256File('scripts/eval-yamnet-comparator.mts'),
      ffmpegVersion: '8.0.3-fixture',
      ffprobeVersion: '8.0.3-fixture',
      analysisSampleRate: ANALYSIS_SAMPLE_RATE,
      sourcePins: yamnetEvaluationSourcePins(),
    },
    summary: { sources: plan.partitions[0].sources.length },
    byCoverage: {},
    byFamily: {},
    confusionTrials: [],
    observations: plan.partitions[0].sources.map((source) => {
      const expectation = expectationById.get(source.id)!;
      const corpusSource = corpusById.get(source.id)!;
      const scores = scoreMap(identity.mapping.supportedIds);
      const ranking = rankedScores(scores);
      const rankById = new Map(ranking.map(({ id }, index) => [id, index + 1]));
      return {
        slug: source.id,
        coverage: corpusSource.coverage,
        sourceSha1: corpusSource.provenance?.sha1 ?? 'a'.repeat(40),
        sourceSha256: source.sourceSha256,
        analysisPcmSha256: 'b'.repeat(64),
        analysisWindowSamples: [ANALYSIS_SAMPLE_RATE],
        sourceBytes: 100,
        sourceDurationSeconds: 1,
        analyzedSeconds: 1,
        windowsAnalyzed: 1,
        loadMs: 1,
        inferenceMs: 1,
        timingMs: 2,
        trackScores: scores,
        topMapped: topMapped(scores),
        topAudioSetByWindow: [
          Array.from({ length: 12 }, (_, index) => ({
            index,
            mid: `/m/fixture_${index}`,
            displayName: `Fixture ${index}`,
            top3Mean: 1 - index / 100,
          })),
        ],
        expectedGroups: expectation.expectedGroups.map((group) => {
          const supportedAcceptedIds = group.acceptedIds.filter((id) => supported.has(id));
          if (!supportedAcceptedIds.length) {
            return {
              ...group,
              supportedAcceptedIds,
              state: 'unsupported',
              score: null,
              rank: null,
              family: 'unsupported',
            };
          }
          const families = new Set(supportedAcceptedIds.map((id) => familyById.get(id)));
          return {
            ...group,
            supportedAcceptedIds,
            state: 'eligible',
            score: Math.max(...supportedAcceptedIds.map((id) => scores[id])),
            rank: Math.min(...supportedAcceptedIds.map((id) => rankById.get(id)!)),
            family: families.size === 1 ? [...families][0] : 'cross-family',
          };
        }),
        hardNegatives: expectation.hardNegativeIds
          .filter((id) => supported.has(id))
          .map((id) => ({ id, score: scores[id] }))
          .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)),
      };
    }),
  };
  const controlManifest = JSON.parse(
    readFileSync('tests/corpus/instrument-control-manifest.json', 'utf8')
  );
  const control = {
    $schema: 'stem-splitter.yamnet-control-evaluation.v1',
    generatedAt: '2026-01-01T18:30:00.000Z',
    status: 'dataset-authored-controls-awaiting-teacher-listening',
    promotionEligible: false,
    thresholdSelected: null,
    precisionClaim: 'none-review-pending',
    caveat: 'fixture control report',
    corpus: {
      manifestPath: 'tests/corpus/instrument-control-manifest.json',
      manifestSha256: plan.partitions[1].manifestSha256,
      version: controlManifest.version,
      reviewStatus: controlManifest.reviewStatus,
      negativePolicy: controlManifest.negativePolicy,
      dataset: controlManifest.dataset,
      audioDistribution: 'gitignored-hydrated-by-exact-sha256',
    },
    candidate: identity.control,
    execution: structuredClone(execution),
    evaluator: {
      path: 'scripts/eval-yamnet-controls.mts',
      sha256: sha256File('scripts/eval-yamnet-controls.mts'),
      sourcePins: Object.fromEntries(
        Object.entries(controlSourcePaths).map(([name, path]) => [
          name,
          { path, sha256: sha256File(path) },
        ])
      ),
      ffmpegVersion: '8.0.3-fixture',
      ffprobeVersion: '8.0.3-fixture',
      analysisSampleRate: ANALYSIS_SAMPLE_RATE,
      maximumSourceDurationSeconds: 120,
    },
    summary: { controls: plan.partitions[1].sources.length },
    byFamily: {},
    observations: plan.partitions[1].sources.map((source) => {
      const control = controlManifest.controls.find((item: any) => item.id === source.id)!;
      const scores = scoreMap(identity.mapping.supportedIds);
      const ranking = rankedScores(scores);
      const rankById = new Map(ranking.map(({ id }, index) => [id, index + 1]));
      const positives = control.positiveIds.map((id: string) =>
        supported.has(id)
          ? { id, state: 'eligible', score: scores[id], rank: rankById.get(id) }
          : { id, state: 'unsupported', score: null, rank: null }
      );
      const candidateNegatives = ranking.filter(({ id }) => !control.positiveIds.includes(id));
      return {
        id: source.id,
        instrument: control.instrument,
        family: familyById.get(control.instrument),
        positiveIds: control.positiveIds,
        sourceBytes: control.media.bytes,
        sourceSha256: source.sourceSha256,
        sourceDurationSeconds: control.media.durationSeconds,
        declaredDurationSeconds: control.media.durationSeconds,
        analyzedSeconds: 1,
        windowsAnalyzed: 1,
        loadMs: 1,
        inferenceMs: 1,
        timingMs: 2,
        trackScores: scores,
        positives,
        specificPositive: positives.find(({ id }: { id: string }) => id === control.instrument),
        candidateNegativeCount: candidateNegatives.length,
        topCandidateNegatives: candidateNegatives.slice(0, 12),
        topMapped: topMapped(scores),
      };
    }),
  };
  return { corpus, control };
}

function temporaryReports() {
  const directory = mkdtempSync(join(repositoryRoot, '.yamnet-candidate-test-'));
  const corpusPath = join(directory, 'corpus.json');
  const controlPath = join(directory, 'controls.json');
  const reports = nativeReports();
  writeJson(corpusPath, reports.corpus);
  writeJson(controlPath, reports.control);
  return {
    directory,
    reports,
    corpusPath,
    controlPath,
    corpusRelative: relativeToRepository(corpusPath),
    controlRelative: relativeToRepository(controlPath),
  };
}

test('YAMNet capture binds two native reports and emits only honest abstentions', () => {
  const fixture = temporaryReports();
  try {
    const sourcePath = join(fixture.directory, 'source.json');
    const source = createYamnetCandidateSourceReport(
      fixture.corpusRelative,
      fixture.controlRelative,
      '2026-08-10T19:00:00.000Z',
      repositoryRoot
    );
    writeJson(sourcePath, source);
    const candidate = captureYamnetInstrumentCandidate(
      relativeToRepository(sourcePath),
      '2026-08-10T19:30:00.000Z',
      repositoryRoot
    );
    assert.equal(source.$schema, YAMNET_CANDIDATE_SOURCE_REPORT_SCHEMA);
    assert.equal(candidate.sources.length, 19);
    assert.ok(
      candidate.sources.every(
        (source) =>
          source.outcome === 'abstained' &&
          source.outcomeReason === 'no-label-cleared-threshold' &&
          source.detections.length === 0
      )
    );
    assert.equal(candidate.evidence.execution.imagePlatform, 'linux/amd64');
    assert.equal(candidate.evidence.execution.hostPlatform, 'linux/amd64');
    assert.match(candidate.candidate.preprocessingVersion, /@sha256-[a-f0-9]{12}$/);
    assert.match(candidate.candidate.classifierPolicyVersion, /@sha256-[a-f0-9]{12}$/);
    assert.match(candidate.candidate.thresholdPolicyVersion, /@sha256-[a-f0-9]{12}$/);
    const plan = loadInstrumentEvaluationPlan(repositoryRoot);
    assert.deepEqual(
      validateInstrumentCandidateObservations(
        candidate,
        plan,
        instrumentEvaluationPlanSha256(repositoryRoot),
        repositoryRoot
      ),
      candidate
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('YAMNet capture refuses historical arm64 evidence and native-report drift', () => {
  assert.throws(
    () =>
      createYamnetCandidateSourceReport(
        'docs/acceptance/2026-08-09-yamnet-comparator/native-arm64-corpus.json',
        'docs/acceptance/2026-08-09-yamnet-comparator/native-arm64-controls.json',
        '2026-08-10T20:00:00.000Z',
        repositoryRoot
      ),
    /schema|native|pinned|capture-safe/
  );

  const mutations: Array<[string, (reports: ReturnType<typeof nativeReports>) => void]> = [
    ['image', (reports) => { reports.control.execution.id = `sha256:${'8'.repeat(64)}`; }],
    ['platform', (reports) => { reports.corpus.execution.platform = 'linux/arm64'; }],
    ['host', (reports) => { reports.corpus.execution.host = 'darwin/arm64'; }],
    ['emulation', (reports) => { reports.corpus.execution.emulated = true; }],
    ['lock', (reports) => { reports.corpus.execution.lockSha256 = '0'.repeat(64); }],
    [
      'evaluator pin',
      (reports) => {
        reports.corpus.evaluationSources.sourcePins.analysisDecoder.sha256 = '0'.repeat(64);
      },
    ],
    ['source hash', (reports) => { reports.corpus.observations[0].sourceSha256 = '0'.repeat(64); }],
    [
      'Archive SHA-1',
      (reports) => {
        const observation = reports.corpus.observations.find(
          (item: { slug: string }) => item.slug === 'synthwave'
        )!;
        observation.sourceSha1 = '0'.repeat(40);
      },
    ],
    ['source order', (reports) => { reports.control.observations.reverse(); }],
    ['score ranking', (reports) => { reports.corpus.observations[0].topMapped.reverse(); }],
    [
      'PCM plan',
      (reports) => { reports.corpus.observations[0].analysisWindowSamples[0] += 100; },
    ],
    [
      'control negatives',
      (reports) => { reports.control.observations[0].candidateNegativeCount -= 1; },
    ],
    ['mapping', (reports) => { reports.control.candidate.mappingSha256 = '0'.repeat(64); }],
    ['threshold', (reports) => { (reports.control as any).thresholdSelected = 0.5; }],
  ];
  for (const [name, mutate] of mutations) {
    const fixture = temporaryReports();
    try {
      mutate(fixture.reports);
      writeJson(fixture.corpusPath, fixture.reports.corpus);
      writeJson(fixture.controlPath, fixture.reports.control);
      assert.throws(
        () =>
          createYamnetCandidateSourceReport(
            fixture.corpusRelative,
            fixture.controlRelative,
            '2026-08-10T20:00:00.000Z',
            repositoryRoot
          ),
        /./,
        name
      );
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

test('YAMNet capture detects report replacement and symbolic-link input', () => {
  const fixture = temporaryReports();
  try {
    const sourcePath = join(fixture.directory, 'source.json');
    const source = createYamnetCandidateSourceReport(
      fixture.corpusRelative,
      fixture.controlRelative,
      '2026-08-10T20:00:00.000Z',
      repositoryRoot
    );
    writeJson(sourcePath, source);
    fixture.reports.corpus.caveat = 'replaced after binding';
    writeJson(fixture.corpusPath, fixture.reports.corpus);
    assert.throws(
      () =>
        captureYamnetInstrumentCandidate(
          relativeToRepository(sourcePath),
          '2026-08-10T20:30:00.000Z',
          repositoryRoot
        ),
      /content drifted/
    );

    const linkedPath = join(fixture.directory, 'linked-controls.json');
    symlinkSync('controls.json', linkedPath);
    assert.throws(
      () =>
        createYamnetCandidateSourceReport(
          fixture.corpusRelative,
          relativeToRepository(linkedPath),
          '2026-08-10T20:00:00.000Z',
          repositoryRoot
        ),
      /symbolic link/
    );
    assert.throws(
      () =>
        createYamnetCandidateSourceReport(
          fixture.corpusRelative,
          fixture.controlRelative,
          '2026-08-10T20:00:00.000Z',
          fixture.directory
        ),
      /repository root must match the current checkout/
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('YAMNet capture commands use owner-only no-overwrite outputs', () => {
  const fixture = temporaryReports();
  try {
    const sourcePath = join(fixture.directory, 'source.json');
    const candidatePath = join(fixture.directory, 'candidate.json');
    const prepare = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(repositoryRoot, 'scripts/prepare-yamnet-candidate-source.mts'),
        '--corpus-report',
        fixture.corpusRelative,
        '--control-report',
        fixture.controlRelative,
        '--output',
        relativeToRepository(sourcePath),
      ],
      { cwd: repositoryRoot, encoding: 'utf8' }
    );
    assert.equal(prepare.status, 0, prepare.stderr);
    assert.equal(lstatSync(sourcePath).mode & 0o777, 0o600);

    const outsideSourcePath = join(fixture.directory, 'outside.json');
    const outside = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(repositoryRoot, 'scripts/prepare-yamnet-candidate-source.mts'),
        '--corpus-report',
        fixture.corpusRelative,
        '--control-report',
        fixture.controlRelative,
        '--output',
        outsideSourcePath,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' }
    );
    assert.notEqual(outside.status, 0);
    assert.match(outside.stderr, /repository-relative/);

    const capture = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(repositoryRoot, 'scripts/capture-yamnet-instrument-candidate.mts'),
        '--source-report',
        relativeToRepository(sourcePath),
        '--output',
        candidatePath,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' }
    );
    assert.equal(capture.status, 0, capture.stderr);
    assert.equal(lstatSync(candidatePath).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(candidatePath, 'utf8')).sources.length, 19);

    const noOverwrite = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(repositoryRoot, 'scripts/capture-yamnet-instrument-candidate.mts'),
        '--source-report',
        relativeToRepository(sourcePath),
        '--output',
        candidatePath,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' }
    );
    assert.notEqual(noOverwrite.status, 0);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
