import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

import { analyzePcm, roleClassifierVersion } from '../audio-analysis/classifier.ts';
import { ANALYSIS_SAMPLE_RATE } from '../audio-analysis/config.ts';
import { decodeAnalysisWindows } from '../audio-analysis/decoder.ts';
import type { RoleFeaturesV1 } from '../src/analysis/types.ts';

type Choice = 'two' | 'four' | 'six';

const corpus = JSON.parse(readFileSync('tests/corpus/corpus.json', 'utf8')) as {
  sources: Array<{
    slug: string;
    kind: 'file' | 'youtube';
    source: string;
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
  }>;
};

const args = process.argv.slice(2);
const supportedFlags = new Set(['--features']);
const unknownFlags = args.filter(
  (argument) => argument.startsWith('--') && !supportedFlags.has(argument)
);
if (unknownFlags.length) throw new Error(`unknown browser evaluation flag: ${unknownFlags.join(', ')}`);
const includeFeatures = args.includes('--features');
const requested = new Set(args.filter((argument) => !argument.startsWith('--')));
const unknownSlugs = [...requested].filter(
  (slug) => !expectations.sources.some((expectation) => expectation.slug === slug)
);
if (unknownSlugs.length) throw new Error(`unknown AutoSplit corpus slug: ${unknownSlugs.join(', ')}`);

if (
  expectations.schemaVersion !== '1' ||
  expectations.classifierVersion !== roleClassifierVersion() ||
  expectations.analysisSampleRate !== ANALYSIS_SAMPLE_RATE
) {
  throw new Error('browser evaluation manifest does not match the pinned analysis contract');
}

