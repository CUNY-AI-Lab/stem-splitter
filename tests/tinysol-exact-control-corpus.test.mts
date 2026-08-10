import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  hydrateTinySolExactControls,
} from '../scripts/hydrate-tinysol-exact-controls.mts';
import {
  TINYSOL_ARCHIVE_BYTES,
  TINYSOL_ARCHIVE_MD5,
  TINYSOL_ARCHIVE_SHA256,
  TINYSOL_ARCHIVE_URL,
  TINYSOL_EXACT_CONTROL_MANIFEST_PATH,
  TINYSOL_EXACT_CONTROL_OUTPUT_DIRECTORY,
  TINYSOL_METADATA_COLUMNS,
  TINYSOL_METADATA_MD5,
  TINYSOL_METADATA_SHA256,
  TINYSOL_METADATA_URL,
  loadTinySolExactControlManifest,
  validateTinySolExactControlManifestForRepository,
  type TinySolExactControl,
  type TinySolExactControlManifest,
} from '../scripts/lib/tinysol-exact-control-corpus.mts';

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

interface Fixture {
  manifest: TinySolExactControlManifest;
  metadata: Buffer;
  archive: Buffer;
  wav: Buffer;
}

interface ExtraMember {
  name: string;
  bytes: Buffer;
  type?: '0' | '2' | '5';
}

interface FixtureOptions {
  wav?: Buffer;
  mutateMetadataRows?: (rows: string[][]) => void;
  extraMembers?: ExtraMember[];
  duplicateFirstControl?: boolean;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex');
}

