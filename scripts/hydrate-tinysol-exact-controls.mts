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
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';

import {
  TINYSOL_ARCHIVE_URL,
  TINYSOL_EXACT_CONTROL_OUTPUT_DIRECTORY,
  TINYSOL_METADATA_COLUMNS,
  TINYSOL_METADATA_URL,
  loadTinySolExactControlManifest,
  tinySolExactControlPath,
  type TinySolExactControl,
  type TinySolExactControlManifest,
} from './lib/tinysol-exact-control-corpus.mts';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HYDRATION_SCHEMA = 'stem-splitter.tinysol-exact-control-hydration.v1';
const TAR_BLOCK_BYTES = 512;
const WAV_MEMBER = /^\.\/(?:Brass|Keyboards|Strings|Winds)\/[^/]+\/ordinario\/[^/]+\.wav$/;
const AUXILIARY_MEMBER = /^\.\/(?:[^/]+\/)*\.DS_Store$/;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

interface PinnedObject {
  name: 'metadata' | 'archive';
  url: string;
  bytes: number;
  md5: string;
  sha256: string;
  contentType: string;
  contentDisposition: string;
}

interface TarMemberState {
  name: string;
  size: number;
  remaining: number;
  padding: number;
  capture: boolean;
  capturedBytes: number;
  chunks: Buffer[];
}

interface ExtractedArchive {
  members: Map<string, Buffer>;
  memberCount: number;
  wavMemberCount: number;
}

export interface TinySolHydrationRecord {
  id: string;
  state: 'downloaded' | 'verified';
  bytes: number;
  sha256: string;
  path: string;
  datasetInstrument: TinySolExactControl['datasetInstrument'];
  vocabularyId: TinySolExactControl['vocabularyId'];
  exactInstrumentClaim: 'dataset-authored-source-label';
}

export interface HydrateTinySolExactControlsOptions {
  repositoryRoot?: string;
  manifest?: TinySolExactControlManifest;
  archivePath?: string;
  metadataPath?: string;
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

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new Error('TinySOL object write made no progress');
    offset += written;
  }
}

function ensureDirectoryTree(repositoryRoot: string, relativeDirectory: string): string {
  const root = resolve(repositoryRoot);
  const rootMetadata = lstatSync(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error('TinySOL repository root is not a regular directory');
  }
  const components = relativeDirectory.split('/');
  if (
    components.length < 2 ||
    components.some((component) => !component || component === '.' || component === '..')
  ) {
    throw new Error('TinySOL output directory is invalid');
  }
  let current = root;
  for (const component of components) {
    current = resolve(current, component);
    if (!current.startsWith(`${root}${sep}`)) throw new Error('TinySOL output directory escaped the repository');
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('TinySOL output directory contains a symlink or non-directory');
    }
  }
  return current;
}

function validateTinySolWav(bytes: Buffer, control: TinySolExactControl): void {
  if (bytes.byteLength !== control.media.bytes || sha256Bytes(bytes) !== control.media.sha256) {
    throw new Error(`${control.id}: TinySOL WAV bytes do not match the media pin`);
  }
  if (
    bytes.byteLength < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.readUInt32LE(4) + 8 !== bytes.byteLength || bytes.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error(`${control.id}: TinySOL WAV container contract drifted`);
  }
  const chunks: Array<{ id: string; size: number; offset: number }> = [];
  let offset = 12;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new Error(`${control.id}: TinySOL WAV chunk header is truncated`);
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const next = dataOffset + size + (size % 2);
    if (next > bytes.byteLength) throw new Error(`${control.id}: TinySOL WAV chunk escaped the file`);
    chunks.push({ id, size, offset: dataOffset });
    offset = next;
  }
  if (offset !== bytes.byteLength || chunks.length !== 2 || chunks[0].id !== 'fmt ' || chunks[1].id !== 'data') {
    throw new Error(`${control.id}: TinySOL WAV chunk surface drifted`);
  }
  const format = chunks[0];
  const data = chunks[1];
  if (
    format.size !== 16 || bytes.readUInt16LE(format.offset) !== 1 ||
    bytes.readUInt16LE(format.offset + 2) !== control.media.channels ||
    bytes.readUInt32LE(format.offset + 4) !== control.media.sampleRate ||
    bytes.readUInt32LE(format.offset + 8) !== 88_200 ||
    bytes.readUInt16LE(format.offset + 12) !== 2 ||
    bytes.readUInt16LE(format.offset + 14) !== control.media.bitsPerSample ||
    data.size !== control.media.dataBytes || data.size / 2 !== control.media.frameCount
  ) {
    throw new Error(`${control.id}: TinySOL WAV PCM contract drifted`);
  }
}

