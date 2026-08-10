#!/usr/bin/env node

import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  AUDIO_PIPELINE_LISTENING_ATTESTATION,
  createPendingAudioPipelineListeningReview,
} from './lib/audio-pipeline-listening-evidence.mts';
import {
  RAILWAY_ROLLBACK_BASELINE_PATH,
  RAILWAY_ROLLBACK_BASELINE_SOURCE_PATH,
  loadRailwayRollbackBaselineEvidence,
} from './lib/railway-baseline-evidence.mts';
import { downloadRailwayBaselineStems } from './lib/railway-baseline.mjs';

let outputArgument = 'output/v3.2-railway-baseline-listening';
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument !== '--output') throw new Error(`Unknown argument: ${argument}`);
  const value = process.argv[++index];
  if (!value) throw new Error('--output requires a path');
  outputArgument = value;
}

const repositoryRoot = process.cwd();
const allowedRoot = resolve(repositoryRoot, 'output');
const outputDirectory = resolve(repositoryRoot, outputArgument);
const outputRelative = relative(allowedRoot, outputDirectory);
if (
  outputDirectory === allowedRoot ||
  outputRelative.startsWith(`..${sep}`) ||
  outputRelative === '..' ||
  isAbsolute(outputRelative) ||
  outputRelative.includes(sep)
) {
  throw new Error('listening bundle output must be a child of the repository output directory');
}
if (!/^[A-Za-z0-9._/-]+$/.test(outputArgument) || basename(outputDirectory).startsWith('.')) {
  throw new Error('listening bundle output path is invalid');
}

try {
  const outputRootStat = await lstat(allowedRoot);
  if (!outputRootStat.isDirectory() || outputRootStat.isSymbolicLink()) {
    throw new Error('repository output path must be a real directory');
  }
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  await mkdir(allowedRoot, { recursive: false, mode: 0o700 });
}

const baseline = loadRailwayRollbackBaselineEvidence(repositoryRoot);
const rawBaseline = JSON.parse(
  await readFile(resolve(repositoryRoot, RAILWAY_ROLLBACK_BASELINE_PATH), 'utf8')
) as unknown;
const sourcePath = resolve(repositoryRoot, RAILWAY_ROLLBACK_BASELINE_SOURCE_PATH);
let sourceBytes: Buffer;
try {
  sourceBytes = await readFile(sourcePath);
} catch {
  throw new Error('hydrate the authorized baseline source before creating a listening bundle');
}
if (!baseline.sourceBytesVerified || sourceBytes.byteLength !== baseline.sourceBytes) {
  throw new Error('authorized baseline source bytes are not verified');
}

const downloaded = await downloadRailwayBaselineStems({ baseline: rawBaseline });
const temporaryDirectory = await mkdtemp(join(allowedRoot, '.v3.2-listening-'));

try {
  const sourceFilename = '00-original.mp3';
  await writeFile(join(temporaryDirectory, sourceFilename), sourceBytes, {
    mode: 0o600,
    flag: 'wx',
  });
  const files: Array<{ name: string; file: string; bytes: number; sha256: string }> = [];
  for (let index = 0; index < downloaded.stems.length; index += 1) {
    const stem = downloaded.stems[index];
    const file = `${String(index + 1).padStart(2, '0')}-${stem.name}.mp3`;
    await writeFile(join(temporaryDirectory, file), stem.audio, { mode: 0o600, flag: 'wx' });
    files.push({ name: stem.name, file, bytes: stem.bytes, sha256: stem.sha256 });
  }

  const pending = createPendingAudioPipelineListeningReview(baseline);
  await writeFile(
    join(temporaryDirectory, 'review.json'),
    `${JSON.stringify(pending, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' }
  );
  const rows = files
    .map((stem) => `| ${stem.name} | [${stem.file}](./${stem.file}) | \`${stem.sha256}\` |`)
    .join('\n');
  const guide = `# v3.2 frozen Railway baseline listening review

This private, gitignored bundle contains the authorized source and the exact
four outputs recorded in \`${RAILWAY_ROLLBACK_BASELINE_PATH}\`. The exporter
re-read the existing Railway job and rejected any contract, URL, byte-count,
SHA-256, or MPEG-frame drift. It did not create a job or call a model provider.

Listen to [${sourceFilename}](./${sourceFilename}) in full, then listen to every
stem in full.

| Stem | Audio | Frozen SHA-256 |
|---|---|---|
${rows}

Review each item before editing \`review.json\`:

- the complete source was reviewed;
- every stem was reviewed in full;
- no stem is corrupt, truncated, or unexpectedly silent;
- vocals, drums, bass, and other are each usable for the stated classroom split;
- the complete result is acceptable for classroom use.

If and only if every check passes, enter the reviewer name, role, UTC timestamp,
\`accepted\` decision and stem verdicts, set every check to \`true\`, and copy
this exact attestation into the final field:

> ${AUDIO_PIPELINE_LISTENING_ATTESTATION}

Then validate the private draft without moving it into Git:

\`bun run check:audio-listening -- --review ${join(outputArgument, 'review.json')}\`

An accepted review still requires a separate reviewed commit that moves the
record to the canonical acceptance path and changes the promotion manifest.
`;
  await writeFile(join(temporaryDirectory, 'REVIEW.md'), guide, {
    mode: 0o600,
    flag: 'wx',
  });

  await mkdir(dirname(outputDirectory), { recursive: true, mode: 0o700 });
  await rename(temporaryDirectory, outputDirectory);
  process.stdout.write(
    `${JSON.stringify(
      {
        schema: 'stem-splitter.audio-pipeline-listening-bundle.v1',
        outputDirectory,
        source: {
          file: resolve(outputDirectory, sourceFilename),
          bytes: sourceBytes.byteLength,
          sha256: baseline.sourceSha256,
        },
        stems: files.map((stem) => ({ ...stem, file: resolve(outputDirectory, stem.file) })),
        review: resolve(outputDirectory, 'review.json'),
        guide: resolve(outputDirectory, 'REVIEW.md'),
        providerCalls: 0,
        jobsCreated: 0,
      },
      null,
      2
    )}\n`
  );
} catch (error) {
  await rm(temporaryDirectory, { recursive: true, force: true });
  throw error;
}
