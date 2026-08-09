import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { analyzePcm, roleClassifierVersion } from '../audio-analysis/classifier.ts';
import { ANALYSIS_SAMPLE_RATE } from '../audio-analysis/config.ts';
import { decodeAnalysisWindows } from '../audio-analysis/decoder.ts';

type Choice = 'two' | 'four' | 'six';

const corpus = JSON.parse(readFileSync('tests/corpus/corpus.json', 'utf8')) as {
  sources: Array<{
    slug: string;
    kind: 'file' | 'youtube';
    source: string;
    coverage?: string[];
    provenance?: { sha1?: string };
  }>;
};
const expectations = JSON.parse(
  readFileSync('tests/corpus/autosplit-expectations.json', 'utf8')
) as {
  schemaVersion: string;
  classifierVersion: string;
  analysisSampleRate: number;
  sources: Array<{
    slug: string;
    preferredChoice: Choice;
    acceptedChoices: Choice[];
    rejectedChoices: Choice[];
    rationale: string;
  }>;
};

const modelContracts = [
  { id: 'vocals_instrumental', stems: ['vocals', 'instrumental'] },
  { id: 'htdemucs_ft', stems: ['vocals', 'drums', 'bass', 'other'] },
  { id: 'htdemucs_6s', stems: ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'] },
];

if (
  expectations.schemaVersion !== '1' ||
  expectations.classifierVersion !== roleClassifierVersion() ||
  expectations.analysisSampleRate !== ANALYSIS_SAMPLE_RATE
) {
  throw new Error('AutoSplit expectation manifest does not match the pinned analysis contract');
}

const args = process.argv.slice(2);
const supportedFlags = new Set(['--features']);
const unknownFlags = args.filter((argument) => argument.startsWith('--') && !supportedFlags.has(argument));
if (unknownFlags.length) throw new Error(`unknown AutoSplit evaluation flag: ${unknownFlags.join(', ')}`);
const includeFeatures = args.includes('--features');
const requested = new Set(args.filter((argument) => !argument.startsWith('--')));
const unknown = [...requested].filter(
  (slug) => !expectations.sources.some((expectation) => expectation.slug === slug)
);
if (unknown.length) throw new Error(`unknown AutoSplit corpus slug: ${unknown.join(', ')}`);

const versionLine = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split(/\r?\n/, 1)[0];
const decoderVersion = versionLine.match(/^ffmpeg version ([^ ]+)/)?.[1] ?? 'unknown';
const observations: Array<Record<string, unknown>> = [];
let mismatches = 0;
let preferredMatches = 0;

for (const expectation of expectations.sources) {
  if (requested.size && !requested.has(expectation.slug)) continue;
  const source = corpus.sources.find(
    (candidate) => candidate.kind === 'file' && candidate.slug === expectation.slug
  );
  if (!source) throw new Error(`${expectation.slug}: authorized file source is missing`);
  if (!existsSync(source.source)) {
    throw new Error(
      `${expectation.slug}: ${source.source} is not hydrated; corpus audio is intentionally gitignored`
    );
  }
  if (source.provenance?.sha1) {
    const actualSha1 = createHash('sha1').update(readFileSync(source.source)).digest('hex');
    if (actualSha1 !== source.provenance.sha1) {
      throw new Error(`${expectation.slug}: hydrated audio does not match the recorded Archive SHA-1`);
    }
  }

  const startedAt = performance.now();
  const decoded = await decodeAnalysisWindows(source.source, {
    timeoutMs: 30_000,
    maxSourceDurationSeconds: 900,
  });
  const result = analyzePcm({
    samples: decoded.samples,
    sampleRate: decoded.sampleRate,
    analyzedSeconds: decoded.analyzedSeconds,
    coreModels: modelContracts,
    fallbackModel: 'htdemucs_ft',
    totalMs: 0,
  });
  const choice = result.decision.choice as Choice;
  const preferred = choice === expectation.preferredChoice;
  const rejected = expectation.rejectedChoices.includes(choice);
  const accepted = expectation.acceptedChoices.includes(choice) && !rejected;
  if (preferred) preferredMatches += 1;
  if (!accepted) mismatches += 1;
  observations.push({
    slug: source.slug,
    coverage: source.coverage ?? [],
    choice,
    resolvedCoreModel: result.decision.resolvedCoreModel,
    preferredChoice: expectation.preferredChoice,
    acceptedChoices: expectation.acceptedChoices,
    rejectedChoices: expectation.rejectedChoices,
    preferred,
    accepted,
    reason: result.decision.reason,
    ...(includeFeatures ? { features: result.decision.features } : {}),
    analyzedSeconds: Number(decoded.analyzedSeconds.toFixed(3)),
    elapsedMs: Math.round(performance.now() - startedAt),
  });
}

console.log(
  JSON.stringify(
    {
      schemaVersion: '1',
      classifierVersion: expectations.classifierVersion,
      decoderVersion,
      analysisSampleRate: ANALYSIS_SAMPLE_RATE,
      generatedAt: new Date().toISOString(),
      observations,
      summary: {
        checked: observations.length,
        preferredMatches,
        acceptedAlternatives: observations.length - preferredMatches - mismatches,
        mismatches,
      },
    },
    null,
    2
  )
);

if (mismatches) process.exitCode = 2;
