#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';

import {
  loadNsynthFamilyControlManifest,
  nsynthFamilyControlPath,
  type NsynthFamilyControl,
  type NsynthFamilyControlManifest,
} from './lib/nsynth-family-control-corpus.mts';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HYDRATION_SCHEMA = 'stem-splitter.nsynth-family-control-hydration.v1' as const;
const TAR_BLOCK_BYTES = 512;
const AUDIO_MEMBER =
  /^nsynth-test\/audio\/[a-z]+_(?:acoustic|electronic|synthetic)_\d{3}-\d{3}-\d{3}\.wav$/;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface NsynthHydrationRecord {
  id: string;
  state: 'downloaded' | 'verified';
  bytes: number;
  sha256: string;
  path: string;
  datasetFamily: string;
  datasetSource: string;
  exactInstrumentClaim: false;
}

export interface HydrateNsynthFamilyControlsOptions {
  repositoryRoot?: string;
  manifest?: NsynthFamilyControlManifest;
  archivePath?: string;
  verifyOnly?: boolean;
  fetchImplementation?: FetchImplementation;
}

interface TarMemberState {
  name: string;
  size: number;
  remaining: number;
  padding: number;
  capture: boolean;
  chunks: Buffer[];
  capturedBytes: number;
}

interface ExtractedArchive {
  members: Map<string, Buffer>;
  memberCount: number;
  audioMemberCount: number;
}

function filesystemErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !Object.hasOwn(error, 'code')) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written < 1) throw new Error('NSynth archive write made no progress');
    offset += written;
  }
}

function ensureDirectoryTree(repositoryRoot: string, relativeDirectory: string): string {
  const root = resolve(repositoryRoot);
  const rootMetadata = lstatSync(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error('NSynth repository root is not a regular directory');
  }
  const components = relativeDirectory.split('/');
  if (
    components.length < 2 ||
    components.some((component) => !component || component === '.' || component === '..')
  ) {
    throw new Error('NSynth output directory is invalid');
  }
  let current = root;
  for (const component of components) {
    current = resolve(current, component);
    if (!current.startsWith(`${root}${sep}`)) {
      throw new Error('NSynth output directory escaped the repository');
    }
    if (!existsSync(current)) {
      mkdirSync(current, { mode: 0o700 });
      continue;
    }
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('NSynth output path contains a symlink or non-directory');
    }
  }
  return current;
}

function validateNsynthWav(bytes: Buffer, control: NsynthFamilyControl): void {
  if (
    bytes.byteLength !== control.media.bytes ||
    bytes.byteLength !== 128_044 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE' ||
    bytes.toString('ascii', 12, 16) !== 'fmt ' ||
    bytes.toString('ascii', 36, 40) !== 'data' ||
    bytes.readUInt32LE(4) + 8 !== bytes.byteLength ||
    bytes.readUInt32LE(16) !== 16 ||
    bytes.readUInt16LE(20) !== 1 ||
    bytes.readUInt16LE(22) !== control.media.channels ||
    bytes.readUInt32LE(24) !== control.media.sampleRate ||
    bytes.readUInt32LE(28) !== control.media.sampleRate * 2 ||
    bytes.readUInt16LE(32) !== 2 ||
    bytes.readUInt16LE(34) !== control.media.bitsPerSample ||
    bytes.readUInt32LE(40) !== 128_000
  ) {
    throw new Error(`${control.id}: NSynth WAV contract does not match`);
  }
  if (sha256Bytes(bytes) !== control.media.sha256) {
    throw new Error(`${control.id}: NSynth WAV SHA-256 does not match`);
  }
}

function verifyExistingControl(
  repositoryRoot: string,
  manifest: NsynthFamilyControlManifest,
  control: NsynthFamilyControl
): NsynthHydrationRecord {
  const path = nsynthFamilyControlPath(repositoryRoot, manifest, control);
  let bytes: Buffer;
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== control.media.bytes) {
      throw new Error('identity mismatch');
    }
    bytes = readFileSync(path);
    validateNsynthWav(bytes, control);
  } catch {
    throw new Error(`${control.id}: existing NSynth control is not the pinned regular WAV`);
  }
  return {
    id: control.id,
    state: 'verified',
    bytes: bytes.byteLength,
    sha256: control.media.sha256,
    path: `${manifest.archive.outputDirectory}/${control.localFile}`,
    datasetFamily: control.metadata.family,
    datasetSource: control.metadata.source,
    exactInstrumentClaim: false,
  };
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is cleanup only; header or body validation remains authoritative.
  }
}

