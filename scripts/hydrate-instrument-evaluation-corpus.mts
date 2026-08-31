#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const INSTRUMENT_EVALUATION_HYDRATION_MANIFEST_PATH =
  'tests/corpus/instrument-evaluation-corpus-hydration.json';
export const INSTRUMENT_EVALUATION_HYDRATION_SCHEMA =
  'stem-splitter.instrument-evaluation-corpus-hydration.v1';
export const INSTRUMENT_EVALUATION_HYDRATION_VERSION =
  'internet-archive-classroom-mixes-v1';
export const INSTRUMENT_EVALUATION_HYDRATION_MANIFEST_SHA256 =
  'b69f18e4e13965c750f32fd5b451f31eb5b7ef3b125ce9c165c3e4e882c87077';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_PATH = 'tests/corpus/corpus.json';
const EXPECTED_SLUGS = [
  'folk-duet',
  'orchestral',
  'shoegaze',
  'piano-strings',
  'jazz-sax',
  'hip-hop',
  'bluegrass',
  'synthwave',
  'electronic-stiff-hand',
  'electronic-back-counting',
  'electronic-house',
] as const;
const EXPECTED_ARCHIVE_FILES: Record<(typeof EXPECTED_SLUGS)[number], string> = {
  'folk-duet': '01-Shine.mp3',
  orchestral: "09 Mozart- Symphony #41 In C, K 551, 'Jupiter' - 1. Allegro Vivace.mp3",
  shoegaze: 'EUPHORIA.mp3',
  'piano-strings': 'Finn Anderson - Uncharted Lands EP - 01 Uncharted Lands.mp3',
  'jazz-sax': 'jsjq2010-07-30s1t02.mp3',
  'hip-hop': 'Drip Drop.mp3',
  bluegrass: 'High On a Mountain a.mp3',
  synthwave: 'catboi-album1.mp3',
  'electronic-stiff-hand': 'catboi-album2.mp3',
  'electronic-back-counting': 'catboi-album3.mp3',
  'electronic-house': "Clockin' Cats - Das Dope (Ding Dong).mp3",
};
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_LOCAL_FILE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.mp3$/;
const MD5 = /^[a-f0-9]{32}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

type JsonRecord = Record<string, unknown>;
type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface InstrumentEvaluationHydrationSource {
  slug: string;
  archiveIdentifier: string;
  archiveFile: string;
  localFile: string;
  licenseUrl: string;
  media: {
    bytes: number;
    md5: string;
    sha1: string;
    sha256: string;
  };
}

export interface InstrumentEvaluationHydrationManifest {
  $schema: typeof INSTRUMENT_EVALUATION_HYDRATION_SCHEMA;
  version: typeof INSTRUMENT_EVALUATION_HYDRATION_VERSION;
  corpusPath: typeof CORPUS_PATH;
  downloadPolicy: {
    metadataOrigin: 'https://archive.org';
    downloadOrigin: 'https://archive.org';
    metadataPathPrefix: '/metadata/';
    downloadPathPrefix: '/download/';
    redirectStatus: 302;
    redirectHostSuffix: '.archive.org';
    maximumRedirects: 1;
    maximumMetadataBytes: number;
    maximumBytesPerFile: number;
    maximumTotalBytes: number;
    requestTimeoutMs: number;
    contentType: 'audio/mpeg';
    outputDirectory: 'tests/corpus/audio';
  };
  sources: InstrumentEvaluationHydrationSource[];
}

export interface InstrumentEvaluationHydrationRecord {
  slug: string;
  state: 'downloaded' | 'verified';
  bytes: number;
  md5: string;
  sha1: string;
  sha256: string;
  path: string;
}

interface CorpusDocument {
  sources: Array<{
    slug: string;
    kind: string;
    source: string;
    provenance?: {
      archiveIdentifier?: string;
      archiveFile?: string;
      sha1?: string;
      licenseUrl?: string;
      contentSha256?: string;
    };
  }>;
}