function verifyExistingControl(
  repositoryRoot: string,
  manifest: TinySolExactControlManifest,
  control: TinySolExactControl
): TinySolHydrationRecord {
  const path = tinySolExactControlPath(repositoryRoot, manifest, control);
  let bytes: Buffer;
  try {
    const metadata = lstatSync(path);
    if (
      metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== control.media.bytes ||
      (metadata.mode & 0o777) !== 0o600
    ) {
      throw new Error('not the pinned owner-only regular file');
    }
    bytes = readFileSync(path);
    validateTinySolWav(bytes, control);
  } catch {
    throw new Error(`${control.id}: existing TinySOL control is not the pinned owner-only WAV`);
  }
  return {
    id: control.id,
    state: 'verified',
    bytes: bytes.byteLength,
    sha256: control.media.sha256,
    path: `${manifest.archive.outputDirectory}/${control.localFile}`,
    datasetInstrument: control.datasetInstrument,
    vocabularyId: control.vocabularyId,
    exactInstrumentClaim: 'dataset-authored-source-label',
  };
}

function exactSourceUrl(object: PinnedObject): URL {
  const url = new URL(object.url);
  const expectedPath = object.name === 'archive'
    ? '/api/records/3685367/files/TinySOL.tar.gz/content'
    : '/api/records/3685367/files/TinySOL_metadata.csv/content';
  if (
    url.protocol !== 'https:' || url.hostname !== 'zenodo.org' || url.pathname !== expectedPath ||
    url.username || url.password || url.port || url.search || url.hash ||
    (object.name === 'archive' ? object.url !== TINYSOL_ARCHIVE_URL : object.url !== TINYSOL_METADATA_URL)
  ) {
    throw new Error(`TinySOL ${object.name} URL escaped the pinned Zenodo object`);
  }
  return url;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is cleanup only; validation failures remain authoritative.
  }
}

async function downloadPinnedObject(
  destination: string,
  object: PinnedObject,
  timeoutMs: number,
  fetchImplementation: FetchImplementation
): Promise<void> {
  const url = exactSourceUrl(object);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let fd: number | undefined;
  let completed = false;
  try {
    const response = await fetchImplementation(url, {
      redirect: 'manual',
      signal: abort.signal,
      headers: {
        accept: object.contentType,
        'accept-encoding': 'identity',
        'user-agent': 'stem-splitter-tinysol-hydrator/1',
      },
    });
    const contentLength = response.headers.get('content-length');
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    const contentEncoding = response.headers.get('content-encoding');
    if (
      response.status !== 200 || !response.body || contentType !== object.contentType ||
      response.headers.get('content-disposition') !== object.contentDisposition ||
      (contentEncoding !== null && contentEncoding.toLowerCase() !== 'identity') ||
      contentLength === null || !/^\d+$/.test(contentLength) || Number(contentLength) !== object.bytes
    ) {
      await cancelBody(response);
      throw new Error(`TinySOL ${object.name} response does not match the pinned object`);
    }
    fd = openSync(destination, 'wx', 0o600);
    const sha256 = createHash('sha256');
    const md5 = createHash('md5');
    const reader = response.body.getReader();
    let received = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        if (!item.value?.byteLength) continue;
        received += item.value.byteLength;
        if (received > object.bytes) throw new Error(`TinySOL ${object.name} body exceeded its byte pin`);
        sha256.update(item.value);
        md5.update(item.value);
        writeAll(fd, item.value);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // A consumed stream may reject cancellation; descriptor cleanup still runs.
      }
    }
    if (
      received !== object.bytes || sha256.digest('hex') !== object.sha256 || md5.digest('hex') !== object.md5
    ) {
      throw new Error(`TinySOL ${object.name} bytes do not match the content pins`);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    completed = true;
  } catch (error) {
    if (abort.signal.aborted) throw new Error(`TinySOL ${object.name} hydration timed out`);
    throw error;
  } finally {
    clearTimeout(timer);
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Preserve the primary failure. */ }
    }
    if (!completed && existsSync(destination)) {
      try { unlinkSync(destination); } catch { /* Private temp cleanup is the final boundary. */ }
    }
  }
}

