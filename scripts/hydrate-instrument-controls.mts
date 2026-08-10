#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  INSTRUMENT_CONTROL_OUTPUT_DIRECTORY,
  instrumentControlPath,
  loadInstrumentControlManifest,
  type InstrumentControl,
  type InstrumentControlManifest,
} from './lib/instrument-control-corpus.mts';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HYDRATION_SCHEMA = 'stem-splitter.instrument-control-hydration.v1';
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REDIRECT_ASSET_SEGMENT = /^[a-f0-9]{10}-\d{10}$/;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface HydrationRecord {
  id: string;
  state: 'downloaded' | 'verified';
  bytes: number;
  sha256: string;
  path: string;
}

export interface HydrateInstrumentControlsOptions {
  repositoryRoot?: string;
  manifest?: InstrumentControlManifest;
  ids?: string[];
  verifyOnly?: boolean;
  fetchImplementation?: FetchImplementation;
}

function filesystemErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !Object.hasOwn(error, 'code')) return undefined;
  return typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function sha256File(path: string, expectedBytes: number): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== expectedBytes) {
    throw new Error('hydrated control file identity does not match');
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function verifyExistingControl(path: string, control: InstrumentControl): HydrationRecord {
  let digest: string;
  try {
    digest = sha256File(path, control.media.bytes);
  } catch {
    throw new Error(`${control.id}: existing control file is not the pinned regular file`);
  }
  if (digest !== control.media.sha256) {
    throw new Error(`${control.id}: existing control file does not match the pinned SHA-256`);
  }
  return {
    id: control.id,
    state: 'verified',
    bytes: control.media.bytes,
    sha256: digest,
    path: control.localFile,
  };
}

function ensureDirectoryTree(repositoryRoot: string, relativeDirectory: string): string {
  const root = resolve(repositoryRoot);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('instrument control repository root is not a regular directory');
  }
  const components = relativeDirectory.split('/');
  if (
    components.length < 2 ||
    components.some((component) => !component || component === '.' || component === '..')
  ) {
    throw new Error('instrument control output directory is invalid');
  }
  let current = root;
  for (const component of components) {
    current = resolve(current, component);
    if (!current.startsWith(`${root}${sep}`)) {
      throw new Error('instrument control output directory escaped the repository');
    }
    if (!existsSync(current)) {
      mkdirSync(current, { mode: 0o700 });
      continue;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('instrument control output path contains a non-directory or symlink');
    }
  }
  return current;
}

