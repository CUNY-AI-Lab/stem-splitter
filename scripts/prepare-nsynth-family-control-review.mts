#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { INSTRUMENT_REVIEW_OPTIONS } from '../src/analysis/instrument-review.ts';
import {
  createPrivateNsynthFamilyControlReviewTemplate,
  nsynthFamilyControlManifestSha256,
  verifyHydratedNsynthFamilyControls,
} from './lib/nsynth-family-control-review.mts';
import { loadNsynthFamilyControlManifest } from './lib/nsynth-family-control-corpus.mts';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseOutputPath(args: string[]): string {
  if (args.length !== 2 || args[0] !== '--output' || !args[1] || args[1].startsWith('--')) {
    throw new Error('usage: prepare-nsynth-family-control-review --output <private-review.json>');
  }
  return resolve(args[1]);
}

export function prepareNsynthFamilyControlReview(
  outputPath: string,
  repositoryRoot = REPOSITORY_ROOT
): void {
  const manifest = loadNsynthFamilyControlManifest(repositoryRoot);
  verifyHydratedNsynthFamilyControls(repositoryRoot, manifest);
  const manifestSha256 = nsynthFamilyControlManifestSha256(repositoryRoot);
  const template = createPrivateNsynthFamilyControlReviewTemplate(manifest, manifestSha256);
  writeFileSync(outputPath, `${JSON.stringify(template, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: template.status,
        outputPath,
        controls: template.controls.length,
        labelsPerControl: INSTRUMENT_REVIEW_OPTIONS.length,
        exactInstrumentClaims: template.claimBoundary.exactInstrumentClaims,
        promotionEligible: template.claimBoundary.promotionEligible,
        next: 'Listen to each complete WAV, finish every verdict, then run finalize:nsynth-review.',
      },
      null,
      2
    )}\n`
  );
}

function main(): void {
  prepareNsynthFamilyControlReview(parseOutputPath(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'NSynth family control review preparation failed'}\n`
    );
    process.exitCode = 1;
  }
}