function exactArchiveUrl(manifest: NsynthFamilyControlManifest): URL {
  const url = new URL(manifest.archive.url);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'storage.googleapis.com' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !==
      '/download.magenta.tensorflow.org/datasets/nsynth/nsynth-test.jsonwav.tar.gz'
  ) {
    throw new Error('NSynth archive URL escaped the pinned Google Cloud object');
  }
  return url;
}

async function downloadArchive(
  destination: string,
  manifest: NsynthFamilyControlManifest,
  fetchImplementation: FetchImplementation
): Promise<void> {
  const url = exactArchiveUrl(manifest);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), manifest.archive.requestTimeoutMs);
  let fd: number | undefined;
  let completed = false;
  try {
    const response = await fetchImplementation(url, {
      redirect: 'manual',
      signal: abort.signal,
      headers: {
        accept: manifest.archive.contentType,
        'accept-encoding': 'identity',
        'user-agent': 'stem-splitter-nsynth-hydrator/1',
      },
    });
    const contentLength = response.headers.get('content-length');
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    const contentEncoding = response.headers.get('content-encoding');
    if (
      response.status !== 200 ||
      !response.body ||
      contentType !== manifest.archive.contentType ||
      (contentEncoding !== null && contentEncoding.toLowerCase() !== 'identity') ||
      contentLength === null ||
      !/^\d+$/.test(contentLength) ||
      Number(contentLength) !== manifest.archive.bytes ||
      response.headers.get('x-goog-generation') !== manifest.archive.storageGeneration ||
      response.headers.get('etag') !== `"${manifest.archive.etag}"` ||
      response.headers.get('last-modified') !== manifest.archive.lastModified
    ) {
      await cancelBody(response);
      throw new Error('NSynth archive response does not match the pinned object');
    }

    fd = openSync(destination, 'wx', 0o600);
    const digest = createHash('sha256');
    const reader = response.body.getReader();
    let received = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        if (!item.value?.byteLength) continue;
        received += item.value.byteLength;
        if (received > manifest.archive.bytes) {
          throw new Error('NSynth archive body exceeded the pinned byte count');
        }
        digest.update(item.value);
        writeAll(fd, item.value);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // A consumed stream may reject cancellation; the descriptor cleanup still runs.
      }
    }
    if (received !== manifest.archive.bytes || digest.digest('hex') !== manifest.archive.sha256) {
      throw new Error('NSynth archive bytes do not match the pinned object');
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    completed = true;
  } catch (error) {
    if (abort.signal.aborted) throw new Error('NSynth archive hydration timed out');
    throw error;
  } finally {
    clearTimeout(timer);
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the primary failure.
      }
    }
    if (!completed && existsSync(destination)) {
      try {
        unlinkSync(destination);
      } catch {
        // The private temporary directory is removed by the caller as a final cleanup.
      }
    }
  }
}

async function verifyArchiveFile(path: string, manifest: NsynthFamilyControlManifest): Promise<void> {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== manifest.archive.bytes) {
    throw new Error('NSynth archive is not the pinned regular file');
  }
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > manifest.archive.bytes) throw new Error('NSynth archive exceeded its byte pin');
    digest.update(value);
  }
  if (bytes !== manifest.archive.bytes || digest.digest('hex') !== manifest.archive.sha256) {
    throw new Error('NSynth archive file does not match its SHA-256 pin');
  }
}

function tarString(block: Buffer, start: number, length: number): string {
  const end = block.indexOf(0, start);
  const sliceEnd = end >= start && end < start + length ? end : start + length;
  const value = block.toString('utf8', start, sliceEnd);
  if (!value || /[^\x20-\x7e]/.test(value)) throw new Error('NSynth tar header text is invalid');
  return value;
}

function tarOctal(block: Buffer, start: number, length: number, context: string): number {
  const raw = block
    .toString('ascii', start, start + length)
    .replace(/\0.*$/s, '')
    .trim();
  if (!/^[0-7]+$/.test(raw)) throw new Error(`NSynth tar ${context} is invalid`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`NSynth tar ${context} is invalid`);
  }
  return value;
}