async function verifyPinnedFile(path: string, object: PinnedObject): Promise<void> {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== object.bytes) {
    throw new Error(`TinySOL ${object.name} is not the pinned regular file`);
  }
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  let bytes = 0;
  for await (const raw of createReadStream(path)) {
    const chunk = Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > object.bytes) throw new Error(`TinySOL ${object.name} exceeded its byte pin`);
    sha256.update(chunk);
    md5.update(chunk);
  }
  if (bytes !== object.bytes || sha256.digest('hex') !== object.sha256 || md5.digest('hex') !== object.md5) {
    throw new Error(`TinySOL ${object.name} file does not match its digest pins`);
  }
}

function metadataObject(manifest: TinySolExactControlManifest): PinnedObject {
  return { name: 'metadata', ...manifest.metadata };
}

function archiveObject(manifest: TinySolExactControlManifest): PinnedObject {
  return { name: 'archive', ...manifest.archive };
}

function validateMetadataCsv(bytes: Buffer, manifest: TinySolExactControlManifest): void {
  const object = metadataObject(manifest);
  if (
    bytes.byteLength !== object.bytes || sha256Bytes(bytes) !== object.sha256 ||
    createHash('md5').update(bytes).digest('hex') !== object.md5
  ) {
    throw new Error('TinySOL metadata bytes do not match the content pins');
  }
  const text = bytes.toString('utf8');
  if (
    Buffer.from(text, 'utf8').byteLength !== bytes.byteLength || text.startsWith('\uFEFF') ||
    !text.endsWith('\r\n') || /(^|[^\r])\n/.test(text) || text.includes('\0') || text.includes('"')
  ) {
    throw new Error('TinySOL metadata CSV encoding or line endings drifted');
  }
  const lines = text.slice(0, -2).split('\r\n');
  if (lines.length !== manifest.metadata.rowCount + 1) {
    throw new Error('TinySOL metadata row count drifted');
  }
  const header = lines[0].split(',');
  if (JSON.stringify(header) !== JSON.stringify(TINYSOL_METADATA_COLUMNS)) {
    throw new Error('TinySOL metadata column surface drifted');
  }
  const rows = new Map<string, string[]>();
  for (let index = 1; index < lines.length; index += 1) {
    const fields = lines[index].split(',');
    if (fields.length !== header.length) throw new Error(`TinySOL metadata row ${index} is malformed`);
    const path = fields[0];
    if (
      !path || path.startsWith('/') || path.includes('\\') ||
      path.split('/').some((part) => !part || part === '.' || part === '..') || rows.has(path)
    ) {
      throw new Error(`TinySOL metadata row ${index} has an unsafe or duplicate path`);
    }
    rows.set(path, fields);
  }
  for (const control of manifest.controls) {
    const metadata = control.metadata;
    const expected = [
      control.sourcePath,
      String(metadata.fold),
      metadata.family,
      metadata.instrumentAbbreviation,
      control.datasetInstrument,
      metadata.techniqueAbbreviation,
      metadata.technique,
      metadata.pitch,
      String(metadata.pitchId),
      metadata.dynamics,
      String(metadata.dynamicsId),
      String(metadata.instanceId),
      metadata.stringId === null ? '' : `${metadata.stringId}.0`,
      'FALSE',
    ];
    if (JSON.stringify(rows.get(control.sourcePath)) !== JSON.stringify(expected)) {
      throw new Error(`${control.id}: TinySOL metadata row drifted`);
    }
    const candidates = [...rows.values()]
      .filter((row) =>
        row[4] === control.datasetInstrument && row[5] === 'ord' && row[6] === 'ordinario' &&
        row[7] === 'C4' && row[8] === '60' && row[9] === 'mf' && row[10] === '2' && row[13] === 'FALSE'
      )
      .sort((left, right) => Number(left[11]) - Number(right[11]) || left[0].localeCompare(right[0]));
    if (!candidates.length || candidates[0][0] !== control.sourcePath) {
      throw new Error(`${control.id}: TinySOL deterministic selection no longer resolves to the pinned row`);
    }
  }
}

