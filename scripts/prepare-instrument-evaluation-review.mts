#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { INSTRUMENT_REVIEW_OPTIONS } from '../src/analysis/instrument-review.ts';
import {
  instrumentEvaluationPlanSha256,
  loadInstrumentEvaluationPlan,
} from './lib/instrument-evaluation.mts';
import { createPrivateInstrumentEvaluationReviewTemplate } from './lib/instrument-evaluation-review.mts';

function parseOutputPath(args: string[]): string {
  if (args.length !== 2 || args[0] !== '--output' || !args[1] || args[1].startsWith('--')) {
    throw new Error('usage: prepare-instrument-evaluation-review --output <private-review.json>');
  }
  return resolve(args[1]);
}

function main(): void {
  const outputPath = parseOutputPath(process.argv.slice(2));
  const plan = loadInstrumentEvaluationPlan();
  const planSha256 = instrumentEvaluationPlanSha256();
  const template = createPrivateInstrumentEvaluationReviewTemplate(plan, planSha256);
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
        sources: template.sources.length,
        labelsPerSource: INSTRUMENT_REVIEW_OPTIONS.length,
        next: 'Listen to each complete source, finish every verdict, then run finalize:instrument-review.',
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
    `${error instanceof Error ? error.message : 'private instrument review preparation failed'}\n`
  );
  process.exitCode = 1;
}
