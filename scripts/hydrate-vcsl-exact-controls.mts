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
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  VCSL_COMMIT,
  VCSL_EXACT_CONTROL_OUTPUT_DIRECTORY,
  VCSL_LICENSE_EVIDENCE_PIN,
  VCSL_README_EVIDENCE_PIN,
  loadVcslExactControlManifest,
  vcslExactControlPath,
  type VcslEvidenceObject,
  type VcslExactControl,
  type VcslExactControlManifest,
} from './lib/vcsl-exact-control-corpus.mts';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HYDRATION_SCHEMA = 'stem-splitter.vcsl-exact-control-hydration.v1';

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

interface PinnedObject {
  kind: 'license' | 'readme' | 'audio';
  url: string;
  bytes: number;
  sha256: string;
  gitBlobSha1: string;
  contentType: string;
  contentDisposition: string | null;
  label: string;
}

export interface VcslHydrationRecord {
  id: string;
  state: 'downloaded' | 'verified';
  bytes: number;
  sha256: string;
  path: string;
  sourceInstrument: VcslExactControl['sourceInstrument'];
  vocabularyId: VcslExactControl['vocabularyId'];
  coverageGroup: VcslExactControl['coverageGroup'];
  exactInstrumentClaim: 'repository-authored-source-label';
}

export interface HydrateVcslExactControlsOptions {
  repositoryRoot?: string;
  manifest?: VcslExactControlManifest;
  verifyOnly?: boolean;
  fetchImplementation?: FetchImplementation;
}

function filesystemErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !Object.hasOwn(error, 'code')) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitBlobSha1(bytes: Buffer): string {
  return createHash('sha1')
    .update(`blob ${bytes.byteLength}\0`, 'utf8')
    .update(bytes)
    .digest('hex');
}

function ensureDirectoryTree(repositoryRoot: string, relativeDirectory: string): string {
  const root = realpathSync(resolve(repositoryRoot));
  const rootMetadata = lstatSync(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error('VCSL repository root is not a regular directory');
  }
  const components = relativeDirectory.split('/');
  if (
    components.length < 2 ||
    components.some((component) => !component || component === '.' || component === '..')
  ) {
    throw new Error('VCSL output directory is invalid');
  }
  let current = root;
  for (const component of components) {
    current = resolve(current, component);
    if (!current.startsWith(`${root}${sep}`)) throw new Error('VCSL output directory escaped the repository');
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || realpathSync(current) !== current) {
      throw new Error('VCSL output directory contains a symlink or non-directory');
    }
  }
  return current;
}

function evidenceObject(kind: 'license' | 'readme', evidence: VcslEvidenceObject): PinnedObject {
  return {
    kind,
    url: evidence.url,
    bytes: evidence.bytes,
    sha256: evidence.sha256,
    gitBlobSha1: evidence.gitBlobSha1,
    contentType: evidence.contentType,
    contentDisposition: null,
    label: kind === 'license' ? 'VCSL license evidence' : 'VCSL README evidence',
  };
}

function audioObject(control: VcslExactControl): PinnedObject {
  return {
    kind: 'audio',
    url: control.sourceUrl,
    bytes: control.media.bytes,
    sha256: control.media.sha256,
    gitBlobSha1: control.gitBlobSha1,
    contentType: control.response.contentType,
    contentDisposition: control.response.contentDisposition,
    label: control.id,
  };
}

function exactSourceUrl(object: PinnedObject): URL {
  const url = new URL(object.url);
  const expectedPrefix = `/sgossner/VCSL/${VCSL_COMMIT}/`;
  if (
    url.protocol !== 'https:' || url.hostname !== 'raw.githubusercontent.com' ||
    !url.pathname.startsWith(expectedPrefix) || url.username || url.password || url.port ||
    url.search || url.hash
  ) {
    throw new Error(`${object.label}: source URL escaped the immutable VCSL commit`);
  }
  if (
    (object.kind === 'license' && object.url !== VCSL_LICENSE_EVIDENCE_PIN.url) ||
    (object.kind === 'readme' && object.url !== VCSL_README_EVIDENCE_PIN.url)
  ) {
    throw new Error(`${object.label}: evidence URL drifted`);
  }
  return url;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is cleanup only; the validation failure remains authoritative.
  }
}

