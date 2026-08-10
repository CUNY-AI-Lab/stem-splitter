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

import { hydrateVcslExactControls } from '../scripts/hydrate-vcsl-exact-controls.mts';
import {
  VCSL_COMMIT,
  VCSL_EXACT_CONTROL_MANIFEST_PATH,
  VCSL_EXACT_CONTROL_OUTPUT_DIRECTORY,
  VCSL_LICENSE_EVIDENCE_PIN,
  VCSL_README_EVIDENCE_PIN,
  loadVcslExactControlManifest,
  validateVcslExactControlManifestForRepository,
  type VcslExactControl,
  type VcslExactControlManifest,
} from '../scripts/lib/vcsl-exact-control-corpus.mts';

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

interface Fixture {
  manifest: VcslExactControlManifest;
  license: Buffer;
  readme: Buffer;
  audio: Map<string, Buffer>;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitBlobSha1(bytes: Uint8Array): string {
  return createHash('sha1')
    .update(`blob ${bytes.byteLength}\0`, 'utf8')
    .update(bytes)
    .digest('hex');
}

function cloneManifest(): VcslExactControlManifest {
  return structuredClone(loadVcslExactControlManifest(repositoryRoot));
}

function wavChunk(id: string, payload: Buffer): Buffer {
  assert.equal(Buffer.byteLength(id), 4);
  const header = Buffer.alloc(8);
  header.write(id, 0, 4, 'ascii');
  header.writeUInt32LE(payload.byteLength, 4);
  return Buffer.concat([header, payload, Buffer.alloc(payload.byteLength % 2)]);
}

function makeWav(control: VcslExactControl): Buffer {
  const formatBytes = control.sourceInstrument === 'Harmonica' ? 16 : 18;
  const format = Buffer.alloc(formatBytes);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(control.media.channels, 2);
  format.writeUInt32LE(44_100, 4);
  format.writeUInt32LE(44_100 * control.media.blockAlign, 8);
  format.writeUInt16LE(control.media.blockAlign, 12);
  format.writeUInt16LE(24, 14);
  if (formatBytes === 18) format.writeUInt16LE(0, 16);
  const frameCount = control.sourceInstrument === 'Harmonica' ? 401 : 400;
  const data = Buffer.alloc(frameCount * control.media.blockAlign);
  for (let index = 0; index < data.byteLength; index += 1) data[index] = (index * 97) % 251;
  const chunks = [wavChunk('fmt ', format), wavChunk('data', data)];
  if (control.sourceInstrument === 'Xylophone') chunks.push(wavChunk('_PMX', Buffer.alloc(8, 0x5a)));
  const payload = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(payload.byteLength + 4, 4);
  header.write('WAVE', 8, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function syncEvidence(
  evidence: VcslExactControlManifest['repository']['licenseEvidence'],
  bytes: Buffer
): void {
  evidence.bytes = bytes.byteLength;
  evidence.sha256 = sha256(bytes);
  evidence.gitBlobSha1 = gitBlobSha1(bytes);
}

function syncControl(control: VcslExactControl, bytes: Buffer): void {
  let offset = 12;
  const chunks: Array<{ id: string; bytes: number }> = [];
  let dataBytes = 0;
  while (offset < bytes.byteLength) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const chunkBytes = bytes.readUInt32LE(offset + 4);
    chunks.push({ id, bytes: chunkBytes });
    if (id === 'data') dataBytes = chunkBytes;
    offset += 8 + chunkBytes + (chunkBytes % 2);
  }
  control.gitBlobSha1 = gitBlobSha1(bytes);
  control.media.bytes = bytes.byteLength;
  control.media.sha256 = sha256(bytes);
  control.media.riffBytes = bytes.readUInt32LE(4);
  control.media.dataBytes = dataBytes;
  control.media.frameCount = dataBytes / control.media.blockAlign;
  control.media.chunks = chunks;
}

function makeFixture(): Fixture {
  const manifest = cloneManifest();
  const license = Buffer.from(
    'Creative Commons Legal Code\n\nCC0 1.0 Universal\n\n' +
    'The Work may be reused and reuse and redistribute as freely as possible.\n'
  );
  const readme = Buffer.from(
    '# VCSL\n\nAn open CC0 general-purpose sample library.\n' +
    'Samples shall be named in a human-readable format.\n' +
    'Stereo unless idiomatic (e.g. harmonicas, solo vox).\n'
  );
  syncEvidence(manifest.repository.licenseEvidence, license);
  syncEvidence(manifest.repository.readmeEvidence, readme);
  const audio = new Map<string, Buffer>();
  for (const control of manifest.controls) {
    const bytes = makeWav(control);
    syncControl(control, bytes);
    audio.set(control.sourceUrl, bytes);
  }
  return { manifest, license, readme, audio };
}

function responseFor(
  fixture: Fixture,
  url: string,
  override: { status?: number; contentLength?: string; contentType?: string; disposition?: string | null } = {}
): Response {
  let bytes: Buffer;
  let contentType: string;
  let disposition: string | null = null;
  if (url === fixture.manifest.repository.licenseEvidence.url) {
    bytes = fixture.license;
    contentType = 'text/plain; charset=utf-8';
  } else if (url === fixture.manifest.repository.readmeEvidence.url) {
    bytes = fixture.readme;
    contentType = 'text/plain; charset=utf-8';
  } else {
    bytes = fixture.audio.get(url) ?? Buffer.alloc(0);
    const control = fixture.manifest.controls.find(({ sourceUrl }) => sourceUrl === url);
    if (!control) throw new Error(`unexpected fixture URL: ${url}`);
    contentType = control.response.contentType;
    disposition = control.response.contentDisposition;
  }
  const headers = new Headers({
    'content-type': override.contentType ?? contentType,
    'content-length': override.contentLength ?? String(bytes.byteLength),
  });
  const selectedDisposition = Object.hasOwn(override, 'disposition') ? override.disposition : disposition;
  if (selectedDisposition !== null && selectedDisposition !== undefined) {
    headers.set('content-disposition', selectedDisposition);
  }
  return new Response(bytes, { status: override.status ?? 200, headers });
}

function fixtureFetch(
  fixture: Fixture,
  requests: Array<{ url: string; redirect?: string; acceptEncoding?: string }> = []
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      redirect: init?.redirect,
      acceptEncoding: headers.get('accept-encoding') ?? undefined,
    });
    return responseFor(fixture, url);
  };
}

