import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
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

import { hydrateNsynthFamilyControls } from '../scripts/hydrate-nsynth-family-controls.mts';
import {
  NSYNTH_ARCHIVE_BYTES,
  NSYNTH_ARCHIVE_SHA256,
  NSYNTH_ARCHIVE_URL,
  NSYNTH_FAMILY_CONTROL_MANIFEST_PATH,
  NSYNTH_FAMILY_CONTROL_OUTPUT_DIRECTORY,
  loadNsynthFamilyControlManifest,
  validateNsynthFamilyControlManifestForRepository,
  type NsynthFamilyControl,
  type NsynthFamilyControlManifest,
} from '../scripts/lib/nsynth-family-control-corpus.mts';

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

interface Fixture {
  manifest: NsynthFamilyControlManifest;
  archive: Buffer;
  wav: Buffer;
}

interface FixtureOptions {
  wav?: Buffer;
  mutateExamples?: (entry: Record<string, unknown>) => void;
  extraMember?: { name: string; bytes: Buffer };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function cloneManifest(): NsynthFamilyControlManifest {
  return structuredClone(loadNsynthFamilyControlManifest(repositoryRoot));
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`;
  header.write(encoded, offset, length, 'ascii');
}

function tarMember(name: string, bytes: Buffer, type: '0' | '5' = '0'): Buffer {
  assert.ok(Buffer.byteLength(name) <= 100);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, type === '5' ? 0o755 : 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, bytes.byteLength);
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
  const padding = Buffer.alloc((512 - (bytes.byteLength % 512)) % 512);
  return Buffer.concat([header, bytes, padding]);
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
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 4, 'ascii');
  wav.writeUInt32LE(128_000, 40);
  for (let offset = 44; offset < wav.byteLength; offset += 2) {
    wav.writeInt16LE(((offset * 97) % 32_768) - 16_384, offset);
  }
  return wav;
}

function exampleFor(control: NsynthFamilyControl): Record<string, unknown> {
  const metadata = control.metadata;
  return {
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
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  const manifest = cloneManifest() as any;
  const control = manifest.controls[0] as NsynthFamilyControl;
  const wav = options.wav ?? makeWav();
  control.media.sha256 = sha256(wav);
  manifest.controls = [control];

  const example = exampleFor(control);
  options.mutateExamples?.(example);
  const examples = Buffer.from(JSON.stringify({ [control.noteStr]: example }));
  const members = [
    tarMember('nsynth-test/', Buffer.alloc(0), '5'),
    tarMember('nsynth-test/audio/', Buffer.alloc(0), '5'),
    tarMember(control.archiveMember, wav),
    tarMember(manifest.archive.examplesMember, examples),
  ];
  if (options.extraMember) {
    members.push(tarMember(options.extraMember.name, options.extraMember.bytes));
  }
  const archive = gzipSync(Buffer.concat([...members, Buffer.alloc(1024)]));
  manifest.archive.memberCount = members.length;
  manifest.archive.audioMemberCount = 1;
  manifest.archive.examplesBytes = examples.byteLength;
  manifest.archive.examplesSha256 = sha256(examples);
  manifest.archive.bytes = archive.byteLength;
  manifest.archive.sha256 = sha256(archive);
  return { manifest, archive, wav };
}

function archiveHeaders(manifest: NsynthFamilyControlManifest): Record<string, string> {
  return {
    'content-type': manifest.archive.contentType,
    'content-length': String(manifest.archive.bytes),
    'x-goog-generation': manifest.archive.storageGeneration,
    etag: `"${manifest.archive.etag}"`,
    'last-modified': manifest.archive.lastModified,
  };
}

function withTemporaryRoot(run: (root: string) => Promise<void> | void): Promise<void> | void {
  const root = mkdtempSync(join(tmpdir(), 'stem-splitter-nsynth-controls-'));
  try {
    const result = run(root);
    if (result instanceof Promise) {
      return result.finally(() => rmSync(root, { recursive: true, force: true }));
    }
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test('NSynth controls pin rights, archive identity, family coverage, and claim boundaries', () => {
  const manifest = loadNsynthFamilyControlManifest(repositoryRoot);
  assert.equal(manifest.dataset.license, 'CC BY 4.0');
  assert.equal(manifest.dataset.recordingType, 'isolated-four-second-monophonic-note');
  assert.equal(manifest.archive.url, NSYNTH_ARCHIVE_URL);
  assert.equal(manifest.archive.bytes, NSYNTH_ARCHIVE_BYTES);
  assert.equal(manifest.archive.sha256, NSYNTH_ARCHIVE_SHA256);
  assert.equal(manifest.controls.length, 10);
  assert.deepEqual(
    manifest.controls.map(({ metadata }) => metadata.family),
    ['bass', 'brass', 'flute', 'guitar', 'keyboard', 'mallet', 'organ', 'reed', 'string', 'vocal']
  );
  assert.deepEqual(manifest.coverage.unavailableTestFamilies, ['synth_lead']);
  assert.deepEqual(manifest.coverage.selectedSourceCounts, {
    acoustic: 4,
    electronic: 3,
    synthetic: 3,
  });
  assert.equal(
    Object.values(manifest.coverage.testFamilyCounts).reduce((sum, count) => sum + count, 0),
    4096
  );
  assert.equal(
    Object.values(manifest.coverage.testSourceCounts).reduce((sum, count) => sum + count, 0),
    4096
  );
  assert.equal(manifest.claimPolicy.exactInstrumentClaims, false);
  assert.equal(manifest.claimPolicy.vocabularyPositiveClaims, 'none-before-teacher-listening');
  assert.equal(manifest.claimPolicy.candidateNegativeClaims, 'none');
  assert.equal(manifest.claimPolicy.mixedTrackUse, 'forbidden');
  assert.ok(manifest.controls.every((control) => !Object.hasOwn(control, 'positiveIds')));
});

test('NSynth manifest rejects provenance, family truth, media, and promotion drift', () => {
  const raw = JSON.parse(
    readFileSync(NSYNTH_FAMILY_CONTROL_MANIFEST_PATH, 'utf8')
  ) as Record<string, any>;
  const mutations: Array<[string, (value: Record<string, any>) => void]> = [
    ['archive URL', (value) => { value.archive.url = 'https://example.com/nsynth.tar.gz'; }],
    ['archive hash', (value) => { value.archive.sha256 = '0'.repeat(64); }],
    ['exact claim', (value) => { value.claimPolicy.exactInstrumentClaims = true; }],
    ['positive claim', (value) => { value.claimPolicy.vocabularyPositiveClaims = 'family-mapped'; }],
    ['negative claim', (value) => { value.claimPolicy.candidateNegativeClaims = 'all-omitted'; }],
    ['synth lead coverage', (value) => { value.coverage.availableTestFamilies.push('synth_lead'); }],
    ['family metadata', (value) => { value.controls[0].metadata.family = 'guitar'; }],
    ['media pin', (value) => { value.controls[0].media.sha256 = '0'.repeat(64); }],
    ['review state', (value) => { value.reviewStatus = 'teacher-reviewed'; }],
    ['unknown approval', (value) => { value.controls[0].teacherApproved = true; }],
  ];
  for (const [name, mutate] of mutations) {
    const candidate = structuredClone(raw);
    mutate(candidate);
    assert.throws(
      () => validateNsynthFamilyControlManifestForRepository(candidate, repositoryRoot),
      name
    );
  }
});

test('NSynth hydrator downloads one exact object, extracts selected WAVs, and verifies offline', async () => {
  await withTemporaryRoot(async (root) => {
    const fixture = makeFixture();
    const requests: Array<{ url: string; redirect?: string }> = [];
    const fetchImplementation = async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      requests.push({ url: String(input), redirect: init?.redirect });
      return new Response(fixture.archive, {
        status: 200,
        headers: archiveHeaders(fixture.manifest),
      });
    };
    const hydrated = await hydrateNsynthFamilyControls({
      repositoryRoot: root,
      manifest: fixture.manifest,
      fetchImplementation,
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, NSYNTH_ARCHIVE_URL);
    assert.equal(requests[0].redirect, 'manual');
    assert.deepEqual(hydrated, [
      {
        id: fixture.manifest.controls[0].id,
        state: 'downloaded',
        bytes: fixture.wav.byteLength,
        sha256: sha256(fixture.wav),
        path: `${NSYNTH_FAMILY_CONTROL_OUTPUT_DIRECTORY}/${fixture.manifest.controls[0].localFile}`,
        datasetFamily: 'bass',
        datasetSource: 'synthetic',
        exactInstrumentClaim: false,
      },
    ]);
    const outputDirectory = join(root, NSYNTH_FAMILY_CONTROL_OUTPUT_DIRECTORY);
    const destination = join(outputDirectory, fixture.manifest.controls[0].localFile);
    assert.deepEqual(readFileSync(destination), fixture.wav);
    assert.equal(lstatSync(destination).mode & 0o777, 0o600);
    assert.equal(readdirSync(outputDirectory).some((name) => name.endsWith('.partial')), false);

    const verified = await hydrateNsynthFamilyControls({
      repositoryRoot: root,
      manifest: fixture.manifest,
      verifyOnly: true,
      fetchImplementation: async () => {
        throw new Error('offline verification must not use the network');
      },
    });
    assert.equal(verified[0].state, 'verified');
  });
});

test('NSynth hydrator accepts a pinned local archive without using the network', async () => {
  await withTemporaryRoot(async (root) => {
    const fixture = makeFixture();
    const archivePath = join(root, 'fixture.tar.gz');
    writeFileSync(archivePath, fixture.archive, { mode: 0o600 });
    const records = await hydrateNsynthFamilyControls({
      repositoryRoot: root,
      manifest: fixture.manifest,
      archivePath,
      fetchImplementation: async () => {
        throw new Error('local archive hydration must not use the network');
      },
    });
    assert.equal(records[0].state, 'downloaded');
  });
});

test('NSynth hydrator rejects redirect and immutable response-pin drift', async () => {
  const fixture = makeFixture();
  await withTemporaryRoot(async (root) => {
    await assert.rejects(
      hydrateNsynthFamilyControls({
        repositoryRoot: root,
        manifest: fixture.manifest,
        fetchImplementation: async () =>
          new Response(null, { status: 302, headers: { location: 'https://example.com/nsynth' } }),
      }),
      /pinned object/
    );
  });
  await withTemporaryRoot(async (root) => {
    const headers = archiveHeaders(fixture.manifest);
    headers['x-goog-generation'] = 'newer-object';
    await assert.rejects(
      hydrateNsynthFamilyControls({
        repositoryRoot: root,
        manifest: fixture.manifest,
        fetchImplementation: async () =>
          new Response(fixture.archive, { status: 200, headers }),
      }),
      /pinned object/
    );
  });
  await withTemporaryRoot(async (root) => {
    const changed = Buffer.from(fixture.archive);
    changed[changed.byteLength - 1] ^= 1;
    await assert.rejects(
      hydrateNsynthFamilyControls({
        repositoryRoot: root,
        manifest: fixture.manifest,
        fetchImplementation: async () =>
          new Response(changed, {
            status: 200,
            headers: archiveHeaders(fixture.manifest),
          }),
      }),
      /bytes do not match/
    );
  });
});

test('NSynth archive download timeout aborts without creating corpus audio', async () => {
  await withTemporaryRoot(async (root) => {
    const fixture = makeFixture();
    (fixture.manifest.archive as any).requestTimeoutMs = 5;
    await assert.rejects(
      hydrateNsynthFamilyControls({
        repositoryRoot: root,
        manifest: fixture.manifest,
        fetchImplementation: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new Error('mock fetch aborted')),
              { once: true }
            );
          }),
      }),
      /hydration timed out/
    );
    const outputDirectory = join(root, NSYNTH_FAMILY_CONTROL_OUTPUT_DIRECTORY);
    assert.deepEqual(readdirSync(outputDirectory), []);
  });
});

test('NSynth hydrator rejects unexpected tar paths and malformed selected WAVs', async () => {
  await withTemporaryRoot(async (root) => {
    const fixture = makeFixture({
      extraMember: { name: '../escape', bytes: Buffer.from('unsafe') },
    });
    const archivePath = join(root, 'unsafe.tar.gz');
    writeFileSync(archivePath, fixture.archive);
    await assert.rejects(
      hydrateNsynthFamilyControls({
        repositoryRoot: root,
        manifest: fixture.manifest,
        archivePath,
      }),
      /path is unsafe/
    );
  });
  await withTemporaryRoot(async (root) => {
    const invalidWav = makeWav();
    invalidWav.write('NOPE', 0, 4, 'ascii');
    const fixture = makeFixture({ wav: invalidWav });
    const archivePath = join(root, 'invalid-wav.tar.gz');
    writeFileSync(archivePath, fixture.archive);
    await assert.rejects(
      hydrateNsynthFamilyControls({
        repositoryRoot: root,
        manifest: fixture.manifest,
        archivePath,
      }),
      /WAV contract/
    );
  });
});

test('NSynth hydrator rejects selected examples metadata drift', async () => {
  await withTemporaryRoot(async (root) => {
    const fixture = makeFixture({
      mutateExamples: (entry) => { entry.instrument_family_str = 'guitar'; },
    });
    const archivePath = join(root, 'invalid-examples.tar.gz');
    writeFileSync(archivePath, fixture.archive);
    await assert.rejects(
      hydrateNsynthFamilyControls({
        repositoryRoot: root,
        manifest: fixture.manifest,
        archivePath,
      }),
      /instrument_family_str drifted/
    );
  });
});

test('NSynth hydrator refuses mismatched existing files and symlinked output', async () => {
  const fixture = makeFixture();
  await withTemporaryRoot(async (root) => {
    const destination = join(
      root,
      NSYNTH_FAMILY_CONTROL_OUTPUT_DIRECTORY,
      fixture.manifest.controls[0].localFile
    );
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, Buffer.alloc(128_044));
    await assert.rejects(
      hydrateNsynthFamilyControls({
        repositoryRoot: root,
        manifest: fixture.manifest,
        fetchImplementation: async () => {
          throw new Error('existing-file rejection must happen before network access');
        },
      }),
      /existing NSynth control/
    );
  });
  await withTemporaryRoot(async (root) => {
    const audioRoot = join(root, 'tests/corpus/audio');
    const outside = join(root, 'outside');
    mkdirSync(audioRoot, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(audioRoot, 'nsynth-family-controls-v1'));
    await assert.rejects(
      hydrateNsynthFamilyControls({
        repositoryRoot: root,
        manifest: fixture.manifest,
        fetchImplementation: async () => {
          throw new Error('symlink rejection must happen before network access');
        },
      }),
      /symlink/
    );
  });
});

test('NSynth hydration CLI rejects ambiguous and unknown arguments before I/O', () => {
  const script = resolve(repositoryRoot, 'scripts/hydrate-nsynth-family-controls.mts');
  const ambiguous = spawnSync(
    process.execPath,
    ['--experimental-strip-types', script, '--verify-only', '--archive', 'fixture.tar.gz'],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /mutually exclusive/);
  const unknown = spawnSync(
    process.execPath,
    ['--experimental-strip-types', script, '--unknown'],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown NSynth hydration argument/);
});
