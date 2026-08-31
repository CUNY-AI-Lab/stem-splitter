#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  createReadStream,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, dirname, extname, resolve, sep } from 'node:path';

import { INSTRUMENT_REVIEW_OPTIONS } from '../src/analysis/instrument-review.ts';
import {
  INSTRUMENT_EVALUATION_REVIEW_ATTESTATION,
  instrumentEvaluationPlanSha256,
  loadInstrumentEvaluationPlan,
  type InstrumentEvaluationPlanV1,
} from './lib/instrument-evaluation.mts';
import {
  validatePrivateInstrumentEvaluationReviewDraft,
  type PrivateInstrumentEvaluationReviewV1,
} from './lib/instrument-evaluation-review.mts';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8898;
const DEFAULT_REVIEW_PATH = 'output/v3.2-instrument-evaluation-review.private.json';
const MAX_PRIVATE_REVIEW_BYTES = 2 * 1024 * 1024;
const UI_ROOT = resolve(dirname(new URL(import.meta.url).pathname), 'instrument-review-ui');
const CORPUS_PATH = 'tests/corpus/corpus.json';
const CONTROL_PATH = 'tests/corpus/instrument-control-manifest.json';

const FRIENDLY_SOURCE_LABELS = new Map([
  ['folk-duet', 'Folk duet'],
  ['orchestral', 'Orchestral'],
  ['shoegaze', 'Shoegaze'],
  ['piano-strings', 'Piano and strings'],
  ['jazz-sax', 'Jazz saxophone'],
  ['hip-hop', 'Hip-hop'],
  ['bluegrass', 'Bluegrass'],
  ['synthwave', 'Synthwave'],
  ['electronic-stiff-hand', 'Electronic — Stiff Hand'],
  ['electronic-back-counting', 'Electronic — Back Counting'],
  ['electronic-house', 'Electronic — Das Dope'],
]);

interface ReviewSource {
  index: number;
  partitionId: string;
  id: string;
  label: string;
  kindLabel: 'Classroom mix' | 'Isolated wind';
  sourceSha256: string;
  path: string;
  bytes: number;
  contentType: string;
}

interface CorpusDocument {
  sources: Array<{
    slug: string;
    kind: string;
    source: string;
    provenance?: { contentSha256?: string };
  }>;
}