function withTemporaryRoot(run: (root: string) => Promise<void> | void): Promise<void> | void {
  const root = mkdtempSync(join(tmpdir(), 'stem-splitter-vcsl-test-'));
  try {
    const result = run(root);
    if (result instanceof Promise) return result.finally(() => rmSync(root, { recursive: true, force: true }));
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test('VCSL controls pin an immutable CC0 commit and leave traditional evidence open', () => {
  const manifest = loadVcslExactControlManifest(repositoryRoot);
  assert.equal(manifest.repository.commit, VCSL_COMMIT);
  assert.equal(manifest.repository.license, 'CC0-1.0');
  assert.equal(manifest.repository.licenseEvidence.url, VCSL_LICENSE_EVIDENCE_PIN.url);
  assert.equal(manifest.repository.readmeEvidence.url, VCSL_README_EVIDENCE_PIN.url);
  assert.equal(manifest.repository.treeTruncated, false);
  assert.deepEqual(
    manifest.controls.map(({ sourceInstrument, vocabularyId, coverageGroup }) => [
      sourceInstrument, vocabularyId, coverageGroup,
    ]),
    [
      ['Harmonica', 'harmonica', 'harmonica'],
      ['Xylophone', 'mallet-percussion', 'pitched-percussion'],
    ]
  );
  assert.deepEqual(manifest.coverage.remainingExactPositiveGroups, ['traditional-instruments']);
  assert.equal(manifest.claimPolicy.currentEvaluationPlanUse, 'forbidden');
  assert.equal(manifest.claimPolicy.vocabularyPositiveClaims, 'candidate-awaiting-teacher-listening');
});

test('VCSL manifest rejects rights, provenance, mapping, coverage, and claim drift', () => {
  const raw = JSON.parse(readFileSync(VCSL_EXACT_CONTROL_MANIFEST_PATH, 'utf8')) as Record<string, any>;
  const mutations: Array<[string, (value: Record<string, any>) => void]> = [
    ['commit', (value) => { value.repository.commit = '0'.repeat(40); }],
    ['license', (value) => { value.repository.license = 'unknown'; }],
    ['license bytes', (value) => { value.repository.licenseEvidence.sha256 = '0'.repeat(64); }],
    ['tree truncation', (value) => { value.repository.treeTruncated = true; }],
    ['source blob', (value) => { value.controls[0].gitBlobSha1 = '0'.repeat(40); }],
    ['source URL', (value) => { value.controls[0].sourceUrl = 'https://example.com/control.wav'; }],
    ['vocabulary mapping', (value) => { value.controls[1].vocabularyId = 'marimba'; }],
    ['gap erasure', (value) => { value.coverage.remainingExactPositiveGroups = []; }],
    ['negative claim', (value) => { value.claimPolicy.candidateNegativeClaims = 'all-omitted'; }],
    ['plan integration', (value) => { value.claimPolicy.currentEvaluationPlanUse = 'allowed'; }],
    ['media pin', (value) => { value.controls[0].media.sha256 = '0'.repeat(64); }],
    ['unknown approval', (value) => { value.controls[0].teacherApproved = true; }],
  ];
  for (const [name, mutate] of mutations) {
    const candidate = structuredClone(raw);
    mutate(candidate);
    assert.throws(
      () => validateVcslExactControlManifestForRepository(candidate, repositoryRoot),
      name
    );
  }
});

test('VCSL hydrator verifies rights before audio and stores owner-only controls', async () => {
  await withTemporaryRoot(async (root) => {
    const fixture = makeFixture();
    const requests: Array<{ url: string; redirect?: string; acceptEncoding?: string }> = [];
    const records = await hydrateVcslExactControls({
      repositoryRoot: root,
      manifest: fixture.manifest,
      fetchImplementation: fixtureFetch(fixture, requests),
    });
    assert.deepEqual(requests.map(({ url }) => url), [
      fixture.manifest.repository.licenseEvidence.url,
      fixture.manifest.repository.readmeEvidence.url,
      ...fixture.manifest.controls.map(({ sourceUrl }) => sourceUrl),
    ]);
    assert.ok(requests.every(({ redirect }) => redirect === 'manual'));
    assert.ok(requests.every(({ acceptEncoding }) => acceptEncoding === 'identity'));
    assert.ok(records.every(({ state }) => state === 'downloaded'));
    assert.ok(records.every(({ exactInstrumentClaim }) => exactInstrumentClaim === 'repository-authored-source-label'));
    const output = join(root, VCSL_EXACT_CONTROL_OUTPUT_DIRECTORY);
    assert.equal(readdirSync(output).length, 2);
    for (const control of fixture.manifest.controls) {
      const controlFile = join(output, control.localFile);
      assert.equal(lstatSync(controlFile).mode & 0o777, 0o600);
      assert.deepEqual(readFileSync(controlFile), fixture.audio.get(control.sourceUrl));
    }
    const verified = await hydrateVcslExactControls({
      repositoryRoot: root,
      manifest: fixture.manifest,
      verifyOnly: true,
      fetchImplementation: async () => { throw new Error('verify-only reached the network'); },
    });
    assert.ok(verified.every(({ state }) => state === 'verified'));
  });
});

test('VCSL rights drift fails before audio is requested or stored', async () => {
  await withTemporaryRoot(async (root) => {
    const fixture = makeFixture();
    fixture.license = Buffer.from('not a CC0 license');
    syncEvidence(fixture.manifest.repository.licenseEvidence, fixture.license);
    const requests: string[] = [];
    await assert.rejects(
      hydrateVcslExactControls({
        repositoryRoot: root,
        manifest: fixture.manifest,
        fetchImplementation: async (input) => {
          const url = String(input);
          requests.push(url);
          return responseFor(fixture, url);
        },
      }),
      /license evidence content drifted/
    );
    assert.deepEqual(requests, [
      fixture.manifest.repository.licenseEvidence.url,
      fixture.manifest.repository.readmeEvidence.url,
    ]);
    assert.equal(readdirSync(join(root, VCSL_EXACT_CONTROL_OUTPUT_DIRECTORY)).length, 0);
  });
});

test('VCSL hydrator rejects response and body drift without leaving partial controls', async () => {
  const cases: Array<[string, (fixture: Fixture, url: string) => Response, RegExp]> = [
    ['redirect', (fixture, url) => responseFor(fixture, url, { status: 302 }), /response does not match/],
    ['length', (fixture, url) => responseFor(fixture, url, { contentLength: '999' }), /response does not match/],
    ['type', (fixture, url) => responseFor(fixture, url, { contentType: 'text/html' }), /response does not match/],
    ['disposition', (fixture, url) => responseFor(fixture, url, { disposition: 'attachment; filename=other.wav' }), /response does not match/],
  ];
  for (const [name, makeResponse, expected] of cases) {
    await withTemporaryRoot(async (root) => {
      const fixture = makeFixture();
      const targetUrl = fixture.manifest.controls[name === 'disposition' ? 1 : 0].sourceUrl;
      await assert.rejects(
        hydrateVcslExactControls({
          repositoryRoot: root,
          manifest: fixture.manifest,
          fetchImplementation: async (input) => {
            const url = String(input);
            return url === targetUrl ? makeResponse(fixture, url) : responseFor(fixture, url);
          },
        }),
        expected,
        name
      );
      assert.equal(readdirSync(join(root, VCSL_EXACT_CONTROL_OUTPUT_DIRECTORY)).length, 0, name);
    });
  }
});

test('VCSL hydrator checks PCM structure after content and Git pins', async () => {
  await withTemporaryRoot(async (root) => {
    const fixture = makeFixture();
    const control = fixture.manifest.controls[0];
    const bytes = Buffer.from(fixture.audio.get(control.sourceUrl)!);
    bytes.writeUInt16LE(3, 20);
    syncControl(control, bytes);
    fixture.audio.set(control.sourceUrl, bytes);
    await assert.rejects(
      hydrateVcslExactControls({
        repositoryRoot: root,
        manifest: fixture.manifest,
        fetchImplementation: fixtureFetch(fixture),
      }),
      /PCM contract drifted/
    );
  });
});

test('VCSL verify-only and existing-file boundaries reject absence, permissions, and symlinks', async () => {
  await withTemporaryRoot(async (root) => {
    const fixture = makeFixture();
    await assert.rejects(
      hydrateVcslExactControls({
        repositoryRoot: root,
        manifest: fixture.manifest,
        verifyOnly: true,
        fetchImplementation: async () => { throw new Error('verify-only reached the network'); },
      }),
      /unavailable for offline verification/
    );
    await hydrateVcslExactControls({
      repositoryRoot: root,
      manifest: fixture.manifest,
      fetchImplementation: fixtureFetch(fixture),
    });
    const firstFile = join(root, VCSL_EXACT_CONTROL_OUTPUT_DIRECTORY, fixture.manifest.controls[0].localFile);
    chmodSync(firstFile, 0o644);
    await assert.rejects(
      hydrateVcslExactControls({ repositoryRoot: root, manifest: fixture.manifest, verifyOnly: true }),
      /not the pinned owner-only WAV/
    );
  });
  await withTemporaryRoot(async (root) => {
    const fixture = makeFixture();
    mkdirSync(join(root, 'tests', 'corpus'), { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), 'stem-splitter-vcsl-outside-'));
    try {
      symlinkSync(outside, join(root, 'tests', 'corpus', 'audio'));
      await assert.rejects(
        hydrateVcslExactControls({ repositoryRoot: root, manifest: fixture.manifest }),
        /symlink or non-directory/
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('VCSL CLI rejects unknown and duplicate arguments before network work', () => {
  const script = resolve(repositoryRoot, 'scripts/hydrate-vcsl-exact-controls.mts');
  for (const args of [['--archive'], ['--verify-only', '--verify-only']]) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', script, ...args], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown VCSL hydration argument|may be specified once/);
  }
});

test('VCSL manifest loader rejects a symlink before reading outside the repository', () => {
  withTemporaryRoot((root) => {
    const manifestDirectory = join(root, 'tests', 'corpus');
    mkdirSync(manifestDirectory, { recursive: true });
    const outside = join(root, 'outside.json');
    writeFileSync(outside, readFileSync(resolve(repositoryRoot, VCSL_EXACT_CONTROL_MANIFEST_PATH)));
    symlinkSync(outside, join(root, VCSL_EXACT_CONTROL_MANIFEST_PATH));
    assert.throws(() => loadVcslExactControlManifest(root), /bounded repository file/);
  });
});