async function readPinnedObject(
  object: PinnedObject,
  timeoutMs: number,
  maximumResponseBytes: number,
  fetchImplementation: FetchImplementation
): Promise<Buffer> {
  const url = exactSourceUrl(object);
  if (object.bytes > maximumResponseBytes) {
    throw new Error(`${object.label}: byte pin exceeds the VCSL response ceiling`);
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetchImplementation(url, {
      redirect: 'manual',
      signal: abort.signal,
      headers: {
        accept: object.contentType,
        'accept-encoding': 'identity',
        'user-agent': 'stem-splitter-vcsl-hydrator/1',
      },
    });
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    const contentLength = response.headers.get('content-length');
    const contentEncoding = response.headers.get('content-encoding');
    if (
      response.status !== 200 || !response.body || contentType !== object.contentType ||
      response.headers.get('content-disposition') !== object.contentDisposition ||
      (contentEncoding !== null && contentEncoding.toLowerCase() !== 'identity') ||
      contentLength === null || !/^\d+$/.test(contentLength) || Number(contentLength) !== object.bytes
    ) {
      await cancelBody(response);
      throw new Error(`${object.label}: response does not match the pinned VCSL object`);
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        if (!item.value?.byteLength) continue;
        received += item.value.byteLength;
        if (received > object.bytes || received > maximumResponseBytes) {
          throw new Error(`${object.label}: response body exceeded its byte ceiling`);
        }
        chunks.push(Buffer.from(item.value));
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // A consumed stream may reject cancellation.
      }
    }
    const bytes = Buffer.concat(chunks, received);
    if (
      received !== object.bytes || sha256Bytes(bytes) !== object.sha256 ||
      gitBlobSha1(bytes) !== object.gitBlobSha1
    ) {
      throw new Error(`${object.label}: bytes do not match the VCSL content and Git pins`);
    }
    return bytes;
  } catch (error) {
    if (abort.signal.aborted) throw new Error(`${object.label}: hydration timed out`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function validateRightsEvidence(licenseBytes: Buffer, readmeBytes: Buffer): void {
  const license = licenseBytes.toString('utf8');
  const readme = readmeBytes.toString('utf8');
  if (
    Buffer.from(license, 'utf8').byteLength !== licenseBytes.byteLength ||
    !license.startsWith('Creative Commons Legal Code\n\nCC0 1.0 Universal\n') ||
    !license.includes('reuse and redistribute as freely as possible')
  ) {
    throw new Error('VCSL license evidence content drifted');
  }
  if (
    Buffer.from(readme, 'utf8').byteLength !== readmeBytes.byteLength ||
    !readme.startsWith('# VCSL\n') ||
    !readme.includes('open CC0 general-purpose sample library') ||
    !readme.includes('Samples shall be named in a human-readable format') ||
    !readme.includes('idiomatic (e.g. harmonicas, solo vox)')
  ) {
    throw new Error('VCSL README evidence content drifted');
  }
}

function validateVcslWav(bytes: Buffer, control: VcslExactControl): void {
  const media = control.media;
  if (
    bytes.byteLength !== media.bytes || sha256Bytes(bytes) !== media.sha256 ||
    gitBlobSha1(bytes) !== control.gitBlobSha1
  ) {
    throw new Error(`${control.id}: VCSL WAV bytes do not match the media and Git pins`);
  }
  if (
    bytes.byteLength < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.readUInt32LE(4) !== media.riffBytes || media.riffBytes + 8 !== bytes.byteLength ||
    bytes.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error(`${control.id}: VCSL WAV container contract drifted`);
  }
  const chunks: Array<{ id: string; bytes: number; offset: number }> = [];
  let offset = 12;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new Error(`${control.id}: VCSL WAV chunk header is truncated`);
    const id = bytes.toString('ascii', offset, offset + 4);
    const chunkBytes = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const padding = chunkBytes % 2;
    const next = dataOffset + chunkBytes + padding;
    if (next > bytes.byteLength) throw new Error(`${control.id}: VCSL WAV chunk escaped the file`);
    if (padding && bytes[next - 1] !== 0) throw new Error(`${control.id}: VCSL WAV padding is nonzero`);
    chunks.push({ id, bytes: chunkBytes, offset: dataOffset });
    offset = next;
  }
  if (
    offset !== bytes.byteLength ||
    JSON.stringify(chunks.map(({ id, bytes: chunkBytes }) => ({ id, bytes: chunkBytes }))) !==
      JSON.stringify(media.chunks)
  ) {
    throw new Error(`${control.id}: VCSL WAV chunk surface drifted`);
  }
  const format = chunks[0];
  const data = chunks.find(({ id }) => id === 'data');
  if (!format || format.id !== 'fmt ' || !data) {
    throw new Error(`${control.id}: VCSL WAV required chunks are unavailable`);
  }
  if (
    (format.bytes !== 16 && format.bytes !== 18) ||
    bytes.readUInt16LE(format.offset) !== media.formatTag ||
    bytes.readUInt16LE(format.offset + 2) !== media.channels ||
    bytes.readUInt32LE(format.offset + 4) !== media.sampleRate ||
    bytes.readUInt32LE(format.offset + 8) !== media.byteRate ||
    bytes.readUInt16LE(format.offset + 12) !== media.blockAlign ||
    bytes.readUInt16LE(format.offset + 14) !== media.bitsPerSample ||
    (format.bytes === 18 && bytes.readUInt16LE(format.offset + 16) !== 0) ||
    data.bytes !== media.dataBytes || data.bytes / media.blockAlign !== media.frameCount
  ) {
    throw new Error(`${control.id}: VCSL WAV PCM contract drifted`);
  }
}

function recordFor(
  manifest: VcslExactControlManifest,
  control: VcslExactControl,
  state: VcslHydrationRecord['state']
): VcslHydrationRecord {
  return {
    id: control.id,
    state,
    bytes: control.media.bytes,
    sha256: control.media.sha256,
    path: `${manifest.hydration.outputDirectory}/${control.localFile}`,
    sourceInstrument: control.sourceInstrument,
    vocabularyId: control.vocabularyId,
    coverageGroup: control.coverageGroup,
    exactInstrumentClaim: 'repository-authored-source-label',
  };
}

function verifyExistingControl(
  repositoryRoot: string,
  manifest: VcslExactControlManifest,
  control: VcslExactControl
): VcslHydrationRecord {
  const controlFile = vcslExactControlPath(repositoryRoot, manifest, control);
  try {
    const metadata = lstatSync(controlFile);
    if (
      metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== control.media.bytes ||
      (metadata.mode & 0o777) !== 0o600 || realpathSync(controlFile) !== controlFile
    ) {
      throw new Error('not the pinned owner-only regular file');
    }
    validateVcslWav(readFileSync(controlFile), control);
  } catch {
    throw new Error(`${control.id}: existing VCSL control is not the pinned owner-only WAV`);
  }
  return recordFor(manifest, control, 'verified');
}

function storeControl(
  repositoryRoot: string,
  outputDirectory: string,
  manifest: VcslExactControlManifest,
  control: VcslExactControl,
  bytes: Buffer
): VcslHydrationRecord {
  validateVcslWav(bytes, control);
  const destination = vcslExactControlPath(repositoryRoot, manifest, control);
  if (existsSync(destination)) return verifyExistingControl(repositoryRoot, manifest, control);
  const temporaryFile = resolve(outputDirectory, `.${control.localFile}.${randomUUID()}.partial`);
  writeFileSync(temporaryFile, bytes, { flag: 'wx', mode: 0o600 });
  try {
    const temporaryFd = openSync(temporaryFile, 'r');
    try {
      fsyncSync(temporaryFd);
    } finally {
      closeSync(temporaryFd);
    }
    try {
      linkSync(temporaryFile, destination);
    } catch (error) {
      if (filesystemErrorCode(error) !== 'EEXIST') throw error;
      return verifyExistingControl(repositoryRoot, manifest, control);
    }
    const directoryFd = openSync(outputDirectory, 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
    return recordFor(manifest, control, 'downloaded');
  } finally {
    if (existsSync(temporaryFile)) unlinkSync(temporaryFile);
  }
}

export async function hydrateVcslExactControls(
  options: HydrateVcslExactControlsOptions = {}
): Promise<VcslHydrationRecord[]> {
  const repositoryRoot = realpathSync(resolve(options.repositoryRoot ?? REPOSITORY_ROOT));
  const manifest = options.manifest ?? loadVcslExactControlManifest(repositoryRoot);
  if (manifest.hydration.outputDirectory !== VCSL_EXACT_CONTROL_OUTPUT_DIRECTORY) {
    throw new Error('VCSL output directory drifted');
  }
  const outputDirectory = ensureDirectoryTree(repositoryRoot, manifest.hydration.outputDirectory);
  const existing = new Map<string, VcslHydrationRecord>();
  for (const control of manifest.controls) {
    const controlFile = vcslExactControlPath(repositoryRoot, manifest, control);
    if (existsSync(controlFile)) {
      existing.set(control.id, verifyExistingControl(repositoryRoot, manifest, control));
    }
  }
  if (existing.size === manifest.controls.length) {
    return manifest.controls.map(({ id }) => existing.get(id)!);
  }
  if (options.verifyOnly) {
    throw new Error('one or more pinned VCSL controls are unavailable for offline verification');
  }

  const fetchImplementation = options.fetchImplementation ?? fetch;
  const licenseBytes = await readPinnedObject(
    evidenceObject('license', manifest.repository.licenseEvidence),
    manifest.hydration.requestTimeoutMs,
    manifest.hydration.maximumResponseBytes,
    fetchImplementation
  );
  const readmeBytes = await readPinnedObject(
    evidenceObject('readme', manifest.repository.readmeEvidence),
    manifest.hydration.requestTimeoutMs,
    manifest.hydration.maximumResponseBytes,
    fetchImplementation
  );
  validateRightsEvidence(licenseBytes, readmeBytes);

  const downloaded = new Map<string, Buffer>();
  for (const control of manifest.controls) {
    if (existing.has(control.id)) continue;
    const bytes = await readPinnedObject(
      audioObject(control),
      manifest.hydration.requestTimeoutMs,
      manifest.hydration.maximumResponseBytes,
      fetchImplementation
    );
    validateVcslWav(bytes, control);
    downloaded.set(control.id, bytes);
  }
  const results = manifest.controls.map((control) =>
    existing.get(control.id) ??
    storeControl(repositoryRoot, outputDirectory, manifest, control, downloaded.get(control.id)!)
  );
  return results.map((record) => ({
    ...record,
    path: relative(repositoryRoot, resolve(repositoryRoot, record.path)),
  }));
}

function parseArguments(args: string[]): { verifyOnly: boolean } {
  let verifyOnly = false;
  for (const argument of args) {
    if (argument !== '--verify-only') throw new Error(`unknown VCSL hydration argument: ${argument}`);
    if (verifyOnly) throw new Error('--verify-only may be specified once');
    verifyOnly = true;
  }
  return { verifyOnly };
}

async function main(): Promise<void> {
  const { verifyOnly } = parseArguments(process.argv.slice(2));
  const manifest = loadVcslExactControlManifest(REPOSITORY_ROOT);
  const controls = await hydrateVcslExactControls({
    repositoryRoot: REPOSITORY_ROOT,
    manifest,
    verifyOnly,
  });
  process.stdout.write(`${JSON.stringify({
    $schema: HYDRATION_SCHEMA,
    version: manifest.version,
    reviewStatus: manifest.reviewStatus,
    exactInstrumentClaims: 'source-label-only',
    currentEvaluationPlanUse: 'forbidden',
    controls,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'VCSL hydration failed'}\n`);
    process.exitCode = 1;
  });
}