export interface HydrateInstrumentEvaluationCorpusOptions {
  repositoryRoot?: string;
  manifest?: InstrumentEvaluationHydrationManifest;
  slugs?: string[];
  verifyOnly?: boolean;
  fetchImplementation?: FetchImplementation;
}

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sorted)) {
    throw new Error(`${context} does not match the pinned schema`);
  }
}

function safeInteger(value: unknown, minimum: number, maximum: number, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${context} is invalid`);
  }
  return value as number;
}

function safeString(value: unknown, pattern: RegExp, context: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${context} is invalid`);
  return value;
}

function sha256Bytes(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function filesystemErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !Object.hasOwn(error, 'code')) return undefined;
  return typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function sourceFileName(value: unknown, context: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 5 ||
    value.length > 180 ||
    !value.toLowerCase().endsWith('.mp3') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value === '.' ||
    value === '..'
  ) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function licenseUrl(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new Error(`${context} is invalid`);
  const parsed = new URL(value);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.hostname !== 'creativecommons.org' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function validatePolicy(value: unknown): InstrumentEvaluationHydrationManifest['downloadPolicy'] {
  if (!record(value)) throw new Error('instrument evaluation hydration policy is invalid');
  exactKeys(
    value,
    [
      'metadataOrigin',
      'downloadOrigin',
      'metadataPathPrefix',
      'downloadPathPrefix',
      'redirectStatus',
      'redirectHostSuffix',
      'maximumRedirects',
      'maximumMetadataBytes',
      'maximumBytesPerFile',
      'maximumTotalBytes',
      'requestTimeoutMs',
      'contentType',
      'outputDirectory',
    ],
    'instrument evaluation hydration policy'
  );
  if (
    value.metadataOrigin !== 'https://archive.org' ||
    value.downloadOrigin !== 'https://archive.org' ||
    value.metadataPathPrefix !== '/metadata/' ||
    value.downloadPathPrefix !== '/download/' ||
    value.redirectStatus !== 302 ||
    value.redirectHostSuffix !== '.archive.org' ||
    value.maximumRedirects !== 1 ||
    value.contentType !== 'audio/mpeg' ||
    value.outputDirectory !== 'tests/corpus/audio'
  ) {
    throw new Error('instrument evaluation hydration policy identity drifted');
  }
  safeInteger(value.maximumMetadataBytes, 1_048_576, 8_388_608, 'maximum metadata bytes');
  safeInteger(value.maximumBytesPerFile, 20_025_268, 25_165_824, 'maximum source bytes');
  safeInteger(value.maximumTotalBytes, 76_560_674, 100_663_296, 'maximum corpus bytes');
  safeInteger(value.requestTimeoutMs, 30_000, 120_000, 'hydration request timeout');
  return value as unknown as InstrumentEvaluationHydrationManifest['downloadPolicy'];
}

export function validateInstrumentEvaluationHydrationManifest(
  value: unknown,
  corpus: CorpusDocument
): InstrumentEvaluationHydrationManifest {
  if (!record(value)) throw new Error('instrument evaluation hydration manifest is invalid');
  exactKeys(value, ['$schema', 'version', 'corpusPath', 'downloadPolicy', 'sources'], 'instrument evaluation hydration manifest');
  if (
    value.$schema !== INSTRUMENT_EVALUATION_HYDRATION_SCHEMA ||
    value.version !== INSTRUMENT_EVALUATION_HYDRATION_VERSION ||
    value.corpusPath !== CORPUS_PATH ||
    !Array.isArray(value.sources) ||
    !Array.isArray(corpus.sources)
  ) {
    throw new Error('instrument evaluation hydration manifest identity drifted');
  }
  const downloadPolicy = validatePolicy(value.downloadPolicy);
  if (value.sources.length !== EXPECTED_SLUGS.length) {
    throw new Error('instrument evaluation hydration source coverage is incomplete');
  }
  const seenArchiveObjects = new Set<string>();
  const seenLocalFiles = new Set<string>();
  const sources = value.sources.map((rawSource, index) => {
    const context = `instrument evaluation hydration source ${index + 1}`;
    if (!record(rawSource)) throw new Error(`${context} is invalid`);
    exactKeys(
      rawSource,
      ['slug', 'archiveIdentifier', 'archiveFile', 'localFile', 'licenseUrl', 'media'],
      context
    );
    const slug = safeString(rawSource.slug, SAFE_SLUG, `${context} slug`);
    const expectedSlug = EXPECTED_SLUGS[index];
    if (slug !== expectedSlug) throw new Error(`${context} is reordered`);
    const archiveIdentifier = safeString(
      rawSource.archiveIdentifier,
      SAFE_ID,
      `${context} Archive identifier`
    );
    const archiveFile = sourceFileName(rawSource.archiveFile, `${context} Archive file`);
    if (archiveFile !== EXPECTED_ARCHIVE_FILES[expectedSlug]) {
      throw new Error(`${context} Archive file drifted`);
    }
    const localFile = safeString(rawSource.localFile, SAFE_LOCAL_FILE, `${context} local file`);
    const sourceLicenseUrl = licenseUrl(rawSource.licenseUrl, `${context} license URL`);
    if (!record(rawSource.media)) throw new Error(`${context} media is invalid`);
    exactKeys(rawSource.media, ['bytes', 'md5', 'sha1', 'sha256'], `${context} media`);
    const media = {
      bytes: safeInteger(rawSource.media.bytes, 1, downloadPolicy.maximumBytesPerFile, `${context} bytes`),
      md5: safeString(rawSource.media.md5, MD5, `${context} MD5`),
      sha1: safeString(rawSource.media.sha1, SHA1, `${context} SHA-1`),
      sha256: safeString(rawSource.media.sha256, SHA256, `${context} SHA-256`),
    };
    const archiveObject = `${archiveIdentifier}/${archiveFile}`;
    if (seenArchiveObjects.has(archiveObject) || seenLocalFiles.has(localFile)) {
      throw new Error(`${context} is duplicated`);
    }
    seenArchiveObjects.add(archiveObject);
    seenLocalFiles.add(localFile);

    const corpusSource = corpus.sources.find(
      (candidate) => candidate.kind === 'file' && candidate.slug === slug
    );
    if (
      !corpusSource ||
      corpusSource.source !== `${downloadPolicy.outputDirectory}/${localFile}` ||
      corpusSource.provenance?.archiveIdentifier !== archiveIdentifier ||
      corpusSource.provenance?.licenseUrl !== sourceLicenseUrl ||
      corpusSource.provenance?.contentSha256 !== media.sha256 ||
      (corpusSource.provenance.archiveFile !== undefined &&
        corpusSource.provenance.archiveFile !== archiveFile) ||
      (corpusSource.provenance.sha1 !== undefined &&
        corpusSource.provenance.sha1 !== media.sha1)
    ) {
      throw new Error(`${context} does not match the frozen corpus`);
    }
    return {
      slug,
      archiveIdentifier,
      archiveFile,
      localFile,
      licenseUrl: sourceLicenseUrl,
      media,
    };
  });
  const totalBytes = sources.reduce((total, source) => total + source.media.bytes, 0);
  if (totalBytes !== 76_560_674 || totalBytes > downloadPolicy.maximumTotalBytes) {
    throw new Error('instrument evaluation hydration total bytes drifted');
  }
  return {
    $schema: INSTRUMENT_EVALUATION_HYDRATION_SCHEMA,
    version: INSTRUMENT_EVALUATION_HYDRATION_VERSION,
    corpusPath: CORPUS_PATH,
    downloadPolicy,
    sources,
  };
}

export function loadInstrumentEvaluationHydrationManifest(
  repositoryRoot = REPOSITORY_ROOT
): InstrumentEvaluationHydrationManifest {
  const root = realpathSync(repositoryRoot);
  const manifestBytes = readFileSync(resolve(root, INSTRUMENT_EVALUATION_HYDRATION_MANIFEST_PATH));
  if (sha256Bytes(manifestBytes) !== INSTRUMENT_EVALUATION_HYDRATION_MANIFEST_SHA256) {
    throw new Error('instrument evaluation hydration manifest bytes drifted');
  }
  const corpus = JSON.parse(readFileSync(resolve(root, CORPUS_PATH), 'utf8')) as CorpusDocument;
  return validateInstrumentEvaluationHydrationManifest(
    JSON.parse(manifestBytes.toString('utf8')),
    corpus
  );
}

function ensureOutputDirectory(repositoryRoot: string, relativeDirectory: string): string {
  const root = realpathSync(repositoryRoot);
  const rootMetadata = lstatSync(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error('instrument evaluation repository root is invalid');
  }
  let current = root;
  for (const component of relativeDirectory.split('/')) {
    if (!component || component === '.' || component === '..') {
      throw new Error('instrument evaluation hydration output directory is invalid');
    }
    current = resolve(current, component);
    if (!current.startsWith(`${root}${sep}`)) {
      throw new Error('instrument evaluation hydration output escaped the repository');
    }
    if (!existsSync(current)) {
      mkdirSync(current, { mode: 0o700 });
      continue;
    }
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || realpathSync(current) !== current) {
      throw new Error('instrument evaluation hydration output path is unsafe');
    }
  }
  return current;
}

