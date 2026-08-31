#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { decodeAnalysisWindows } from '../audio-analysis/decoder.ts';
import { discoveryWindowSampleCounts } from '../audio-analysis/discovery.ts';
import {
  inspectImage,
  loadMapping,
  runComparator,
  trackScores,
} from './eval-yamnet-comparator.mts';

const jobId = process.argv[2];
if (!jobId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
  throw new Error('Usage: npm run inspect:instruments:local -- <completed-job-id>');
}
if (process.argv.length !== 3) {
  throw new Error('Usage: npm run inspect:instruments:local -- <completed-job-id>');
}

const repositoryRoot = resolve(import.meta.dirname, '..');
const base = new URL(process.env.LOCAL_AUTO_BASE_URL || 'http://127.0.0.1:8899');
if (
  base.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(base.hostname.toLowerCase()) ||
  (base.pathname !== '/' && base.pathname !== '') ||
  base.username ||
  base.password ||
  base.search ||
  base.hash
) {
  throw new Error('LOCAL_AUTO_BASE_URL must be a loopback HTTP origin');
}
const image = process.env.LOCAL_INSTRUMENT_IMAGE || 'stem-splitter-yamnet-comparator:local';
if (!/^[A-Za-z0-9_./:@+-]+$/.test(image)) throw new Error('LOCAL_INSTRUMENT_IMAGE is invalid');

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const jobResponse = await fetch(new URL(`/api/jobs/${jobId}`, base), {
  signal: AbortSignal.timeout(10_000),
});
if (!jobResponse.ok) throw new Error(`local job lookup failed with HTTP ${jobResponse.status}`);
const job: unknown = await jobResponse.json();
if (!record(job) || job.status !== 'done' || !Array.isArray(job.stems)) {
  throw new Error('local instrument inspection requires a completed stem job');
}
const candidates = job.stems.filter(
  (stem): stem is { name: string; url: string } =>
    record(stem) && typeof stem.name === 'string' && typeof stem.url === 'string'
);
const stem =
  candidates.find((candidate) => candidate.name === 'other') ??
  candidates.find((candidate) => candidate.name === 'instrumental');
if (!stem) {
  throw new Error('the completed job has no other or instrumental stem to inspect');
}
const stemUrl = new URL(stem.url, base);
if (stemUrl.origin !== base.origin || !stemUrl.pathname.startsWith('/api/files/')) {
  throw new Error('the selected local stem URL is invalid');
}
const stemResponse = await fetch(stemUrl, { signal: AbortSignal.timeout(30_000) });
if (!stemResponse.ok) throw new Error(`local ${stem.name} stem returned HTTP ${stemResponse.status}`);
const declared = Number(stemResponse.headers.get('content-length'));
if (Number.isFinite(declared) && (declared < 1 || declared > 100 * 1024 * 1024)) {
  throw new Error('the local stem exceeds the inspection byte limit');
}
const stemBytes = Buffer.from(await stemResponse.arrayBuffer());
if (stemBytes.length < 1 || stemBytes.length > 100 * 1024 * 1024) {
  throw new Error('the local stem exceeds the inspection byte limit');
}

const vocabulary: unknown = JSON.parse(
  await readFile(resolve(repositoryRoot, 'instrument-discovery/vocabulary.json'), 'utf8')
);
if (!record(vocabulary) || !Array.isArray(vocabulary.instruments)) {
  throw new Error('instrument vocabulary is invalid');
}
const labels = new Map<string, string>();
for (const item of vocabulary.instruments) {
  if (!record(item) || typeof item.id !== 'string' || typeof item.label !== 'string') {
    throw new Error('instrument vocabulary item is invalid');
  }
  labels.set(item.id, item.label);
}
const mapping = loadMapping([...labels.keys()], repositoryRoot);
const execution = inspectImage(image);
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'stem-splitter-local-instruments-'));
try {
  const sourcePath = join(temporaryDirectory, `${stem.name}.mp3`);
  await writeFile(sourcePath, stemBytes, { mode: 0o600, flag: 'wx' });
  const decoded = await decodeAnalysisWindows(sourcePath, {
    timeoutMs: 60_000,
    maxSourceDurationSeconds: 15 * 60,
  });
  const windowCounts = discoveryWindowSampleCounts(decoded);
  const pcm = Buffer.from(
    decoded.samples.buffer,
    decoded.samples.byteOffset,
    decoded.samples.byteLength
  );
  const result = runComparator(execution, `${jobId}-${stem.name}`, pcm, windowCounts, mapping.supportedIds);
  const scores = trackScores(result, mapping.supportedIds);
  const ranked = Object.entries(scores)
    .sort(([leftId, leftScore], [rightId, rightScore]) =>
      rightScore - leftScore || leftId.localeCompare(rightId)
    )
    .slice(0, 12)
    .map(([id, score], index) => ({
      rank: index + 1,
      id,
      label: labels.get(id),
      score,
      windowScores: result.windows.map((window) => window.metrics[id].top3Mean),
    }));
  console.log(
    JSON.stringify(
      {
        status: 'comparison-only-no-threshold',
        promotionEligible: false,
        caveat:
          'Ranked YAMNet evidence from a separated stem; not calibrated detections and never separation routing.',
        jobId,
        inspectedStem: stem.name,
        sourceBytes: stemBytes.length,
        sourceDurationSeconds: Number(decoded.sourceDurationSeconds.toFixed(3)),
        analyzedSeconds: Number(decoded.analyzedSeconds.toFixed(3)),
        windowsAnalyzed: result.windows.length,
        candidate: {
          classifierVersion: mapping.classifierVersion,
          modelSha256: mapping.modelSha256,
          platform: execution.platform,
          imageId: execution.id,
        },
        timing: {
          loadMs: result.loadMs,
          inferenceMs: result.windows.reduce((sum, window) => sum + window.inferenceMs, 0),
          totalMs: result.timingMs,
        },
        ranked,
      },
      null,
      2
    )
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