interface ControlDocument {
  downloadPolicy: { outputDirectory: string };
  controls: Array<{
    id: string;
    instrument: string;
    localFile: string;
    media: { bytes: number; sha256: string };
  }>;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function titleCase(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function safeRepositoryFile(
  root: string,
  relativePath: string,
  allowedRoot: string,
  expectedSha256: string
): { path: string; bytes: number } {
  const expectedRoot = resolve(root, allowedRoot);
  const path = resolve(root, relativePath);
  if (!path.startsWith(`${expectedRoot}${sep}`)) {
    throw new Error(`review audio is outside ${allowedRoot}`);
  }
  const rootMetadata = lstatSync(expectedRoot);
  const metadata = lstatSync(path);
  if (
    rootMetadata.isSymbolicLink() ||
    !rootMetadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    realpathSync(expectedRoot) !== expectedRoot ||
    realpathSync(path) !== path
  ) {
    throw new Error(`review audio is not a pinned regular file: ${relativePath}`);
  }
  if (sha256File(path) !== expectedSha256) {
    throw new Error(`review audio hash drifted: ${relativePath}`);
  }
  return { path, bytes: metadata.size };
}

function loadReviewSources(root: string, plan: InstrumentEvaluationPlanV1): ReviewSource[] {
  const corpus = JSON.parse(readFileSync(resolve(root, CORPUS_PATH), 'utf8')) as CorpusDocument;
  const controls = JSON.parse(readFileSync(resolve(root, CONTROL_PATH), 'utf8')) as ControlDocument;
  if (!Array.isArray(corpus.sources) || !Array.isArray(controls.controls)) {
    throw new Error('instrument review source manifests are invalid');
  }
  return plan.partitions.flatMap((partition) =>
    partition.sources.map((source) => {
      const index = plan.partitions
        .flatMap((candidate) => candidate.sources)
        .findIndex((candidate) => candidate.id === source.id);
      if (index < 0) throw new Error(`instrument review source is not ordered: ${source.id}`);
      if (partition.corpusKind === 'real-mix') {
        const corpusSource = corpus.sources.find(
          (candidate) => candidate.slug === source.id && candidate.kind === 'file'
        );
        if (
          !corpusSource ||
          !corpusSource.source ||
          corpusSource.provenance?.contentSha256 !== source.sourceSha256
        ) {
          throw new Error(`instrument review corpus source is not pinned: ${source.id}`);
        }
        const approved = safeRepositoryFile(
          root,
          corpusSource.source,
          'tests/corpus/audio',
          source.sourceSha256
        );
        return {
          index,
          partitionId: partition.id,
          id: source.id,
          label: FRIENDLY_SOURCE_LABELS.get(source.id) ?? titleCase(source.id),
          kindLabel: 'Classroom mix' as const,
          sourceSha256: source.sourceSha256,
          path: approved.path,
          bytes: approved.bytes,
          contentType: 'audio/mpeg',
        };
      }
      if (partition.corpusKind !== 'isolated-control') {
        throw new Error(`unsupported instrument review corpus kind: ${partition.corpusKind}`);
      }
      const control = controls.controls.find((candidate) => candidate.id === source.id);
      if (!control || control.media.sha256 !== source.sourceSha256) {
        throw new Error(`instrument review control is not pinned: ${source.id}`);
      }
      const relativePath = `${controls.downloadPolicy.outputDirectory}/${control.localFile}`;
      const approved = safeRepositoryFile(
        root,
        relativePath,
        controls.downloadPolicy.outputDirectory,
        source.sourceSha256
      );
      if (approved.bytes !== control.media.bytes) {
        throw new Error(`instrument review control size drifted: ${source.id}`);
      }
      return {
        index,
        partitionId: partition.id,
        id: source.id,
        label: titleCase(control.instrument),
        kindLabel: 'Isolated wind' as const,
        sourceSha256: source.sourceSha256,
        path: approved.path,
        bytes: approved.bytes,
        contentType: extname(control.localFile).toLowerCase() === '.m4a' ? 'audio/mp4' : 'audio/mpeg',
      };
    })
  );
}

function inspectPrivateReviewPath(root: string, requestedPath: string): string {
  const outputRoot = resolve(root, 'output');
  const path = resolve(root, requestedPath);
  if (!path.startsWith(`${outputRoot}${sep}`)) {
    throw new Error('private instrument review must remain under the repository output directory');
  }
  const outputMetadata = lstatSync(outputRoot);
  const metadata = lstatSync(path);
  if (
    outputMetadata.isSymbolicLink() ||
    !outputMetadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size > MAX_PRIVATE_REVIEW_BYTES ||
    realpathSync(outputRoot) !== outputRoot ||
    realpathSync(path) !== path
  ) {
    throw new Error('private instrument review must be a bounded owner-only regular file');
  }
  return path;
}

function readDraft(
  path: string,
  plan: InstrumentEvaluationPlanV1,
  planSha256: string
): PrivateInstrumentEvaluationReviewV1 {
  const serialized = readFileSync(path, 'utf8');
  if (Buffer.byteLength(serialized) > MAX_PRIVATE_REVIEW_BYTES) {
    throw new Error('private instrument review exceeds the 2 MiB safety limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('private instrument review is not valid JSON');
  }
  return validatePrivateInstrumentEvaluationReviewDraft(value, plan, planSha256);
}

function writeDraft(path: string, value: PrivateInstrumentEvaluationReviewV1): void {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile() || (before.mode & 0o077) !== 0) {
    throw new Error('private instrument review changed before save');
  }
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_PRIVATE_REVIEW_BYTES) {
    throw new Error('private instrument review exceeds the 2 MiB safety limit');
  }
  const temporaryPath = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.partial`);
  try {
    writeFileSync(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const after = lstatSync(path);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      (after.mode & 0o077) !== 0 ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new Error('private instrument review changed during save');
    }
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function progress(review: PrivateInstrumentEvaluationReviewV1) {
  const completedSources = review.sources.filter(
    (source) =>
      source.wholeSourceListened &&
      source.verdicts.every(({ verdict }) => verdict !== 'unreviewed')
  ).length;
  const reviewedLabels = review.sources.reduce(
    (total, source) =>
      total + source.verdicts.filter(({ verdict }) => verdict !== 'unreviewed').length,
    0
  );
  return {
    completedSources,
    totalSources: review.sources.length,
    reviewedLabels,
    totalLabels: review.sources.reduce((total, source) => total + source.verdicts.length, 0),
    readyToFinish: completedSources === review.sources.length,
    finalizedDraft:
      Boolean(review.reviewer) && Boolean(review.reviewedAt) && Boolean(review.attestation),
  };
}

function sendSecurityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "media-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '));
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  sendSecurityHeaders(response);
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendAsset(
  response: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  sessionCookie?: { name: string; value: string }
): void {
  sendSecurityHeaders(response);
  if (sessionCookie) {
    response.setHeader(
      'Set-Cookie',
      `${sessionCookie.name}=${sessionCookie.value}; HttpOnly; SameSite=Strict; Path=/`
    );
  }
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.byteLength,
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new Error('review saves require application/json');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_PRIVATE_REVIEW_BYTES) throw new Error('review save exceeds 2 MiB');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('review save is not valid JSON');
  }
}

function sessionIsValid(request: IncomingMessage, cookieName: string, session: string): boolean {
  return String(request.headers.cookie ?? '')
    .split(';')
    .map((value) => value.trim())
    .includes(`${cookieName}=${session}`);
}

function serveAudio(
  request: IncomingMessage,
  response: ServerResponse,
  source: ReviewSource
): void {
  if (sha256File(source.path) !== source.sourceSha256) {
    sendJson(response, 409, { error: 'The pinned audio changed. Review stopped.' });
    return;
  }
  const range = String(request.headers.range ?? '');
  let start = 0;
  let end = source.bytes - 1;
  let status = 200;
  if (range) {
    const match = /^bytes=([0-9]+)-([0-9]*)$/.exec(range);
    if (!match) {
      response.writeHead(416, { 'Content-Range': `bytes */${source.bytes}` });
      response.end();
      return;
    }
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= source.bytes) {
      response.writeHead(416, { 'Content-Range': `bytes */${source.bytes}` });
      response.end();
      return;
    }
    status = 206;
  }
  sendSecurityHeaders(response);
  const headers: Record<string, string | number> = {
    'Accept-Ranges': 'bytes',
    'Content-Type': source.contentType,
    'Content-Length': end - start + 1,
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${source.bytes}`;
  response.writeHead(status, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(source.path, { start, end }).pipe(response);
}

function parseArguments(args: string[]): { reviewPath: string; port: number } {
  let reviewPath = DEFAULT_REVIEW_PATH;
  let port = DEFAULT_PORT;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== '--input' && argument !== '--port') {
      throw new Error(`unknown instrument-review server argument: ${argument}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    if (argument === '--input') reviewPath = value;
    else {
      port = Number(value);
      if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
        throw new Error('instrument-review server port must be between 1024 and 65535');
      }
    }
    index += 1;
  }
  return { reviewPath, port };
}

export function startInstrumentReviewServer(
  root = process.cwd(),
  args = process.argv.slice(2)
) {
  const { reviewPath: requestedReviewPath, port } = parseArguments(args);
  const repositoryRoot = realpathSync(root);
  const plan = loadInstrumentEvaluationPlan(repositoryRoot);
  const planSha256 = instrumentEvaluationPlanSha256(repositoryRoot);
  const reviewPath = inspectPrivateReviewPath(repositoryRoot, requestedReviewPath);
  readDraft(reviewPath, plan, planSha256);
  const sources = loadReviewSources(repositoryRoot, plan).sort((left, right) => left.index - right.index);
  if (sources.length !== plan.partitions.reduce((total, partition) => total + partition.sources.length, 0)) {
    throw new Error('instrument review source coverage is incomplete');
  }
  const session = randomBytes(32).toString('hex');
  const sessionCookieName = `instrument_review_${port}`;
  const expectedHost = `${HOST}:${port}`;
  const origin = `http://${expectedHost}`;
  const assets = {
    html: readFileSync(resolve(UI_ROOT, 'index.html')),
    css: readFileSync(resolve(UI_ROOT, 'app.css')),
    js: readFileSync(resolve(UI_ROOT, 'app.js')),
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== expectedHost) {
        sendJson(response, 400, { error: 'Invalid local review host.' });
        return;
      }
      const url = new URL(request.url ?? '/', origin);
      if (request.method === 'GET' && url.pathname === '/') {
        sendAsset(response, 200, assets.html, 'text/html; charset=utf-8', {
          name: sessionCookieName,
          value: session,
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/favicon.ico') {
        response.writeHead(204, { 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      if (!sessionIsValid(request, sessionCookieName, session)) {
        sendJson(response, 403, { error: 'Reload the private review page.' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/app.css') {
        sendAsset(response, 200, assets.css, 'text/css; charset=utf-8');
        return;
      }
      if (request.method === 'GET' && url.pathname === '/app.js') {
        sendAsset(response, 200, assets.js, 'text/javascript; charset=utf-8');
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const review = readDraft(reviewPath, plan, planSha256);
        sendJson(response, 200, {
          review,
          sources: sources.map(({ index, id, label, kindLabel }) => ({
            index,
            id,
            label,
            kindLabel,
            audioUrl: `/audio/${index}`,
          })),
          options: INSTRUMENT_REVIEW_OPTIONS,
          attestation: INSTRUMENT_EVALUATION_REVIEW_ATTESTATION,
          progress: progress(review),
        });
        return;
      }
      const audioMatch = /^\/audio\/([0-9]+)$/.exec(url.pathname);
      if ((request.method === 'GET' || request.method === 'HEAD') && audioMatch) {
        const source = sources[Number(audioMatch[1])];
        if (!source) {
          sendJson(response, 404, { error: 'Recording not found.' });
          return;
        }
        serveAudio(request, response, source);
        return;
      }
      if (request.method === 'PUT' && url.pathname === '/api/review') {
        if (request.headers.origin !== origin) {
          sendJson(response, 403, { error: 'Review saves are local to this page.' });
          return;
        }
        const value = await readJsonBody(request);
        const review = validatePrivateInstrumentEvaluationReviewDraft(value, plan, planSha256);
        writeDraft(reviewPath, review);
        sendJson(response, 200, { saved: true, progress: progress(review) });
        return;
      }
      sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : 'Private review request failed.',
      });
    }
  });
  server.listen(port, HOST, () => {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'private-local-review-ready',
          url: origin,
          reviewPath,
          sources: sources.length,
          publicApplicationChanged: false,
        },
        null,
        2
      )}\n`
    );
  });
  return { server, origin, reviewPath, sources: sources.length };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    startInstrumentReviewServer();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'private instrument review server failed'}\n`
    );
    process.exitCode = 1;
  }
}
