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
import test from 'node:test';

import {
  hydrateInstrumentControls,
  validateInstrumentControlRedirect,
} from '../scripts/hydrate-instrument-controls.mts';
import {
  INSTRUMENT_CONTROL_MANIFEST_PATH,
  INSTRUMENT_CONTROL_OUTPUT_DIRECTORY,
  loadInstrumentControlManifest,
  validateInstrumentControlManifestForRepository,
  type InstrumentControlManifest,
} from '../scripts/lib/instrument-control-corpus.mts';

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

function cloneManifest(): InstrumentControlManifest {
  return structuredClone(loadInstrumentControlManifest(repositoryRoot));
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function smallControlManifest(bytes: Buffer): InstrumentControlManifest {
  const manifest = cloneManifest();
  const control = manifest.controls[0];
  control.media.bytes = bytes.length;
  control.media.sha256 = sha256(bytes);
  manifest.controls = [control];
  return manifest;
}

function withTemporaryRoot(run: (root: string) => Promise<void> | void): Promise<void> | void {
  const root = mkdtempSync(join(tmpdir(), 'stem-splitter-instrument-controls-'));
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

test('ChoraleBricks controls bind rights, exact media, long-tail families, and review state', () => {
  const manifest = loadInstrumentControlManifest(repositoryRoot);
  assert.equal(manifest.controls.length, 8);
  assert.equal(manifest.reviewStatus, 'dataset-authored-awaiting-teacher-listening');
  assert.equal(manifest.dataset.license, 'CC BY 4.0');
  assert.equal(manifest.dataset.recordingType, 'isolated-performed-wind-instrument-tracks');
  assert.equal(manifest.negativePolicy.precisionClaim, 'none');
  assert.equal(manifest.downloadPolicy.maximumRedirects, 1);
  assert.equal(manifest.downloadPolicy.outputDirectory, INSTRUMENT_CONTROL_OUTPUT_DIRECTORY);
  assert.deepEqual(
    manifest.controls.map((control) => control.instrument),
    ['flute', 'oboe', 'clarinet', 'trumpet', 'horn', 'trombone', 'saxophone', 'tuba']
  );
  assert.equal(new Set(manifest.controls.map((control) => control.media.sha256)).size, 8);
  assert.ok(manifest.controls.every((control) => control.media.channels === 1));
  assert.ok(manifest.controls.every((control) => control.media.sampleRate === 44_100));

  const mapping = JSON.parse(readFileSync('yamnet-comparator/mapping.json', 'utf8')) as {
    mapped: Array<{ instrumentId: string }>;
    unsupported: Array<{ instrumentId: string }>;
  };
  const supported = new Set(mapping.mapped.map((item) => item.instrumentId));
  const unsupported = new Set(mapping.unsupported.map((item) => item.instrumentId));
  assert.deepEqual(
    manifest.controls.filter((control) => supported.has(control.instrument)).map((control) => control.instrument),
    ['flute', 'clarinet', 'trumpet', 'horn', 'trombone', 'saxophone']
  );
  assert.deepEqual(
    manifest.controls.filter((control) => unsupported.has(control.instrument)).map((control) => control.instrument),
    ['oboe', 'tuba']
  );
});

test('instrument control manifest rejects provenance, review, URL, and label drift', () => {
  const raw = JSON.parse(
    readFileSync(INSTRUMENT_CONTROL_MANIFEST_PATH, 'utf8')
  ) as Record<string, any>;
  const mutations: Array<[string, (value: Record<string, any>) => void]> = [
    ['review state', (value) => { value.reviewStatus = 'teacher-reviewed'; }],
    ['precision claim', (value) => { value.negativePolicy.precisionClaim = 'precision-ready'; }],
    ['source origin', (value) => { value.controls[0].sourceUrl = 'https://example.com/flute.m4a'; }],
    ['positive label', (value) => { value.controls[0].positiveIds = ['flute', 'oboe']; }],
    ['media pin', (value) => { value.controls[0].media.sha256 = '0'.repeat(64); }],
    ['unknown field', (value) => { value.controls[0].teacherApproved = true; }],
  ];
  for (const [name, mutate] of mutations) {
    const candidate = structuredClone(raw);
    mutate(candidate);
    assert.throws(
      () => validateInstrumentControlManifestForRepository(candidate, repositoryRoot),
      undefined,
      name
    );
  }
});

test('instrument control redirect accepts one exact same-origin hashed asset only', () => {
  const manifest = cloneManifest();
  const control = manifest.controls[0];
  const accepted = validateInstrumentControlRedirect(
    'https://www.audiolabs-erlangen.de/media/pages/resources/MIR/2025-ChoraleBricks/Anonymous_AusMeinesHerzensGrunde/tracks/6e21910bd1-1736447169/01_fl.m4a',
    control,
    manifest
  );
  assert.equal(accepted.pathname.endsWith('/6e21910bd1-1736447169/01_fl.m4a'), true);
  for (const location of [
    'https://example.com/media/01_fl.m4a',
    'https://www.audiolabs-erlangen.de/media/pages/resources/MIR/2025-ChoraleBricks/Anonymous_AusMeinesHerzensGrunde/tracks/6e21910bd1-1736447169/01_fl.m4a?token=x',
    'https://www.audiolabs-erlangen.de/media/pages/resources/MIR/2025-ChoraleBricks/OtherPiece/tracks/6e21910bd1-1736447169/01_fl.m4a',
    'https://www.audiolabs-erlangen.de/media/pages/resources/MIR/2025-ChoraleBricks/Anonymous_AusMeinesHerzensGrunde/tracks/latest/01_fl.m4a',
  ]) {
    assert.throws(() => validateInstrumentControlRedirect(location, control, manifest));
  }
});

test('hydrator follows the pinned redirect manually, verifies bytes, and rechecks offline', async () => {
  await withTemporaryRoot(async (root) => {
    const bytes = Buffer.from('bounded isolated flute control');
    const manifest = smallControlManifest(bytes);
    const control = manifest.controls[0];
    const requests: Array<{ url: string; redirect?: RequestRedirect }> = [];
    const fetchImplementation = async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      const url = String(input);
      requests.push({ url, redirect: init?.redirect });
      if (requests.length === 1) {
        return new Response(null, {
          status: 307,
          headers: {
            location:
              'https://www.audiolabs-erlangen.de/media/pages/resources/MIR/2025-ChoraleBricks/Anonymous_AusMeinesHerzensGrunde/tracks/6e21910bd1-1736447169/01_fl.m4a',
          },
        });
      }
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'audio/mp4',
          'content-length': String(bytes.length),
        },
      });
    };

    const hydrated = await hydrateInstrumentControls({
      repositoryRoot: root,
      manifest,
      ids: [control.id],
      fetchImplementation,
    });
    assert.deepEqual(hydrated, [
      {
        id: control.id,
        state: 'downloaded',
        bytes: bytes.length,
        sha256: sha256(bytes),
        path: `${INSTRUMENT_CONTROL_OUTPUT_DIRECTORY}/${control.localFile}`,
      },
    ]);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.redirect === 'manual'));
    const destination = join(root, INSTRUMENT_CONTROL_OUTPUT_DIRECTORY, control.localFile);
    assert.deepEqual(readFileSync(destination), bytes);
    assert.equal(lstatSync(destination).mode & 0o777, 0o600);
    assert.equal(
      readdirSync(join(root, INSTRUMENT_CONTROL_OUTPUT_DIRECTORY)).some((name) => name.endsWith('.partial')),
      false
    );

    const verified = await hydrateInstrumentControls({
      repositoryRoot: root,
      manifest,
      ids: [control.id],
      verifyOnly: true,
      fetchImplementation: async () => {
        throw new Error('verify-only mode must not use the network');
      },
    });
    assert.equal(verified[0].state, 'verified');
  });
});

