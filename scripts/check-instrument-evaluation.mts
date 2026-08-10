#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  evaluateInstrumentCandidate,
  instrumentEvaluationPlanSha256,
  loadInstrumentEvaluationPlan,
  summarizeInstrumentEvaluationPlan,
  validateInstrumentCandidateObservations,
  validateInstrumentEvaluationReview,
} from './lib/instrument-evaluation.mts';

function parseArguments(args: string[]): { reviewPath?: string; candidatePath?: string } {
  let reviewPath: string | undefined;
  let candidatePath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== '--review' && argument !== '--candidate') {
      throw new Error(`unknown instrument-evaluation argument: ${argument}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`);
    if (argument === '--review') {
      if (reviewPath) throw new Error('--review may be specified once');
      reviewPath = value;
    } else {
      if (candidatePath) throw new Error('--candidate may be specified once');
      candidatePath = value;
    }
    index += 1;
  }
  if (Boolean(reviewPath) !== Boolean(candidatePath)) {
    throw new Error('--review and --candidate must be supplied together');
  }
  return { reviewPath, candidatePath };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function main(): void {
  const args = parseArguments(process.argv.slice(2));
  const plan = loadInstrumentEvaluationPlan();
  if (!args.reviewPath || !args.candidatePath) {
    process.stdout.write(`${JSON.stringify(summarizeInstrumentEvaluationPlan(plan), null, 2)}\n`);
    return;
  }
  const planSha256 = instrumentEvaluationPlanSha256();
  const review = validateInstrumentEvaluationReview(
    readJson(args.reviewPath),
    plan,
    planSha256
  );
  const candidate = validateInstrumentCandidateObservations(
    readJson(args.candidatePath),
    plan,
    planSha256
  );
  process.stdout.write(
    `${JSON.stringify(evaluateInstrumentCandidate(plan, review, candidate), null, 2)}\n`
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'instrument evaluation failed'}\n`);
  process.exitCode = 1;
}
