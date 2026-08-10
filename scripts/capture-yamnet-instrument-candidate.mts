#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { captureYamnetInstrumentCandidate } from './lib/yamnet-candidate-capture.mts';

function parseArguments(args: string[]): { sourceReport: string; output: string } {
  const values = new Map<string, string>();
  const supported = new Set(['--source-report', '--output']);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!supported.has(name) || !value || value.startsWith('--') || values.has(name)) {
      throw new Error(`invalid YAMNet candidate-capture argument: ${name ?? '(missing)'}`);
    }
    values.set(name, value);
  }
  if (values.size !== supported.size) {
    throw new Error(
      'usage: capture-yamnet-instrument-candidate --source-report <relative.json> --output <candidate.json>'
    );
  }
  return {
    sourceReport: values.get('--source-report')!,
    output: values.get('--output')!,
  };
}

function main(): void {
  const args = parseArguments(process.argv.slice(2));
  const candidate = captureYamnetInstrumentCandidate(
    args.sourceReport,
    new Date().toISOString()
  );
  writeFileSync(resolve(args.output), `${JSON.stringify(candidate, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'captured-abstained-no-threshold',
        outputPath: resolve(args.output),
        classifierVersion: candidate.candidate.classifierVersion,
        sources: candidate.sources.length,
        detections: 0,
        promotionEligible: false,
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
    `${error instanceof Error ? error.message : 'YAMNet candidate capture failed'}\n`
  );
  process.exitCode = 1;
}