test('hydrator refuses cross-origin redirects, mismatched files, and symlinked output', async () => {
  const bytes = Buffer.from('bounded isolated flute control');
  const manifest = smallControlManifest(bytes);
  const control = manifest.controls[0];

  await withTemporaryRoot(async (root) => {
    await assert.rejects(
      hydrateInstrumentControls({
        repositoryRoot: root,
        manifest,
        ids: [control.id],
        fetchImplementation: async () =>
          new Response(null, { status: 307, headers: { location: 'https://example.com/file.m4a' } }),
      }),
      /escaped the pinned origin/
    );
  });

  await withTemporaryRoot(async (root) => {
    const destination = join(root, INSTRUMENT_CONTROL_OUTPUT_DIRECTORY, control.localFile);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, Buffer.from('wrong'));
    await assert.rejects(
      hydrateInstrumentControls({
        repositoryRoot: root,
        manifest,
        ids: [control.id],
        fetchImplementation: async () => {
          throw new Error('mismatched existing files must fail before the network');
        },
      }),
      /existing control file/
    );
  });

  await withTemporaryRoot(async (root) => {
    const audioRoot = join(root, 'tests/corpus/audio');
    const outside = join(root, 'outside');
    mkdirSync(audioRoot, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(audioRoot, 'instrument-controls-v1'));
    await assert.rejects(
      hydrateInstrumentControls({
        repositoryRoot: root,
        manifest,
        ids: [control.id],
        fetchImplementation: async () => {
          throw new Error('symlink rejection must happen before the network');
        },
      }),
      /symlink/
    );
  });
});