function validateFetchUrl(url: URL, expectedOrigin: string, context: string): void {
  if (
    url.protocol !== 'https:' ||
    url.origin !== expectedOrigin ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${context} escaped the pinned origin`);
  }
}

export function validateInstrumentControlRedirect(
  location: string,
  control: InstrumentControl,
  manifest: InstrumentControlManifest
): URL {
  let target: URL;
  try {
    target = new URL(location, control.sourceUrl);
  } catch {
    throw new Error(`${control.id}: redirect location is invalid`);
  }
  validateFetchUrl(target, manifest.downloadPolicy.redirectOrigin, `${control.id} redirect`);
  const expectedPrefix = `${manifest.downloadPolicy.redirectPathPrefix}${control.pieceId}/tracks/`;
  if (!target.pathname.startsWith(expectedPrefix)) {
    throw new Error(`${control.id}: redirect path escaped the pinned dataset`);
  }
  const suffix = target.pathname.slice(expectedPrefix.length).split('/');
  if (
    suffix.length !== 2 ||
    !REDIRECT_ASSET_SEGMENT.test(suffix[0]) ||
    suffix[1] !== control.trackFile
  ) {
    throw new Error(`${control.id}: redirect asset identity is invalid`);
  }
  return target;
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written < 1) throw new Error('instrument control write made no progress');
    offset += written;
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response body is intentionally discarded; cancellation failure is non-authoritative.
  }
}

async function downloadControl(
  repositoryRoot: string,
  outputDirectory: string,
  manifest: InstrumentControlManifest,
  control: InstrumentControl,
  fetchImplementation: FetchImplementation
): Promise<HydrationRecord> {
  const destination = instrumentControlPath(repositoryRoot, manifest, control);
  if (existsSync(destination)) return verifyExistingControl(destination, control);

  const source = new URL(control.sourceUrl);
  validateFetchUrl(source, manifest.downloadPolicy.sourceOrigin, `${control.id} source`);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), manifest.downloadPolicy.requestTimeoutMs);
  const request: RequestInit = {
    redirect: 'manual',
    signal: abort.signal,
    headers: {
      accept: manifest.downloadPolicy.contentType,
      'accept-encoding': 'identity',
      'user-agent': 'stem-splitter-control-hydrator/1',
    },
  };
  let temporaryPath: string | undefined;
  let fd: number | undefined;
  try {
    const redirect = await fetchImplementation(source, request);
    if (redirect.status !== manifest.downloadPolicy.redirectStatus) {
      await cancelBody(redirect);
      throw new Error(`${control.id}: source did not return the pinned redirect`);
    }
    const location = redirect.headers.get('location');
    await cancelBody(redirect);
    if (!location) throw new Error(`${control.id}: source redirect omitted its location`);
    const target = validateInstrumentControlRedirect(location, control, manifest);
    const response = await fetchImplementation(target, request);
    if (response.status !== 200) {
      await cancelBody(response);
      throw new Error(`${control.id}: pinned media request did not return 200`);
    }
    const contentType = response.headers.get('content-type');
    const contentEncoding = response.headers.get('content-encoding');
    const contentLength = response.headers.get('content-length');
    if (
      contentType?.split(';', 1)[0].trim().toLowerCase() !== manifest.downloadPolicy.contentType ||
      (contentEncoding !== null && contentEncoding.toLowerCase() !== 'identity') ||
      contentLength === null ||
      !/^\d+$/.test(contentLength) ||
      Number(contentLength) !== control.media.bytes ||
      Number(contentLength) > manifest.downloadPolicy.maximumBytesPerFile ||
      !response.body
    ) {
      await cancelBody(response);
      throw new Error(`${control.id}: pinned media headers do not match the manifest`);
    }

    temporaryPath = resolve(outputDirectory, `.${control.localFile}.${randomUUID()}.partial`);
    fd = openSync(temporaryPath, 'wx', 0o600);
    const digest = createHash('sha256');
    const reader = response.body.getReader();
    let received = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        if (!item.value?.byteLength) continue;
        received += item.value.byteLength;
        if (
          received > control.media.bytes ||
          received > manifest.downloadPolicy.maximumBytesPerFile
        ) {
          throw new Error(`${control.id}: pinned media body exceeded its byte limit`);
        }
        digest.update(item.value);
        writeAll(fd, item.value);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // A fully consumed stream normally rejects cancellation; cleanup still continues.
      }
    }
    const actualSha256 = digest.digest('hex');
    if (received !== control.media.bytes || actualSha256 !== control.media.sha256) {
      throw new Error(`${control.id}: pinned media body does not match the manifest`);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temporaryPath, destination);
    } catch (error) {
      if (filesystemErrorCode(error) !== 'EEXIST') throw error;
      return verifyExistingControl(destination, control);
    }
    const directoryFd = openSync(outputDirectory, 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
    return {
      id: control.id,
      state: 'downloaded',
      bytes: received,
      sha256: actualSha256,
      path: control.localFile,
    };
  } catch (error) {
    if (abort.signal.aborted) throw new Error(`${control.id}: hydration timed out`);
    throw error;
  } finally {
    clearTimeout(timer);
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The descriptor may already have been closed by an exceptional path.
      }
    }
    if (temporaryPath && existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Preserve the primary failure; dot-prefixed partials are never accepted as corpus audio.
      }
    }
  }
}

function selectedControls(manifest: InstrumentControlManifest, ids: string[]): InstrumentControl[] {
  const requested = new Set<string>();
  for (const id of ids) {
    if (!SAFE_ID.test(id) || requested.has(id)) {
      throw new Error(`invalid or duplicate instrument control id: ${id}`);
    }
    requested.add(id);
  }
  const known = new Set(manifest.controls.map((control) => control.id));
  for (const id of requested) {
    if (!known.has(id)) throw new Error(`unknown instrument control id: ${id}`);
  }
  return requested.size
    ? manifest.controls.filter((control) => requested.has(control.id))
    : manifest.controls;
}

export async function hydrateInstrumentControls(
  options: HydrateInstrumentControlsOptions = {}
): Promise<HydrationRecord[]> {
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const manifest = options.manifest ?? loadInstrumentControlManifest(repositoryRoot);
  if (manifest.downloadPolicy.outputDirectory !== INSTRUMENT_CONTROL_OUTPUT_DIRECTORY) {
    throw new Error('instrument control output directory drifted');
  }
  const outputDirectory = ensureDirectoryTree(
    repositoryRoot,
    manifest.downloadPolicy.outputDirectory
  );
  const controls = selectedControls(manifest, options.ids ?? []);
  const results: HydrationRecord[] = [];
  for (const control of controls) {
    const destination = instrumentControlPath(repositoryRoot, manifest, control);
    if (options.verifyOnly) {
      if (!existsSync(destination)) throw new Error(`${control.id}: pinned control file is missing`);
      results.push(verifyExistingControl(destination, control));
      continue;
    }
    results.push(
      await downloadControl(
        repositoryRoot,
        outputDirectory,
        manifest,
        control,
        options.fetchImplementation ?? fetch
      )
    );
  }
  return results.map((result) => ({
    ...result,
    path: relative(repositoryRoot, resolve(outputDirectory, result.path)),
  }));
}

function parseArguments(args: string[]): { ids: string[]; verifyOnly: boolean } {
  const ids: string[] = [];
  let verifyOnly = false;
  for (const argument of args) {
    if (argument === '--verify-only') {
      if (verifyOnly) throw new Error('--verify-only may be specified once');
      verifyOnly = true;
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown instrument control hydration flag: ${argument}`);
    } else {
      ids.push(argument);
    }
  }
  return { ids, verifyOnly };
}

async function main(): Promise<void> {
  const { ids, verifyOnly } = parseArguments(process.argv.slice(2));
  const manifest = loadInstrumentControlManifest(REPOSITORY_ROOT);
  const controls = await hydrateInstrumentControls({
    repositoryRoot: REPOSITORY_ROOT,
    manifest,
    ids,
    verifyOnly,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        $schema: HYDRATION_SCHEMA,
        version: manifest.version,
        reviewStatus: manifest.reviewStatus,
        mode: verifyOnly ? 'verify-only' : 'hydrate',
        controls,
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
      `${error instanceof Error ? error.message : 'instrument control hydration failed'}\n`
    );
    process.exitCode = 1;
  });
}
