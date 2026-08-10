#!/usr/bin/env node

import { lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

import { createYamnetCandidateSourceReport } from './lib/yamnet-candidate-capture.mts';

function parseArguments(args: string[]): {
  corpusReport: string;
  controlReport: string;
  output: string;
} {
  const values = new Map<string, string>();
  const supported = new Set(['--corpus-report', '--control-report', '--output']);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!supported.has(name) || !value || value.startsWith('--') || values.has(name)) {
      throw new Error(`invalid YAMNet candidate-source argument: ${name ?? '(missing)'}`);
    }
    values.set(name, value);
  }
  if (values.size !== supported.size) {
    throw new Error(
      'usage: prepare-yamnet-candidate-source --corpus-report <relative.json> --control-report <relative.json> --output <relative.json>'
    );
  }
  return {
    corpusReport: values.get('--corpus-report')!,
    controlReport: values.get('--control-report')!,
    output: values.get('--output')!,
  };
}

function repositoryOutputPath(value: string): string {
  if (
    isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('YAMNet candidate source output must be a repository-relative path');
  }
  const root = realpathSync(process.cwd());
  const output = resolve(root, value);
  const parent = dirname(output);
  const metadata = lstatSync(parent);
  if (
    !output.startsWith(`${root}${sep}`) ||
    !metadata.isDirectory() ||
    realpathSync(parent) !== parent
  ) {
    throw new Error('YAMNet candidate source output parent is unsafe');
  }
  return output;
}

function main(): void {
  const args = parseArguments(process.argv.slice(2));
  const report = createYamnetCandidateSourceReport(
    args.corpusReport,
    args.controlReport,
    new Date().toISOString()
  );
  const outputPath = repositoryOutputPath(args.output);
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'native-reports-bound-no-candidate-selection',
        outputPath,
        corpusSchema: report.corpusReport.schema,
        controlSchema: report.controlReport.schema,
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
    `${error instanceof Error ? error.message : 'YAMNet candidate-source preparation failed'}\n`
  );
  process.exitCode = 1;
}
