#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

const rawArguments = process.argv.slice(2);
const waitForStems = rawArguments.includes('--wait-for-stems');
const paths = rawArguments.filter((argument) => argument !== '--wait-for-stems');
if (paths.length > 1 || rawArguments.some((argument) => argument.startsWith('--') && argument !== '--wait-for-stems')) {
  throw new Error('Usage: npm run smoke:auto:local -- [audio-file] [--wait-for-stems]');
}

const audioPath = resolve(paths[0] || 'tests/fixtures/audio/source.wav');
const base = (process.env.LOCAL_AUTO_BASE_URL || 'http://127.0.0.1:8899').replace(/\/+$/, '');
const classCode = process.env.LOCAL_AUTO_CLASS_CODE || 'stem-local';
const expectDiscovery = process.env.LOCAL_AUTO_EXPECT_DISCOVERY !== 'false';
const timeoutMs = Number(process.env.LOCAL_AUTO_STEM_TIMEOUT_MS || 20 * 60 * 1000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 60 * 60 * 1000) {
  throw new Error('LOCAL_AUTO_STEM_TIMEOUT_MS must be between 30000 and 3600000');
}

const contentTypes = new Map([
  ['.aif', 'audio/aiff'],
  ['.aiff', 'audio/aiff'],
  ['.flac', 'audio/flac'],
  ['.m4a', 'audio/mp4'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.wav', 'audio/wav'],
]);

async function jsonResponse(response, context) {
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error(`${context} returned a non-JSON response (${response.status})`);
  }
  if (!response.ok) {
    const message = value && typeof value.error === 'string' ? value.error : `HTTP ${response.status}`;
    throw new Error(`${context} failed: ${message}`);
  }
  return value;
}

function requireRecord(value, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} is missing`);
  }
  return value;
}

const metadata = await stat(audioPath);
if (!metadata.isFile() || metadata.size < 1 || metadata.size > 100 * 1024 * 1024) {
  throw new Error('The local Auto smoke input must be a non-empty regular file at most 100 MiB');
}
const extension = extname(audioPath).toLowerCase();
const contentType = contentTypes.get(extension);
if (!contentType) throw new Error(`Unsupported local Auto smoke extension: ${extension || '(none)'}`);
const filename = basename(audioPath);
const audio = await readFile(audioPath);

const upload = requireRecord(
  await jsonResponse(
    await fetch(`${base}/api/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-class-code': classCode },
      body: JSON.stringify({ filename }),
    }),
    'upload allocation'
  ),
  'upload allocation'
);
if (typeof upload.key !== 'string' || typeof upload.uploadUrl !== 'string') {
  throw new Error('upload allocation contract is invalid');
}
const uploadResponse = await fetch(new URL(upload.uploadUrl, base), {
  method: 'PUT',
  headers: { 'content-type': contentType, 'x-class-code': classCode },
  body: audio,
});
if (!uploadResponse.ok) throw new Error(`audio upload failed with HTTP ${uploadResponse.status}`);

const job = requireRecord(
  await jsonResponse(
    await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-class-code': classCode },
      body: JSON.stringify({
        key: upload.key,
        filename,
        model: 'auto',
        routingRequest: 'auto',
      }),
    }),
    'Auto job creation'
  ),
  'Auto job creation'
);
const route = requireRecord(job.autoRouting, 'authoritative Auto route');
const analysis = requireRecord(route.analysis, 'authoritative Auto analysis');
const roleClassifier = requireRecord(analysis.roleClassifier, 'Auto role classifier');
const degraded = requireRecord(analysis.degraded, 'Auto degraded state');
if (
  job.routingRequest !== 'auto' ||
  route.mode !== 'authoritative' ||
  route.applied !== true ||
  roleClassifier.version !== 'autosplit-role-v4' ||
  degraded.active !== false ||
  typeof route.resolvedCoreModel !== 'string'
) {
  throw new Error('authoritative Auto did not return a valid applied route');
}
const discovery = analysis.instrumentDiscovery;
if (
  expectDiscovery &&
  (!discovery ||
    typeof discovery !== 'object' ||
    discovery.status !== 'complete' ||
    !Number.isSafeInteger(discovery.windowsAnalyzed) ||
    discovery.windowsAnalyzed < 1)
) {
  throw new Error('instrument discovery did not complete through the analyzer');
}

console.log(
  JSON.stringify({
    status: 'analysis-passed',
    jobId: job.id,
    source: filename,
    bytes: metadata.size,
    roleClassifier: roleClassifier.version,
    resolvedCoreModel: route.resolvedCoreModel,
    discovery: expectDiscovery
      ? { status: discovery.status, windowsAnalyzed: discovery.windowsAnalyzed }
      : { status: 'not-requested' },
  })
);

if (!waitForStems) process.exit(0);
if (typeof job.id !== 'string') throw new Error('Auto job id is invalid');
const started = Date.now();
let current = job;
while (current.status !== 'done' && current.status !== 'failed') {
  if (Date.now() - started >= timeoutMs) throw new Error('local Auto stem job timed out');
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  current = requireRecord(
    await jsonResponse(await fetch(`${base}/api/jobs/${encodeURIComponent(job.id)}`), 'job poll'),
    'job poll'
  );
}
if (current.status === 'failed') throw new Error(`local separation failed: ${current.error || 'unknown error'}`);
if (!Array.isArray(current.stems) || current.stems.length !== current.expectedStems?.length) {
  throw new Error('completed local separation returned the wrong stem count');
}
const stemNames = [];
for (const stem of current.stems) {
  if (!stem || typeof stem.name !== 'string' || typeof stem.url !== 'string') {
    throw new Error('completed local separation returned an invalid stem');
  }
  const response = await fetch(new URL(stem.url, base));
  if (!response.ok || (await response.arrayBuffer()).byteLength < 1024) {
    throw new Error(`local stem ${stem.name} is unavailable`);
  }
  stemNames.push(stem.name);
}
console.log(
  JSON.stringify({
    status: 'stems-passed',
    jobId: job.id,
    resolvedCoreModel: route.resolvedCoreModel,
    stems: stemNames.sort(),
  })
);