function tarString(block: Buffer, start: number, length: number): string {
  const end = block.indexOf(0, start);
  const sliceEnd = end >= start && end < start + length ? end : start + length;
  const value = block.toString('utf8', start, sliceEnd);
  if (!value || /[^\x20-\x7e]/.test(value)) throw new Error('TinySOL tar header text is invalid');
  return value;
}

function tarOctal(block: Buffer, start: number, length: number, context: string): number {
  const raw = block.toString('ascii', start, start + length).replace(/\0.*$/s, '').trim();
  if (!/^[0-7]+$/.test(raw)) throw new Error(`TinySOL tar ${context} is invalid`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`TinySOL tar ${context} is invalid`);
  return value;
}

function parseTarHeader(block: Buffer): { name: string; size: number; type: string } {
  const expectedChecksum = tarOctal(block, 148, 8, 'checksum');
  let actualChecksum = 0;
  for (let index = 0; index < block.byteLength; index += 1) {
    actualChecksum += index >= 148 && index < 156 ? 32 : block[index];
  }
  if (actualChecksum !== expectedChecksum) throw new Error('TinySOL tar checksum does not match');
  const magic = block.toString('ascii', 257, 263);
  if (magic !== 'ustar\0' && magic !== 'ustar ') throw new Error('TinySOL tar header is not ustar');
  const name = tarString(block, 0, 100);
  const prefixBytes = block.subarray(345, 500);
  const prefix = prefixBytes.every((byte) => byte === 0) ? '' : tarString(block, 345, 155);
  const fullName = prefix ? `${prefix}/${name}` : name;
  const pathParts = fullName === './'
    ? []
    : fullName.replace(/\/$/, '').split('/').slice(1);
  if (
    (fullName !== './' && !fullName.startsWith('./')) || fullName.includes('\\') ||
    pathParts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('TinySOL tar member path is unsafe');
  }
  return {
    name: fullName,
    size: tarOctal(block, 124, 12, 'member size'),
    type: String.fromCharCode(block[156] || 48),
  };
}

function surfaceName(name: string, type: string): string {
  if (name === './') return '.';
  return type === '5' && name.endsWith('/') ? name.slice(0, -1) : name;
}

