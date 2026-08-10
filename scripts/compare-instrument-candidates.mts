#!/usr/bin/env node

import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  compareInstrumentCandidateArtifacts,
  INSTRUMENT_CANDIDATE_COMPARISON_MAX_CANDIDATES,
  INSTRUMENT_CANDIDATE_COMPARISON_MAX_CANDIDATE_BYTES,
  INSTRUMENT_CANDIDATE_COMPARISON_MAX_REVIEW_BYTES,
  summarizeInstrumentCandidateComparison,
} from './lib/instrument-candidate-comparison.mts';
import {
  instrumentEvaluationPlanSha256,
  loadInstrumentEvaluationPlan,
} from './lib/instrument-evaluation.mts';

interface Arguments {
  reviewPath?: string;
  candidatePaths: string[];
  outputPath?: string;
  requireComparable: boolean;
}

function parseArguments(args: string[]): Arguments {
  const parsed: Arguments = { candidatePaths: [], requireComparable: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--require-comparable') {
      if (parsed.requireComparable) throw new Error('--require-comparable may be specified once');
      parsed.requireComparable = true;
      continue;
    }
    if (!['--review', '--candidate', '--output'].includes(argument)) {
      throw new Error(`unknown instrument-candidate comparison argument: ${argument}`);
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`);
    if (argument === '--review') {
      if (parsed.reviewPath) throw new Error('--review may be specified once');
      parsed.reviewPath = value;
    } else if (argument === '--candidate') {
      if (parsed.candidatePaths.length >= INSTRUMENT_CANDIDATE_COMPARISON_MAX_CANDIDATES) {
        throw new Error(
          `--candidate may be specified at most ${INSTRUMENT_CANDIDATE_COMPARISON_MAX_CANDIDATES} times`
        );
      }
      parsed.candidatePaths.push(value);
    } else {
      if (parsed.outputPath) throw new Error('--output may be specified once');
      parsed.outputPath = value;
    }
  }
  const hasArtifacts = Boolean(parsed.reviewPath) || parsed.candidatePaths.length > 0;
  if (hasArtifacts && (!parsed.reviewPath || parsed.candidatePaths.length < 1)) {
    throw new Error('--review and at least one --candidate must be supplied together');
  }
  if (!hasArtifacts && (parsed.outputPath || parsed.requireComparable)) {
    throw new Error('--output and --require-comparable require review and candidate artifacts');
  }
  return parsed;
}

function readRegularArtifact(path: string, maximumBytes: number, context: string): Buffer {
  const resolvedPath = resolve(path);
  const metadata = lstatSync(resolvedPath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size < 2 ||
    metadata.size > maximumBytes ||
    realpathSync(resolvedPath) !== resolvedPath
  ) {
    throw new Error(`${context} must be a bounded regular nonsymlinked file`);
  }
  return readFileSync(resolvedPath);
}

function safeOutputPath(path: string): string {
  const resolvedPath = resolve(path);
  const parent = dirname(resolvedPath);
  const metadata = lstatSync(parent);
  if (!metadata.isDirectory() || realpathSync(parent) !== parent) {
    throw new Error('instrument comparison output parent must be a regular directory');
  }
  return resolvedPath;
}

function main(): void {
  const args = parseArguments(process.argv.slice(2));
  const plan = loadInstrumentEvaluationPlan();
  const planSha256 = instrumentEvaluationPlanSha256();
  if (!args.reviewPath) {
    process.stdout.write(
      `${JSON.stringify(summarizeInstrumentCandidateComparison(plan, planSha256), null, 2)}\n`
    );
    return;
  }

  const comparison = compareInstrumentCandidateArtifacts(
    plan,
    planSha256,
    readRegularArtifact(
      args.reviewPath,
      INSTRUMENT_CANDIDATE_COMPARISON_MAX_REVIEW_BYTES,
      'instrument review artifact'
    ),
    args.candidatePaths.map((path, index) =>
      readRegularArtifact(
        path,
        INSTRUMENT_CANDIDATE_COMPARISON_MAX_CANDIDATE_BYTES,
        `instrument candidate artifact ${index + 1}`
      )
    )
  );
  if (args.outputPath) {
    const outputPath = safeOutputPath(args.outputPath);
    writeFileSync(outputPath, `${JSON.stringify(comparison, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          status: comparison.comparable ? 'candidates-comparable-no-selection' : 'comparison-blocked',
          outputPath,
          candidates: comparison.candidates.map(
            ({ metrics }) => metrics.candidate.classifierVersion
          ),
          comparable: comparison.comparable,
          blockers: comparison.comparisonBlockers,
          selectionEligible: comparison.selection.eligible,
        },
        null,
        2
      )}\n`
    );
  } else {
    process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
  }
  if (args.requireComparable && !comparison.comparable) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'instrument candidate comparison failed'}\n`
  );
  process.exitCode = 1;
}