function parseTarHeader(block: Buffer): { name: string; size: number; type: string } {
  const expectedChecksum = tarOctal(block, 148, 8, 'checksum');
  let actualChecksum = 0;
  for (let index = 0; index < block.byteLength; index += 1) {
    actualChecksum += index >= 148 && index < 156 ? 32 : block[index];
  }
  if (actualChecksum !== expectedChecksum) throw new Error('NSynth tar checksum does not match');
  const magic = block.toString('ascii', 257, 263);
  if (magic !== 'ustar\0' && magic !== 'ustar ') {
    throw new Error('NSynth tar header is not ustar');
  }
  const name = tarString(block, 0, 100);
  const prefixBytes = block.subarray(345, 500);
  const prefix = prefixBytes.every((byte) => byte === 0) ? '' : tarString(block, 345, 155);
  const fullName = prefix ? `${prefix}/${name}` : name;
  if (
    fullName.startsWith('/') ||
    fullName.includes('\\') ||
    fullName.split('/').some((part) => part === '..' || part === '.')
  ) {
    throw new Error('NSynth tar member path is unsafe');
  }
  return {
    name: fullName,
    size: tarOctal(block, 124, 12, 'member size'),
    type: String.fromCharCode(block[156] || 48),
  };
}

function maximumDecodedBytes(manifest: NsynthFamilyControlManifest): number {
  return (
    manifest.archive.memberCount * TAR_BLOCK_BYTES +
    manifest.archive.audioMemberCount * (128_044 + TAR_BLOCK_BYTES) +
    manifest.archive.examplesBytes +
    TAR_BLOCK_BYTES * 4
  );
}