function cloneManifest(): TinySolExactControlManifest {
  return structuredClone(loadTinySolExactControlManifest(repositoryRoot));
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

function tarMember(name: string, bytes: Buffer, type: '0' | '2' | '5' = '0'): Buffer {
  assert.ok(Buffer.byteLength(name) <= 100);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, type === '5' ? 0o700 : 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, type === '5' ? 0 : bytes.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  const payload = type === '5' ? Buffer.alloc(0) : bytes;
  const padding = Buffer.alloc((512 - (payload.byteLength % 512)) % 512);
  return Buffer.concat([header, payload, padding]);
}

function makeWav(): Buffer {
  const wav = Buffer.alloc(128_044);
  wav.write('RIFF', 0, 4, 'ascii');
  wav.writeUInt32LE(128_036, 4);
  wav.write('WAVE', 8, 4, 'ascii');
  wav.write('fmt ', 12, 4, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(44_100, 24);
  wav.writeUInt32LE(88_200, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 4, 'ascii');
  wav.writeUInt32LE(128_000, 40);
  for (let offset = 44; offset < wav.byteLength; offset += 2) {
    wav.writeInt16LE(((offset * 97) % 32_768) - 16_384, offset);
  }
  return wav;
}

function metadataRow(control: TinySolExactControl): string[] {
  const metadata = control.metadata;
  return [
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
}

function surfaceEntry(name: string, size: number, type: string): string {
  const normalized = name === './' ? '.' : type === '5' && name.endsWith('/') ? name.slice(0, -1) : name;
  return `${type}\0${normalized}\0${size}\n`;
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  const manifest = cloneManifest() as any;
  const wav = options.wav ?? makeWav();
  for (const control of manifest.controls as TinySolExactControl[]) {
    control.media.bytes = wav.byteLength;
    control.media.sha256 = sha256(wav);
    control.media.dataBytes = wav.byteLength - 44;
    control.media.frameCount = (wav.byteLength - 44) / 2;
  }
  const rows = (manifest.controls as TinySolExactControl[]).map(metadataRow);
  options.mutateMetadataRows?.(rows);
  const metadata = Buffer.from(
    `${TINYSOL_METADATA_COLUMNS.join(',')}\r\n${rows.map((row) => row.join(',')).join('\r\n')}\r\n`
  );
  manifest.metadata.bytes = metadata.byteLength;
  manifest.metadata.md5 = md5(metadata);
  manifest.metadata.sha256 = sha256(metadata);
  manifest.metadata.rowCount = rows.length;

  const specs: Array<{ name: string; bytes: Buffer; type: '0' | '2' | '5' }> = [
    { name: './', bytes: Buffer.alloc(0), type: '5' },
    ...(manifest.controls as TinySolExactControl[]).map((control) => ({
      name: control.archiveMember,
      bytes: wav,
      type: '0' as const,
    })),
  ];
  if (options.duplicateFirstControl) specs.push({ ...specs[1] });
  for (const member of options.extraMembers ?? []) {
    specs.push({ name: member.name, bytes: member.bytes, type: member.type ?? '0' });
  }
  const decoded = Buffer.concat([
    ...specs.map(({ name, bytes, type }) => tarMember(name, bytes, type)),
    Buffer.alloc(1024),
  ]);
  const archive = gzipSync(decoded);
  const surface = createHash('sha256');
  for (const { name, bytes, type } of specs) {
    surface.update(surfaceEntry(name, type === '5' ? 0 : bytes.byteLength, type));
  }
  manifest.archive.bytes = archive.byteLength;
  manifest.archive.md5 = md5(archive);
  manifest.archive.sha256 = sha256(archive);
  manifest.archive.decodedBytes = decoded.byteLength;
  manifest.archive.memberCount = specs.length;
  manifest.archive.directoryMemberCount = specs.filter(({ type }) => type === '5').length;
  manifest.archive.wavMemberCount = specs.filter(({ name, type }) => type === '0' && name.endsWith('.wav')).length;
  manifest.archive.auxiliaryFileCount = specs.filter(({ name, type }) => type === '0' && name.endsWith('.DS_Store')).length;
  manifest.archive.surfaceSha256 = surface.digest('hex');
  return { manifest, metadata, archive, wav };
}

function responseHeaders(fixture: Fixture, kind: 'metadata' | 'archive'): Record<string, string> {
  const object = fixture.manifest[kind];
  return {
    'content-type': kind === 'metadata' ? `${object.contentType}; charset=utf-8` : object.contentType,
    'content-length': String(object.bytes),
    'content-disposition': object.contentDisposition,
  };
}

function fixtureFetch(
  fixture: Fixture,
  requests: Array<{ url: string; redirect?: string }> = []
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = String(input);
    requests.push({ url, redirect: init?.redirect });
    if (url === TINYSOL_METADATA_URL) {
      return new Response(fixture.metadata, { status: 200, headers: responseHeaders(fixture, 'metadata') });
    }
    if (url === TINYSOL_ARCHIVE_URL) {
      return new Response(fixture.archive, { status: 200, headers: responseHeaders(fixture, 'archive') });
    }
    throw new Error(`unexpected fixture URL: ${url}`);
  };
}

function withTemporaryRoot(run: (root: string) => Promise<void> | void): Promise<void> | void {
  const root = mkdtempSync(join(tmpdir(), 'stem-splitter-tinysol-test-'));
  try {
    const result = run(root);
    if (result instanceof Promise) return result.finally(() => rmSync(root, { recursive: true, force: true }));
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test('TinySOL controls pin v6 rights, exact labels, source bytes, and remaining gaps', () => {
  const manifest = loadTinySolExactControlManifest(repositoryRoot);
  assert.equal(manifest.dataset.version, '6.0');
  assert.equal(manifest.dataset.zenodoRecordId, '3685367');
  assert.equal(manifest.dataset.license, 'CC BY 4.0');
  assert.equal(manifest.archive.url, TINYSOL_ARCHIVE_URL);
  assert.equal(manifest.archive.bytes, TINYSOL_ARCHIVE_BYTES);
  assert.equal(manifest.archive.md5, TINYSOL_ARCHIVE_MD5);
  assert.equal(manifest.archive.sha256, TINYSOL_ARCHIVE_SHA256);
  assert.equal(manifest.metadata.url, TINYSOL_METADATA_URL);
  assert.equal(manifest.metadata.md5, TINYSOL_METADATA_MD5);
  assert.equal(manifest.metadata.sha256, TINYSOL_METADATA_SHA256);
  assert.deepEqual(
    manifest.controls.map(({ datasetInstrument, vocabularyId }) => [datasetInstrument, vocabularyId]),
    [
      ['Accordion', 'accordion'],
      ['Cello', 'cello'],
      ['Contrabass', 'double-bass'],
      ['Viola', 'viola'],
      ['Violin', 'violin'],
    ]
  );
  assert.ok(manifest.controls.every(({ metadata }) => metadata.neededDigitalRetuning === false));
  assert.equal(manifest.claimPolicy.exactInstrumentClaims, 'source-label-only');
  assert.equal(manifest.claimPolicy.candidateNegativeClaims, 'none');
  assert.equal(manifest.claimPolicy.currentEvaluationPlanUse, 'forbidden');
  assert.deepEqual(manifest.coverage.unfilledExactPositiveGroups, [
    'harmonica',
    'pitched-percussion',
    'traditional-instruments',
  ]);
});

test('TinySOL manifest rejects provenance, selection, mapping, media, and claim drift', () => {
  const raw = JSON.parse(readFileSync(TINYSOL_EXACT_CONTROL_MANIFEST_PATH, 'utf8')) as Record<string, any>;
  const mutations: Array<[string, (value: Record<string, any>) => void]> = [
    ['v3 record', (value) => { value.dataset.zenodoRecordId = '3633012'; }],
    ['license', (value) => { value.dataset.license = 'CC0'; }],
    ['archive URL', (value) => { value.archive.url = 'https://example.com/TinySOL.tar.gz'; }],
    ['archive hash', (value) => { value.archive.sha256 = '0'.repeat(64); }],
    ['metadata hash', (value) => { value.metadata.sha256 = '0'.repeat(64); }],
    ['selection', (value) => { value.selectionPolicy.neededDigitalRetuning = true; }],
    ['gap erasure', (value) => { value.coverage.unfilledExactPositiveGroups.pop(); }],
    ['negative claim', (value) => { value.claimPolicy.candidateNegativeClaims = 'all-omitted'; }],
    ['evaluation use', (value) => { value.claimPolicy.currentEvaluationPlanUse = 'allowed'; }],
    ['vocabulary mapping', (value) => { value.controls[2].vocabularyId = 'bass-guitar'; }],
    ['retuned control', (value) => { value.controls[0].metadata.neededDigitalRetuning = true; }],
    ['media pin', (value) => { value.controls[0].media.sha256 = '0'.repeat(64); }],
    ['unknown approval', (value) => { value.controls[0].teacherApproved = true; }],
  ];
  for (const [name, mutate] of mutations) {
    const candidate = structuredClone(raw);
    mutate(candidate);
    assert.throws(
      () => validateTinySolExactControlManifestForRepository(candidate, repositoryRoot),
      name
    );
  }
});

test('TinySOL hydrator verifies metadata before one archive request and stores owner-only WAVs', async () => {
  await withTemporaryRoot(async (root) => {
    const fixture = makeFixture();
    const requests: Array<{ url: string; redirect?: string }> = [];
    const records = await hydrateTinySolExactControls({
      repositoryRoot: root,
      manifest: fixture.manifest,
      fetchImplementation: fixtureFetch(fixture, requests),
    });
    assert.deepEqual(requests, [
      { url: TINYSOL_METADATA_URL, redirect: 'manual' },
      { url: TINYSOL_ARCHIVE_URL, redirect: 'manual' },
    ]);
    assert.equal(records.length, fixture.manifest.controls.length);
    assert.ok(records.every(({ state }) => state === 'downloaded'));
    assert.ok(records.every(({ exactInstrumentClaim }) => exactInstrumentClaim === 'dataset-authored-source-label'));
    const output = join(root, TINYSOL_EXACT_CONTROL_OUTPUT_DIRECTORY);
    assert.equal(readdirSync(output).length, fixture.manifest.controls.length);
    for (const control of fixture.manifest.controls) {
      const path = join(output, control.localFile);
      assert.equal(lstatSync(path).mode & 0o777, 0o600);
      assert.deepEqual(readFileSync(path), fixture.wav);
    }
    const verified = await hydrateTinySolExactControls({
      repositoryRoot: root,
      manifest: fixture.manifest,
      verifyOnly: true,
      fetchImplementation: async () => { throw new Error('verify-only reached the network'); },
    });
    assert.ok(verified.every(({ state }) => state === 'verified'));
  });
});

test('TinySOL hydrator accepts only a paired, pinned local archive and metadata file', async () => {
  await withTemporaryRoot(async (root) => {
    const fixture = makeFixture();
    const archivePath = join(root, 'TinySOL.tar.gz');
    const metadataPath = join(root, 'TinySOL_metadata.csv');
    writeFileSync(archivePath, fixture.archive);
    writeFileSync(metadataPath, fixture.metadata);
    const records = await hydrateTinySolExactControls({
      repositoryRoot: root,
      manifest: fixture.manifest,
      archivePath,
      metadataPath,
      fetchImplementation: async () => { throw new Error('local hydration reached the network'); },
    });
    assert.equal(records.length, 5);
    await assert.rejects(
      hydrateTinySolExactControls({
        repositoryRoot: root,
        manifest: fixture.manifest,
        archivePath,
      }),
      /supplied together/
    );
  });
});

test('TinySOL metadata drift fails before the archive is requested', async () => {
  await withTemporaryRoot(async (root) => {
    const fixture = makeFixture({
      mutateMetadataRows: (rows) => { rows[0][13] = 'TRUE'; },
    });
    const requests: string[] = [];
    await assert.rejects(
      hydrateTinySolExactControls({
        repositoryRoot: root,
        manifest: fixture.manifest,
        fetchImplementation: async (input, init) => {
          requests.push(String(input));
          return fixtureFetch(fixture)(input, init);
        },
      }),
      /metadata row drifted/
    );
    assert.deepEqual(requests, [TINYSOL_METADATA_URL]);
  });
});

test('TinySOL hydrator rejects redirects, response-header drift, and content drift', async () => {
  const fixture = makeFixture();
  await withTemporaryRoot(async (root) => {
    await assert.rejects(
      hydrateTinySolExactControls({
        repositoryRoot: root,
        manifest: fixture.manifest,
        fetchImplementation: async () => new Response(null, {
          status: 302,
          headers: { location: 'https://example.com/TinySOL_metadata.csv' },
        }),
      }),
      /pinned object/
    );
  });
  await withTemporaryRoot(async (root) => {
    await assert.rejects(
      hydrateTinySolExactControls({
        repositoryRoot: root,
        manifest: fixture.manifest,
        fetchImplementation: async () => new Response(fixture.metadata, {
          status: 200,
          headers: {
            ...responseHeaders(fixture, 'metadata'),
            'content-disposition': 'attachment; filename=changed.csv',
          },
        }),
      }),
      /pinned object/
    );
  });
  await withTemporaryRoot(async (root) => {
    const changed = Buffer.from(fixture.metadata);
    changed[changed.byteLength - 3] ^= 1;
    await assert.rejects(
      hydrateTinySolExactControls({
        repositoryRoot: root,
        manifest: fixture.manifest,
        fetchImplementation: async () => new Response(changed, {
          status: 200,
          headers: responseHeaders(fixture, 'metadata'),
        }),
      }),
      /content pins/
    );
  });
});

test('TinySOL download timeout aborts without leaving a partial object or corpus WAV', async () => {
  await withTemporaryRoot(async (root) => {
    const fixture = makeFixture();
    (fixture.manifest.archive as any).requestTimeoutMs = 5;
    await assert.rejects(
      hydrateTinySolExactControls({
        repositoryRoot: root,
        manifest: fixture.manifest,
        fetchImplementation: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('mock abort')), { once: true });
          }),
      }),
      /metadata hydration timed out/
    );
    assert.deepEqual(readdirSync(join(root, TINYSOL_EXACT_CONTROL_OUTPUT_DIRECTORY)), []);
  });
});