const modelContracts = [
  { id: 'vocals_instrumental', stems: ['vocals', 'instrumental'] },
  { id: 'htdemucs_ft', stems: ['vocals', 'drums', 'bass', 'other'] },
  { id: 'htdemucs_6s', stems: ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'] },
];

const classifierSource = readFileSync('public/autosplit.js', 'utf8');
const workerSource = `${classifierSource}\n${readFileSync('public/autosplit-worker.js', 'utf8').replace(
  "importScripts('/autosplit.js');",
  ''
)}`;
const decoderVersionLine = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split(
  /\r?\n/,
  1
)[0];
const decoderVersion = decoderVersionLine.match(/^ffmpeg version ([^ ]+)/)?.[1] ?? 'unknown';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const browserVersion = browser.version();
const observations: Array<Record<string, unknown>> = [];
let decisionMismatches = 0;
let rejectedChoices = 0;

try {
  const page = await browser.newPage();
  await page.setContent('<input id="source" type="file" accept="audio/*">');
  await page.addScriptTag({ path: resolve('public/autosplit.js') });

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
      const sha1 = createHash('sha1').update(readFileSync(source.source)).digest('hex');
      if (sha1 !== source.provenance.sha1) {
        throw new Error(`${expectation.slug}: hydrated audio does not match the recorded Archive SHA-1`);
      }
    }

    await page.locator('#source').setInputFiles(resolve(source.source));
    const browserResult = await page.evaluate(async (sourceCode) => {
      const startedAt = performance.now();
      const input = document.querySelector<HTMLInputElement>('#source');
      const file = input?.files?.[0];
      if (!file) throw new Error('browser source file was not attached');

      const context = new AudioContext();
      let worker: Worker | undefined;
      let workerUrl: string | undefined;
      try {
        let decodeTimer: ReturnType<typeof setTimeout> | undefined;
        const buffer = await Promise.race([
          file.arrayBuffer().then((bytes) => context.decodeAudioData(bytes)),
          new Promise<never>((_, reject) => {
            decodeTimer = setTimeout(() => reject(new Error('browser decode timed out')), 20_000);
          }),
        ]).finally(() => clearTimeout(decodeTimer));
        const autosplit = (globalThis as typeof globalThis & {
          AutoSplit: { downmix(value: AudioBuffer): Float32Array; ROLE_CLASSIFIER_VERSION: string };
        }).AutoSplit;
        const samples = autosplit.downmix(buffer);
        workerUrl = URL.createObjectURL(new Blob([sourceCode], { type: 'text/javascript' }));
        worker = new Worker(workerUrl);
        const result = await new Promise<{
          ok: boolean;
          features: RoleFeaturesV1;
          verdict: { choice: Choice; reason: string };
          error?: string;
        }>((resolveResult, reject) => {
          const timeout = setTimeout(() => reject(new Error('browser worker timed out')), 20_000);
          worker!.addEventListener(
            'message',
            (event) => {
              clearTimeout(timeout);
              if (event.data?.ok) resolveResult(event.data);
              else reject(new Error(event.data?.error ?? 'browser worker failed'));
            },
            { once: true }
          );
          worker!.addEventListener('error', () => reject(new Error('browser worker crashed')), {
            once: true,
          });
          worker!.postMessage(
            { samples: samples.buffer, sampleRate: buffer.sampleRate },
            [samples.buffer]
          );
        });
        return {
          classifierVersion: autosplit.ROLE_CLASSIFIER_VERSION,
          browserSampleRate: buffer.sampleRate,
          choice: result.verdict.choice,
          reason: result.verdict.reason,
          features: result.features,
          elapsedMs: Math.round(performance.now() - startedAt),
        };
      } finally {
        worker?.terminate();
        if (workerUrl) URL.revokeObjectURL(workerUrl);
        await context.close();
      }
    }, workerSource);
    if (browserResult.classifierVersion !== expectations.classifierVersion) {
      throw new Error(`${expectation.slug}: browser classifier version drifted`);
    }

    const decoded = await decodeAnalysisWindows(source.source, {
      timeoutMs: 30_000,
      maxSourceDurationSeconds: 900,
    });
    const serviceResult = analyzePcm({
      samples: decoded.samples,
      sampleRate: decoded.sampleRate,
      analyzedSeconds: decoded.analyzedSeconds,
      coreModels: modelContracts,
      fallbackModel: 'htdemucs_ft',
      totalMs: 0,
    });
    const serviceChoice = serviceResult.decision.choice as Choice;
    const decisionAgreement = browserResult.choice === serviceChoice;
    const rejected = expectation.rejectedChoices.includes(browserResult.choice);
    const accepted = expectation.acceptedChoices.includes(browserResult.choice) && !rejected;
    if (!decisionAgreement) decisionMismatches += 1;
    if (!accepted) rejectedChoices += 1;

    const serviceFeatures = serviceResult.decision.features;
    const featureDelta = {
      onsetsPerSecond: Math.abs(
        browserResult.features.onsetsPerSecond - serviceFeatures.onsetsPerSecond
      ),
      pitchedAttacksPerSecond: Math.abs(
        browserResult.features.pitchedAttacksPerSecond -
          serviceFeatures.pitchedAttacksPerSecond
      ),
      sustainedLow: Math.abs(browserResult.features.sustainedLow - serviceFeatures.sustainedLow),
      percussiveHigh: Math.abs(
        browserResult.features.percussiveHigh - serviceFeatures.percussiveHigh
      ),
    };

    observations.push({
      slug: expectation.slug,
      browserChoice: browserResult.choice,
      serviceChoice,
      preferredChoice: expectation.preferredChoice,
      acceptedChoices: expectation.acceptedChoices,
      rejectedChoices: expectation.rejectedChoices,
      decisionAgreement,
      accepted,
      browserSampleRate: browserResult.browserSampleRate,
      elapsedMs: browserResult.elapsedMs,
      featureDelta,
      ...(includeFeatures
        ? { browserFeatures: browserResult.features, serviceFeatures }
        : {}),
    });
  }
} finally {
  await browser.close();
}

console.log(
  JSON.stringify(
    {
      schemaVersion: '1',
      classifierVersion: roleClassifierVersion(),
      browserVersion,
      decoderVersion,
      analysisSampleRate: ANALYSIS_SAMPLE_RATE,
      observations,
      summary: {
        checked: observations.length,
        decisionMismatches,
        rejectedChoices,
      },
    },
    null,
    2
  )
);

if (decisionMismatches || rejectedChoices) process.exitCode = 2;