export async function extractPinnedNsynthMembers(
  archivePath: string,
  manifest: NsynthFamilyControlManifest
): Promise<ExtractedArchive> {
  const captureNames = new Set([
    manifest.archive.examplesMember,
    ...manifest.controls.map(({ archiveMember }) => archiveMember),
  ]);
  const captured = new Map<string, Buffer>();
  const seen = new Set<string>();
  let pending = Buffer.alloc(0);
  let current: TarMemberState | null = null;
  let memberCount = 0;
  let audioMemberCount = 0;
  let directoryCount = 0;
  let zeroBlocks = 0;
  let decodedBytes = 0;

  const decoded = createReadStream(archivePath).pipe(createGunzip());
  for await (const rawChunk of decoded) {
    const chunk = Buffer.from(rawChunk);
    decodedBytes += chunk.byteLength;
    if (decodedBytes > maximumDecodedBytes(manifest)) {
      throw new Error('NSynth tar stream exceeded its decoded byte ceiling');
    }
    pending = pending.byteLength ? Buffer.concat([pending, chunk]) : chunk;
    while (true) {
      if (current) {
        if (current.remaining > 0) {
          if (!pending.byteLength) break;
          const take = Math.min(current.remaining, pending.byteLength);
          const part = pending.subarray(0, take);
          pending = pending.subarray(take);
          current.remaining -= take;
          if (current.capture) {
            current.capturedBytes += part.byteLength;
            current.chunks.push(Buffer.from(part));
          }
          if (current.remaining > 0) continue;
        }
        if (current.padding > 0) {
          if (pending.byteLength < current.padding) break;
          if (!pending.subarray(0, current.padding).every((byte) => byte === 0)) {
            throw new Error(`NSynth tar padding is nonzero for ${current.name}`);
          }
          pending = pending.subarray(current.padding);
          current.padding = 0;
        }
        if (current.capture) {
          if (current.capturedBytes !== current.size) {
            throw new Error(`NSynth tar capture is incomplete for ${current.name}`);
          }
          captured.set(current.name, Buffer.concat(current.chunks, current.size));
        }
        current = null;
        continue;
      }

      if (pending.byteLength < TAR_BLOCK_BYTES) break;
      const header = pending.subarray(0, TAR_BLOCK_BYTES);
      pending = pending.subarray(TAR_BLOCK_BYTES);
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        continue;
      }
      if (zeroBlocks > 0) throw new Error('NSynth tar has data after its end marker');
      const parsed = parseTarHeader(header);
      if (seen.has(parsed.name)) throw new Error(`NSynth tar repeats ${parsed.name}`);
      seen.add(parsed.name);
      memberCount += 1;

      if (parsed.type === '5') {
        if (
          parsed.size !== 0 ||
          (parsed.name !== `${manifest.archive.memberRoot}/` &&
            parsed.name !== `${manifest.archive.memberRoot}/audio/`)
        ) {
          throw new Error(`NSynth tar contains an unexpected directory ${parsed.name}`);
        }
        directoryCount += 1;
      } else if (parsed.type === '0') {
        if (parsed.name === manifest.archive.examplesMember) {
          if (parsed.size !== manifest.archive.examplesBytes) {
            throw new Error('NSynth examples metadata size drifted');
          }
        } else if (AUDIO_MEMBER.test(parsed.name)) {
          if (parsed.size !== 128_044) throw new Error(`NSynth WAV size drifted for ${parsed.name}`);
          audioMemberCount += 1;
        } else {
          throw new Error(`NSynth tar contains an unexpected file ${parsed.name}`);
        }
      } else {
        throw new Error(`NSynth tar contains unsupported member type ${parsed.type}`);
      }

      const capture = captureNames.has(parsed.name);
      current = {
        name: parsed.name,
        size: parsed.size,
        remaining: parsed.size,
        padding: (TAR_BLOCK_BYTES - (parsed.size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES,
        capture,
        chunks: [],
        capturedBytes: 0,
      };
    }
  }
  if (
    current ||
    pending.byteLength !== 0 ||
    zeroBlocks < 2 ||
    memberCount !== manifest.archive.memberCount ||
    audioMemberCount !== manifest.archive.audioMemberCount ||
    directoryCount !== 2 ||
    captured.size !== captureNames.size
  ) {
    throw new Error('NSynth tar surface does not match the pinned archive');
  }
  for (const name of captureNames) {
    if (!captured.has(name)) throw new Error(`NSynth tar omitted selected member ${name}`);
  }
  return { members: captured, memberCount, audioMemberCount };
}

function validateExamplesMetadata(
  bytes: Buffer,
  manifest: NsynthFamilyControlManifest
): void {
  if (
    bytes.byteLength !== manifest.archive.examplesBytes ||
    sha256Bytes(bytes) !== manifest.archive.examplesSha256
  ) {
    throw new Error('NSynth examples metadata does not match its content pin');
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('NSynth examples metadata is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('NSynth examples metadata root is invalid');
  }
  const examples = value as Record<string, unknown>;
  if (Object.keys(examples).length !== manifest.archive.audioMemberCount) {
    throw new Error('NSynth examples metadata count drifted');
  }
  const expectedKeys = [
    'qualities',
    'pitch',
    'note',
    'instrument_source_str',
    'velocity',
    'instrument_str',
    'instrument',
    'sample_rate',
    'qualities_str',
    'instrument_source',
    'note_str',
    'instrument_family',
    'instrument_family_str',
  ].sort();
  for (const control of manifest.controls) {
    const raw = examples[control.noteStr];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${control.id}: NSynth examples metadata omitted the selected note`);
    }
    const entry = raw as Record<string, unknown>;
    if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(expectedKeys)) {
      throw new Error(`${control.id}: NSynth examples metadata schema drifted`);
    }
    const metadata = control.metadata;
    const expected = {
      qualities: metadata.qualityVector,
      pitch: metadata.pitch,
      note: metadata.note,
      instrument_source_str: metadata.source,
      velocity: metadata.velocity,
      instrument_str: metadata.instrumentStr,
      instrument: metadata.instrument,
      sample_rate: metadata.sampleRate,
      qualities_str: metadata.qualityIds,
      instrument_source: metadata.sourceIndex,
      note_str: control.noteStr,
      instrument_family: metadata.familyIndex,
      instrument_family_str: metadata.family,
    };
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (JSON.stringify(entry[key]) !== JSON.stringify(expectedValue)) {
        throw new Error(`${control.id}: NSynth examples metadata ${key} drifted`);
      }
    }
  }
}

function storeControl(
  repositoryRoot: string,
  outputDirectory: string,
  manifest: NsynthFamilyControlManifest,
  control: NsynthFamilyControl,
  bytes: Buffer
): NsynthHydrationRecord {
  validateNsynthWav(bytes, control);
  const destination = nsynthFamilyControlPath(repositoryRoot, manifest, control);
  if (existsSync(destination)) return verifyExistingControl(repositoryRoot, manifest, control);
  const temporaryPath = resolve(
    outputDirectory,
    `.${control.localFile}.${randomUUID()}.partial`
  );
  writeFileSync(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
  try {
    const temporaryFd = openSync(temporaryPath, 'r');
    try {
      fsyncSync(temporaryFd);
    } finally {
      closeSync(temporaryFd);
    }
    try {
      linkSync(temporaryPath, destination);
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
    return {
      id: control.id,
      state: 'downloaded',
      bytes: bytes.byteLength,
      sha256: control.media.sha256,
      path: `${manifest.archive.outputDirectory}/${control.localFile}`,
      datasetFamily: control.metadata.family,
      datasetSource: control.metadata.source,
      exactInstrumentClaim: false,
    };
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export async function hydrateNsynthFamilyControls(
  options: HydrateNsynthFamilyControlsOptions = {}
): Promise<NsynthHydrationRecord[]> {
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const manifest = options.manifest ?? loadNsynthFamilyControlManifest(repositoryRoot);
  const outputDirectory = ensureDirectoryTree(repositoryRoot, manifest.archive.outputDirectory);
  const existing = new Map<string, NsynthHydrationRecord>();
  for (const control of manifest.controls) {
    const path = nsynthFamilyControlPath(repositoryRoot, manifest, control);
    if (existsSync(path)) existing.set(control.id, verifyExistingControl(repositoryRoot, manifest, control));
  }
  if (existing.size === manifest.controls.length) {
    return manifest.controls.map(({ id }) => existing.get(id)!);
  }
  if (options.verifyOnly) {
    throw new Error('one or more pinned NSynth controls are unavailable for offline verification');
  }

  const temporaryDirectory = mkdtempSync(joinSafeTempPrefix());
  try {
    const archivePath = options.archivePath
      ? resolve(options.archivePath)
      : resolve(temporaryDirectory, 'nsynth-test.jsonwav.tar.gz');
    if (!options.archivePath) {
      await downloadArchive(
        archivePath,
        manifest,
        options.fetchImplementation ?? fetch
      );
    }
    await verifyArchiveFile(archivePath, manifest);
    const extracted = await extractPinnedNsynthMembers(archivePath, manifest);
    const examples = extracted.members.get(manifest.archive.examplesMember)!;
    validateExamplesMetadata(examples, manifest);
    const results: NsynthHydrationRecord[] = [];
    for (const control of manifest.controls) {
      const previous = existing.get(control.id);
      results.push(
        previous ??
          storeControl(
            repositoryRoot,
            outputDirectory,
            manifest,
            control,
            extracted.members.get(control.archiveMember)!
          )
      );
    }
    return results;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function joinSafeTempPrefix(): string {
  const root = tmpdir();
  const metadata = lstatSync(root);
  if (!metadata.isDirectory()) throw new Error('temporary directory is unavailable');
  return resolve(root, 'stem-splitter-nsynth-');
}

function parseArguments(args: string[]): { archivePath?: string; verifyOnly: boolean } {
  let archivePath: string | undefined;
  let verifyOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--verify-only') {
      if (verifyOnly) throw new Error('--verify-only may be specified once');
      verifyOnly = true;
    } else if (argument === '--archive') {
      const value = args[++index];
      if (!value || value.startsWith('--') || archivePath) {
        throw new Error('--archive requires one path');
      }
      archivePath = value;
    } else {
      throw new Error(`unknown NSynth hydration argument: ${argument}`);
    }
  }
  if (verifyOnly && archivePath) throw new Error('--verify-only and --archive are mutually exclusive');
  return { archivePath, verifyOnly };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const manifest = loadNsynthFamilyControlManifest(REPOSITORY_ROOT);
  const records = await hydrateNsynthFamilyControls({
    repositoryRoot: REPOSITORY_ROOT,
    manifest,
    archivePath: args.archivePath,
    verifyOnly: args.verifyOnly,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        $schema: HYDRATION_SCHEMA,
        version: manifest.version,
        reviewStatus: manifest.reviewStatus,
        exactInstrumentClaims: false,
        controls: records,
      },
      null,
      2
    )}\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'NSynth family control hydration failed'}\n`
    );
    process.exitCode = 1;
  });
}
