#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createPrivateTinySolExactControlReviewTemplate,
  tinySolExactControlManifestSha256,
  verifyHydratedTinySolExactControls,
} from './lib/tinysol-exact-control-review.mts';
import { loadTinySolExactControlManifest } from './lib/tinysol-exact-control-corpus.mts';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseOutputPath(args: string[]): string {
  if (args.length !== 2 || args[0] !== '--output' || !args[1] || args[1].startsWith('--')) {
    throw new Error('usage: prepare-tinysol-exact-control-review --output <private-review.json>');
  }
  return resolve(args[1]);
}

export function prepareTinySolExactControlReview(
  outputPath: string,
  repositoryRoot = REPOSITORY_ROOT
): void {
  const manifest = loadTinySolExactControlManifest(repositoryRoot);
  verifyHydratedTinySolExactControls(repositoryRoot, manifest);
  const manifestSha256 = tinySolExactControlManifestSha256(repositoryRoot);
  const template = createPrivateTinySolExactControlReviewTemplate(manifest, manifestSha256);
  writeFileSync(outputPath, `${JSON.stringify(template, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({
    status: template.status,
    outputPath,
    controls: template.controls.length,
    judgmentsPerControl: 2,
    datasetGroundTruth: template.claimBoundary.datasetGroundTruth,
    candidateNegativeReviewStatus: template.claimBoundary.candidateNegativeReviewStatus,
    promotionEligible: template.claimBoundary.promotionEligible,
    next: 'Listen to every complete WAV, finish both judgments per control, then run finalize:tinysol-review.',
  }, null, 2)}\n`);
}

function main(): void {
  prepareTinySolExactControlReview(parseOutputPath(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'TinySOL exact control review preparation failed'}\n`
    );
    process.exitCode = 1;
  }
}
