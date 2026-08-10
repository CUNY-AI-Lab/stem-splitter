#!/usr/bin/env node

import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  instrumentEvaluationPlanSha256,
  loadInstrumentEvaluationPlan,
} from './lib/instrument-evaluation.mts';
import { finalizePrivateInstrumentEvaluationReview } from './lib/instrument-evaluation-review.mts';

const MAX_PRIVATE_REVIEW_BYTES = 2 * 1024 * 1024;

function parsePaths(args: string[]): { inputPath: string; outputPath: string } {
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== '--input' && argument !== '--output') {
      throw new Error(`unknown instrument-review argument: ${argument}`);
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
      'usage: finalize-instrument-evaluation-review --input <private-review.json> --output <public-review.json>'
    );
  }
  if (inputPath === outputPath) throw new Error('private input and public output paths must differ');
  return { inputPath, outputPath };
}

function readPrivateReview(path: string): { serialized: string; value: unknown } {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('private instrument review input must be a regular file, not a symbolic link');
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('private instrument review input must be owner-only (chmod 600)');
  }
  if (metadata.size > MAX_PRIVATE_REVIEW_BYTES) {
    throw new Error('private instrument review input exceeds the 2 MiB safety limit');
  }
  const serialized = readFileSync(path, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('private instrument review input is not valid JSON');
  }
  return { serialized, value };
}

function main(): void {
  const { inputPath, outputPath } = parsePaths(process.argv.slice(2));
  const { serialized, value } = readPrivateReview(inputPath);
  const plan = loadInstrumentEvaluationPlan();
  const planSha256 = instrumentEvaluationPlanSha256();
  const review = finalizePrivateInstrumentEvaluationReview(
    value,
    serialized,
    plan,
    planSha256
  );
  writeFileSync(outputPath, `${JSON.stringify(review, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: review.status,
        outputPath,
        sources: review.sources.length,
        privateReviewSha256: review.privateReviewSha256,
        rawTeacherFeedbackIncluded: review.rawTeacherFeedbackIncluded,
      },
      null,
      2
    )}\n`
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'private instrument review finalization failed'}\n`
  );
  process.exitCode = 1;
}