test('TinySOL archive parser rejects traversal, links, duplicates, and malformed selected WAVs', async () => {
  const cases: Array<[Fixture, RegExp]> = [
    [makeFixture({ extraMembers: [{ name: './../escape', bytes: Buffer.from('unsafe') }] }), /path is unsafe/],
    [makeFixture({ extraMembers: [{ name: './unsafe-link', bytes: Buffer.from('target'), type: '2' }] }), /unsupported member type/],
    [makeFixture({ duplicateFirstControl: true }), /repeats/],
    [makeFixture({ wav: (() => { const wav = makeWav(); wav.write('NOPE', 0, 4, 'ascii'); return wav; })() }), /WAV container contract/],
  ];
  for (const [fixture, expected] of cases) {
    await withTemporaryRoot(async (root) => {
      const archivePath = join(root, 'fixture.tar.gz');
      const metadataPath = join(root, 'fixture.csv');
      writeFileSync(archivePath, fixture.archive);
      writeFileSync(metadataPath, fixture.metadata);
      await assert.rejects(
        hydrateTinySolExactControls({
          repositoryRoot: root,
          manifest: fixture.manifest,
          archivePath,
          metadataPath,
        }),
        expected
      );
    });
  }
});

test('TinySOL hydrator rejects mismatched, relaxed-permission, and symlinked output', async () => {
  const fixture = makeFixture();
  await withTemporaryRoot(async (root) => {
    const destination = join(root, TINYSOL_EXACT_CONTROL_OUTPUT_DIRECTORY, fixture.manifest.controls[0].localFile);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, Buffer.alloc(fixture.wav.byteLength), { mode: 0o600 });
    await assert.rejects(
      hydrateTinySolExactControls({
        repositoryRoot: root,
        manifest: fixture.manifest,
        fetchImplementation: async () => { throw new Error('mismatched file reached network'); },
      }),
      /existing TinySOL control/
    );
  });
  await withTemporaryRoot(async (root) => {
    const destination = join(root, TINYSOL_EXACT_CONTROL_OUTPUT_DIRECTORY, fixture.manifest.controls[0].localFile);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, fixture.wav, { mode: 0o600 });
    chmodSync(destination, 0o644);
    await assert.rejects(
      hydrateTinySolExactControls({ repositoryRoot: root, manifest: fixture.manifest }),
      /owner-only/
    );
  });
  await withTemporaryRoot(async (root) => {
    const audioRoot = join(root, 'tests/corpus/audio');
    const outside = join(root, 'outside');
    mkdirSync(audioRoot, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(audioRoot, 'tinysol-exact-controls-v1'));
    await assert.rejects(
      hydrateTinySolExactControls({ repositoryRoot: root, manifest: fixture.manifest }),
      /symlink/
    );
  });
});

test('TinySOL hydration CLI rejects incomplete and ambiguous source modes before I/O', () => {
  const script = resolve(repositoryRoot, 'scripts/hydrate-tinysol-exact-controls.mts');
  const incomplete = spawnSync(
    process.execPath,
    ['--experimental-strip-types', script, '--archive', 'fixture.tar.gz'],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /supplied together/);
  const ambiguous = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types', script, '--verify-only', '--archive', 'fixture.tar.gz',
      '--metadata', 'fixture.csv',
    ],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /cannot be combined/);
  const unknown = spawnSync(
    process.execPath,
    ['--experimental-strip-types', script, '--unknown'],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown TinySOL hydration argument/);
});
