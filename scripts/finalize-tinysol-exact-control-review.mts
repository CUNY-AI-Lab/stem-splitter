#!/usr/bin/env node

import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  finalizePrivateTinySolExactControlReview,
  tinySolExactControlManifestSha256,
  verifyHydratedTinySolExactControls,
} from './lib/tinysol-exact-control-review.mts';
import { loadTinySolExactControlManifest } from './lib/tinysol-exact-control-corpus.mts';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_PRIVATE_REVIEW_BYTES = 128 * 1024;

function parsePaths(args: string[]): { inputPath: string; outputPath: string } {
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== '--input' && argument !== '--output') {
      throw new Error(`unknown TinySOL review argument: ${argument}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`);
    if (argument === '--input') {
      if (inputPath) throw new Error('--input may be specified once');
      inputPath = resolve(value);
    } else {
      if (outputPath) throw new Error('--output may be specified once');
      outputPath = resolve(value);
    }
    index += 1;
  }
  if (!inputPath || !outputPath) {
    throw new Error(
      'usage: finalize-tinysol-exact-control-review --input <private-review.json> --output <public-review.json>'
    );
  }
  if (inputPath === outputPath) throw new Error('private input and public output paths must differ');
  return { inputPath, outputPath };
}

function readPrivateReview(path: string): { serialized: string; value: unknown } {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('private TinySOL review input must be a direct regular file, not a symbolic link');
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('private TinySOL review input must be owner-only (chmod 600)');
  }
  if (metadata.size < 2 || metadata.size > MAX_PRIVATE_REVIEW_BYTES) {
    throw new Error('private TinySOL review input exceeds its 128 KiB safety boundary');
  }
  const serialized = readFileSync(path, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('private TinySOL review input is not valid JSON');
  }
  return { serialized, value };
}

export function finalizeTinySolExactControlReview(
  inputPath: string,
  outputPath: string,
  repositoryRoot = REPOSITORY_ROOT
): void {
  const { serialized, value } = readPrivateReview(inputPath);
  const manifest = loadTinySolExactControlManifest(repositoryRoot);
  verifyHydratedTinySolExactControls(repositoryRoot, manifest);
  const manifestSha256 = tinySolExactControlManifestSha256(repositoryRoot);
  const review = finalizePrivateTinySolExactControlReview(
    value,
    serialized,
    manifest,
    manifestSha256
  );
  writeFileSync(outputPath, `${JSON.stringify(review, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({
    status: review.status,
    outputPath,
    controls: review.controls.length,
    privateReviewSha256: review.privateReviewSha256,
    rawTeacherFeedbackIncluded: review.rawTeacherFeedbackIncluded,
    allSourceLabelsConfirmed: review.reviewSummary.allSourceLabelsConfirmed,
    allVocabularyMappingsApproved: review.reviewSummary.allVocabularyMappingsApproved,
    contrabassToDoubleBassApproved: review.reviewSummary.contrabassToDoubleBassApproved,
    promotionEligible: review.claimBoundary.promotionEligible,
    blockers: review.blockers,
  }, null, 2)}\n`);
}

function main(): void {
  const { inputPath, outputPath } = parsePaths(process.argv.slice(2));
  finalizeTinySolExactControlReview(inputPath, outputPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'TinySOL exact control review finalization failed'}\n`
    );
    process.exitCode = 1;
  }
}