function sourcePath(outputDirectory: string, source: InstrumentEvaluationHydrationSource): string {
  const path = resolve(outputDirectory, source.localFile);
  if (!path.startsWith(`${outputDirectory}${sep}`)) {
    throw new Error(`${source.slug}: hydration output escaped its directory`);
  }
  return path;
}

function hashFile(path: string, expectedBytes: number) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== expectedBytes) {
    throw new Error('hydrated source is not the pinned regular file');
  }
  const bytes = readFileSync(path);
  return {
    bytes: metadata.size,
    md5: createHash('md5').update(bytes).digest('hex'),
    sha1: createHash('sha1').update(bytes).digest('hex'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function verifyExisting(
  outputDirectory: string,
  source: InstrumentEvaluationHydrationSource
): InstrumentEvaluationHydrationRecord {
  let actual;
  try {
    actual = hashFile(sourcePath(outputDirectory, source), source.media.bytes);
  } catch {
    throw new Error(`${source.slug}: existing corpus source is not the pinned regular file`);
  }
  if (
    actual.md5 !== source.media.md5 ||
    actual.sha1 !== source.media.sha1 ||
    actual.sha256 !== source.media.sha256
  ) {
    throw new Error(`${source.slug}: existing corpus source does not match its content pins`);
  }
  return {
    slug: source.slug,
    state: 'verified',
    ...actual,
    path: source.localFile,
  };
}

function encodedSegment(value: string): string {
  return encodeURIComponent(value).replace(/'/g, '%27');
}

function exactArchiveUrl(origin: string, path: string, context: string): URL {
  const url = new URL(path, origin);
  if (
    url.origin !== origin ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${context} escaped the pinned Archive origin`);
  }
  return url;
}

export function validateInstrumentEvaluationArchiveRedirect(
  location: string,
  source: InstrumentEvaluationHydrationSource,
  manifest: InstrumentEvaluationHydrationManifest
): URL {
  let target: URL;
  try {
    target = new URL(location);
  } catch {
    throw new Error(`${source.slug}: Archive redirect is invalid`);
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(target.pathname);
  } catch {
    throw new Error(`${source.slug}: Archive redirect path is malformed`);
  }
  const pathSegments = decodedPath.split('/');
  if (
    target.protocol !== 'https:' ||
    target.hostname === 'archive.org' ||
    !target.hostname.endsWith(manifest.downloadPolicy.redirectHostSuffix) ||
    target.username ||
    target.password ||
    target.port ||
    target.search ||
    target.hash ||
    pathSegments.length !== 5 ||
    !/^[0-9]+$/.test(pathSegments[1]) ||
    pathSegments[2] !== 'items' ||
    pathSegments[3] !== source.archiveIdentifier ||
    pathSegments[4] !== source.archiveFile
  ) {
    throw new Error(`${source.slug}: Archive redirect escaped the pinned object`);
  }
  return target;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Discarded bodies are not evidence; cancellation failure does not replace the primary result.
  }
}

async function readBoundedJson(response: Response, maximumBytes: number, context: string): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  const contentEncoding = response.headers.get('content-encoding');
  const contentLength = response.headers.get('content-length');
  if (
    contentType !== 'application/json' ||
    (contentEncoding !== null && contentEncoding.toLowerCase() !== 'identity') ||
    (contentLength !== null &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumBytes)) ||
    !response.body
  ) {
    await cancelBody(response);
    throw new Error(`${context} headers are invalid`);
  }
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!item.value?.byteLength) continue;
      received += item.value.byteLength;
      if (received > maximumBytes) throw new Error(`${context} exceeded its byte limit`);
      chunks.push(item.value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // A fully consumed stream commonly rejects cancellation.
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error(`${context} is not valid JSON`);
  }
}

async function verifyArchiveMetadata(
  source: InstrumentEvaluationHydrationSource,
  manifest: InstrumentEvaluationHydrationManifest,
  fetchImplementation: FetchImplementation,
  signal: AbortSignal
): Promise<void> {
  const metadataUrl = exactArchiveUrl(
    manifest.downloadPolicy.metadataOrigin,
    `${manifest.downloadPolicy.metadataPathPrefix}${encodedSegment(source.archiveIdentifier)}`,
    `${source.slug} metadata request`
  );
  const response = await fetchImplementation(metadataUrl, {
    redirect: 'manual',
    signal,
    headers: {
      accept: 'application/json',
      'accept-encoding': 'identity',
      'user-agent': 'stem-splitter-evaluation-hydrator/1',
    },
  });
  if (
    response.status !== 200 ||
    (response.url !== '' && response.url !== metadataUrl.href)
  ) {
    await cancelBody(response);
    throw new Error(`${source.slug}: Archive metadata request was redirected or failed`);
  }
  const value = await readBoundedJson(
    response,
    manifest.downloadPolicy.maximumMetadataBytes,
    `${source.slug} Archive metadata`
  );
  if (!record(value) || !record(value.metadata) || !Array.isArray(value.files)) {
    throw new Error(`${source.slug}: Archive metadata shape is invalid`);
  }
  if (
    value.metadata.identifier !== source.archiveIdentifier ||
    value.metadata.licenseurl !== source.licenseUrl
  ) {
    throw new Error(`${source.slug}: Archive item identity or license drifted`);
  }
  const matches = value.files.filter(
    (candidate) => record(candidate) && candidate.name === source.archiveFile
  );
  if (matches.length !== 1) throw new Error(`${source.slug}: Archive file identity is ambiguous`);
  const file = matches[0] as JsonRecord;
  if (
    String(file.size) !== String(source.media.bytes) ||
    file.md5 !== source.media.md5 ||
    file.sha1 !== source.media.sha1 ||
    file.format !== 'VBR MP3' ||
    !['original', 'derivative'].includes(String(file.source))
  ) {
    throw new Error(`${source.slug}: Archive file metadata drifted`);
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written < 1) throw new Error('instrument evaluation hydration write made no progress');
    offset += written;
  }
}

async function downloadSource(
  repositoryRoot: string,
  outputDirectory: string,
  source: InstrumentEvaluationHydrationSource,
  manifest: InstrumentEvaluationHydrationManifest,
  fetchImplementation: FetchImplementation
): Promise<InstrumentEvaluationHydrationRecord> {
  const destination = sourcePath(outputDirectory, source);
  if (existsSync(destination)) return verifyExisting(outputDirectory, source);

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), manifest.downloadPolicy.requestTimeoutMs);
  let temporaryPath: string | undefined;
  let fd: number | undefined;
  try {
    await verifyArchiveMetadata(source, manifest, fetchImplementation, abort.signal);
    const downloadUrl = exactArchiveUrl(
      manifest.downloadPolicy.downloadOrigin,
      `${manifest.downloadPolicy.downloadPathPrefix}${encodedSegment(source.archiveIdentifier)}/${encodedSegment(source.archiveFile)}`,
      `${source.slug} download request`
    );
    const request: RequestInit = {
      redirect: 'manual',
      signal: abort.signal,
      headers: {
        accept: manifest.downloadPolicy.contentType,
        'accept-encoding': 'identity',
        'user-agent': 'stem-splitter-evaluation-hydrator/1',
      },
    };
    const redirect = await fetchImplementation(downloadUrl, request);
    if (
      redirect.status !== manifest.downloadPolicy.redirectStatus ||
      (redirect.url !== '' && redirect.url !== downloadUrl.href)
    ) {
      await cancelBody(redirect);
      throw new Error(`${source.slug}: Archive download did not return the pinned redirect`);
    }
    const location = redirect.headers.get('location');
    await cancelBody(redirect);
    if (!location) throw new Error(`${source.slug}: Archive redirect omitted its location`);
    const target = validateInstrumentEvaluationArchiveRedirect(location, source, manifest);
    const response = await fetchImplementation(target, request);
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    const contentEncoding = response.headers.get('content-encoding');
    const contentLength = response.headers.get('content-length');
    if (
      response.status !== 200 ||
      (response.url !== '' && response.url !== target.href) ||
      contentType !== manifest.downloadPolicy.contentType ||
      (contentEncoding !== null && contentEncoding.toLowerCase() !== 'identity') ||
      contentLength === null ||
      !/^\d+$/.test(contentLength) ||
      Number(contentLength) !== source.media.bytes ||
      Number(contentLength) > manifest.downloadPolicy.maximumBytesPerFile ||
      !response.body
    ) {
      await cancelBody(response);
      throw new Error(`${source.slug}: Archive audio headers do not match the manifest`);
    }

    temporaryPath = resolve(outputDirectory, `.${source.localFile}.${randomUUID()}.partial`);
    fd = openSync(temporaryPath, 'wx', 0o600);
    const md5 = createHash('md5');
    const sha1 = createHash('sha1');
    const sha256 = createHash('sha256');
    const reader = response.body.getReader();
    let received = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        if (!item.value?.byteLength) continue;
        received += item.value.byteLength;
        if (
          received > source.media.bytes ||
          received > manifest.downloadPolicy.maximumBytesPerFile
        ) {
          throw new Error(`${source.slug}: Archive audio exceeded its byte limit`);
        }
        md5.update(item.value);
        sha1.update(item.value);
        sha256.update(item.value);
        writeAll(fd, item.value);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // A fully consumed stream commonly rejects cancellation.
      }
    }
    const actual = {
      bytes: received,
      md5: md5.digest('hex'),
      sha1: sha1.digest('hex'),
      sha256: sha256.digest('hex'),
    };
    if (
      actual.bytes !== source.media.bytes ||
      actual.md5 !== source.media.md5 ||
      actual.sha1 !== source.media.sha1 ||
      actual.sha256 !== source.media.sha256
    ) {
      throw new Error(`${source.slug}: Archive audio body does not match its content pins`);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temporaryPath, destination);
    } catch (error) {
      if (filesystemErrorCode(error) !== 'EEXIST') throw error;
      return verifyExisting(outputDirectory, source);
    }
    const directoryFd = openSync(outputDirectory, 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
    return {
      slug: source.slug,
      state: 'downloaded',
      ...actual,
      path: relative(repositoryRoot, destination),
    };
  } catch (error) {
    if (abort.signal.aborted) throw new Error(`${source.slug}: hydration timed out`);
    throw error;
  } finally {
    clearTimeout(timer);
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Cleanup preserves the primary failure.
      }
    }
    if (temporaryPath && existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Dot-prefixed partials are never accepted as hydrated evidence.
      }
    }
  }
}

function selectedSources(
  manifest: InstrumentEvaluationHydrationManifest,
  slugs: string[]
): InstrumentEvaluationHydrationSource[] {
  const requested = new Set<string>();
  for (const slug of slugs) {
    if (!SAFE_SLUG.test(slug) || requested.has(slug)) {
      throw new Error(`invalid or duplicate instrument evaluation source slug: ${slug}`);
    }
    requested.add(slug);
  }
  const known = new Set(manifest.sources.map((source) => source.slug));
  for (const slug of requested) {
    if (!known.has(slug)) throw new Error(`unknown instrument evaluation source slug: ${slug}`);
  }
  return requested.size
    ? manifest.sources.filter((source) => requested.has(source.slug))
    : manifest.sources;
}

export async function hydrateInstrumentEvaluationCorpus(
  options: HydrateInstrumentEvaluationCorpusOptions = {}
): Promise<InstrumentEvaluationHydrationRecord[]> {
  const repositoryRoot = realpathSync(options.repositoryRoot ?? REPOSITORY_ROOT);
  const manifest = options.manifest ?? loadInstrumentEvaluationHydrationManifest(repositoryRoot);
  const outputDirectory = ensureOutputDirectory(
    repositoryRoot,
    manifest.downloadPolicy.outputDirectory
  );
  const sources = selectedSources(manifest, options.slugs ?? []);
  const results: InstrumentEvaluationHydrationRecord[] = [];
  for (const source of sources) {
    if (options.verifyOnly) {
      if (!existsSync(sourcePath(outputDirectory, source))) {
        throw new Error(`${source.slug}: pinned corpus source is missing`);
      }
      results.push(verifyExisting(outputDirectory, source));
      continue;
    }
    results.push(
      await downloadSource(
        repositoryRoot,
        outputDirectory,
        source,
        manifest,
        options.fetchImplementation ?? fetch
      )
    );
  }
  return results.map((result) => ({
    ...result,
    path: result.path.includes('/')
      ? result.path
      : relative(repositoryRoot, resolve(outputDirectory, result.path)),
  }));
}

function parseArguments(args: string[]): { verifyOnly: boolean; slugs: string[] } {
  let verifyOnly = false;
  const slugs: string[] = [];
  for (const argument of args) {
    if (argument === '--verify-only') {
      if (verifyOnly) throw new Error('--verify-only may be specified once');
      verifyOnly = true;
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown instrument evaluation hydration flag: ${argument}`);
    } else {
      slugs.push(argument);
    }
  }
  return { verifyOnly, slugs };
}

async function main(): Promise<void> {
  const { verifyOnly, slugs } = parseArguments(process.argv.slice(2));
  const results = await hydrateInstrumentEvaluationCorpus({ verifyOnly, slugs });
  process.stdout.write(
    `${JSON.stringify(
      {
        $schema: 'stem-splitter.instrument-evaluation-corpus-hydration-result.v1',
        manifestPath: INSTRUMENT_EVALUATION_HYDRATION_MANIFEST_PATH,
        manifestSha256: INSTRUMENT_EVALUATION_HYDRATION_MANIFEST_SHA256,
        state: verifyOnly ? 'verified' : 'hydrated',
        sources: results,
      },
      null,
      2
    )}\n`
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'instrument evaluation corpus hydration failed'}\n`
    );
    process.exitCode = 1;
  });
}