export async function extractPinnedTinySolMembers(
  archivePath: string,
  manifest: TinySolExactControlManifest
): Promise<ExtractedArchive> {
  const captureNames = new Set(manifest.controls.map(({ archiveMember }) => archiveMember));
  const captured = new Map<string, Buffer>();
  const seen = new Set<string>();
  const surface = createHash('sha256');
  let pending = Buffer.alloc(0);
  let current: TarMemberState | null = null;
  let memberCount = 0;
  let directoryMemberCount = 0;
  let wavMemberCount = 0;
  let auxiliaryFileCount = 0;
  let zeroBlocks = 0;
  let decodedBytes = 0;

  const decoded = createReadStream(archivePath).pipe(createGunzip());
  for await (const rawChunk of decoded) {
    const chunk = Buffer.from(rawChunk);
    decodedBytes += chunk.byteLength;
    if (decodedBytes > manifest.archive.decodedBytes) {
      throw new Error('TinySOL tar stream exceeded its decoded byte pin');
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
            throw new Error(`TinySOL tar padding is nonzero for ${current.name}`);
          }
          pending = pending.subarray(current.padding);
          current.padding = 0;
        }
        if (current.capture) {
          if (current.capturedBytes !== current.size) {
            throw new Error(`TinySOL tar capture is incomplete for ${current.name}`);
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
      if (zeroBlocks > 0) throw new Error('TinySOL tar has data after its end marker');
      const parsed = parseTarHeader(header);
      if (seen.has(parsed.name)) throw new Error(`TinySOL tar repeats ${parsed.name}`);
      seen.add(parsed.name);
      memberCount += 1;
      surface.update(`${parsed.type}\0${surfaceName(parsed.name, parsed.type)}\0${parsed.size}\n`);

      if (parsed.type === '5') {
        if (parsed.size !== 0 || !parsed.name.endsWith('/')) {
          throw new Error(`TinySOL tar directory contract drifted for ${parsed.name}`);
        }
        directoryMemberCount += 1;
      } else if (parsed.type === '0') {
        if (WAV_MEMBER.test(parsed.name)) {
          if (parsed.size < 44 || parsed.size > 2_000_000) {
            throw new Error(`TinySOL WAV member size is invalid for ${parsed.name}`);
          }
          wavMemberCount += 1;
        } else if (AUXILIARY_MEMBER.test(parsed.name)) {
          if (parsed.size < 1 || parsed.size > 64 * 1024) {
            throw new Error(`TinySOL auxiliary member size is invalid for ${parsed.name}`);
          }
          auxiliaryFileCount += 1;
        } else {
          throw new Error(`TinySOL tar contains an unexpected file ${parsed.name}`);
        }
      } else {
        throw new Error(`TinySOL tar contains unsupported member type ${parsed.type}`);
      }
      const capture = captureNames.has(parsed.name);
      const selected = capture
        ? manifest.controls.find(({ archiveMember }) => archiveMember === parsed.name)
        : undefined;
      if (selected && parsed.size !== selected.media.bytes) {
        throw new Error(`${selected.id}: TinySOL tar member size drifted`);
      }
      current = {
        name: parsed.name,
        size: parsed.size,
        remaining: parsed.size,
        padding: (TAR_BLOCK_BYTES - (parsed.size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES,
        capture,
        capturedBytes: 0,
        chunks: [],
      };
    }
  }
  if (
    current || pending.byteLength !== 0 || zeroBlocks < 2 ||
    decodedBytes !== manifest.archive.decodedBytes || memberCount !== manifest.archive.memberCount ||
    directoryMemberCount !== manifest.archive.directoryMemberCount ||
    wavMemberCount !== manifest.archive.wavMemberCount ||
    auxiliaryFileCount !== manifest.archive.auxiliaryFileCount ||
    surface.digest('hex') !== manifest.archive.surfaceSha256 || captured.size !== captureNames.size
  ) {
    throw new Error('TinySOL tar surface does not match the pinned archive');
  }
  for (const name of captureNames) {
    if (!captured.has(name)) throw new Error(`TinySOL tar omitted selected member ${name}`);
  }
  return { members: captured, memberCount, wavMemberCount };
}

function storeControl(
  repositoryRoot: string,
  outputDirectory: string,
  manifest: TinySolExactControlManifest,
  control: TinySolExactControl,
  bytes: Buffer
): TinySolHydrationRecord {
  validateTinySolWav(bytes, control);
  const destination = tinySolExactControlPath(repositoryRoot, manifest, control);
  if (existsSync(destination)) return verifyExistingControl(repositoryRoot, manifest, control);
  const temporaryPath = resolve(outputDirectory, `.${control.localFile}.${randomUUID()}.partial`);
  writeFileSync(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
  try {
    const temporaryFd = openSync(temporaryPath, 'r');
    try { fsyncSync(temporaryFd); } finally { closeSync(temporaryFd); }
    try {
      linkSync(temporaryPath, destination);
    } catch (error) {
      if (filesystemErrorCode(error) !== 'EEXIST') throw error;
      return verifyExistingControl(repositoryRoot, manifest, control);
    }
    const directoryFd = openSync(outputDirectory, 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    return {
      id: control.id,
      state: 'downloaded',
      bytes: bytes.byteLength,
      sha256: control.media.sha256,
      path: `${manifest.archive.outputDirectory}/${control.localFile}`,
      datasetInstrument: control.datasetInstrument,
      vocabularyId: control.vocabularyId,
      exactInstrumentClaim: 'dataset-authored-source-label',
    };
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function safeTemporaryPrefix(): string {
  const root = tmpdir();
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('TinySOL temporary directory is unavailable');
  }
  return resolve(root, 'stem-splitter-tinysol-');
}

function validateLocalSourcePair(archivePath?: string, metadataPath?: string): void {
  if (Boolean(archivePath) !== Boolean(metadataPath)) {
    throw new Error('--archive and --metadata must be supplied together');
  }
}

export async function hydrateTinySolExactControls(
  options: HydrateTinySolExactControlsOptions = {}
): Promise<TinySolHydrationRecord[]> {
  validateLocalSourcePair(options.archivePath, options.metadataPath);
  if (options.verifyOnly && (options.archivePath || options.metadataPath)) {
    throw new Error('--verify-only cannot be combined with --archive or --metadata');
  }
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const manifest = options.manifest ?? loadTinySolExactControlManifest(repositoryRoot);
  if (manifest.archive.outputDirectory !== TINYSOL_EXACT_CONTROL_OUTPUT_DIRECTORY) {
    throw new Error('TinySOL output directory drifted');
  }
  const outputDirectory = ensureDirectoryTree(repositoryRoot, manifest.archive.outputDirectory);
  const existing = new Map<string, TinySolHydrationRecord>();
  for (const control of manifest.controls) {
    const path = tinySolExactControlPath(repositoryRoot, manifest, control);
    if (existsSync(path)) existing.set(control.id, verifyExistingControl(repositoryRoot, manifest, control));
  }
  if (existing.size === manifest.controls.length) {
    return manifest.controls.map(({ id }) => existing.get(id)!);
  }
  if (options.verifyOnly) {
    throw new Error('one or more pinned TinySOL controls are unavailable for offline verification');
  }

  const temporaryDirectory = mkdtempSync(safeTemporaryPrefix());
  try {
    const metadataPath = options.metadataPath
      ? resolve(options.metadataPath)
      : resolve(temporaryDirectory, 'TinySOL_metadata.csv');
    const archivePath = options.archivePath
      ? resolve(options.archivePath)
      : resolve(temporaryDirectory, 'TinySOL.tar.gz');
    if (!options.metadataPath) {
      await downloadPinnedObject(
        metadataPath,
        metadataObject(manifest),
        manifest.archive.requestTimeoutMs,
        options.fetchImplementation ?? fetch
      );
    }
    await verifyPinnedFile(metadataPath, metadataObject(manifest));
    validateMetadataCsv(readFileSync(metadataPath), manifest);
    if (!options.archivePath) {
      await downloadPinnedObject(
        archivePath,
        archiveObject(manifest),
        manifest.archive.requestTimeoutMs,
        options.fetchImplementation ?? fetch
      );
    }
    await verifyPinnedFile(archivePath, archiveObject(manifest));
    const extracted = await extractPinnedTinySolMembers(archivePath, manifest);
    const results: TinySolHydrationRecord[] = [];
    for (const control of manifest.controls) {
      results.push(
        existing.get(control.id) ??
        storeControl(repositoryRoot, outputDirectory, manifest, control, extracted.members.get(control.archiveMember)!)
      );
    }
    return results.map((record) => ({
      ...record,
      path: relative(repositoryRoot, resolve(repositoryRoot, record.path)),
    }));
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseArguments(args: string[]): {
  archivePath?: string;
  metadataPath?: string;
  verifyOnly: boolean;
} {
  let archivePath: string | undefined;
  let metadataPath: string | undefined;
  let verifyOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--verify-only') {
      if (verifyOnly) throw new Error('--verify-only may be specified once');
      verifyOnly = true;
    } else if (argument === '--archive' || argument === '--metadata') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires one path`);
      if (argument === '--archive') {
        if (archivePath) throw new Error('--archive may be specified once');
        archivePath = value;
      } else {
        if (metadataPath) throw new Error('--metadata may be specified once');
        metadataPath = value;
      }
    } else {
      throw new Error(`unknown TinySOL hydration argument: ${argument}`);
    }
  }
  validateLocalSourcePair(archivePath, metadataPath);
  if (verifyOnly && (archivePath || metadataPath)) {
    throw new Error('--verify-only cannot be combined with --archive or --metadata');
  }
  return { archivePath, metadataPath, verifyOnly };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const manifest = loadTinySolExactControlManifest(REPOSITORY_ROOT);
  const controls = await hydrateTinySolExactControls({
    repositoryRoot: REPOSITORY_ROOT,
    manifest,
    archivePath: args.archivePath,
    metadataPath: args.metadataPath,
    verifyOnly: args.verifyOnly,
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
    process.stderr.write(`${error instanceof Error ? error.message : 'TinySOL hydration failed'}\n`);
    process.exitCode = 1;
  });
}
