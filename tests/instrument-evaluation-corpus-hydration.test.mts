import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  hydrateInstrumentEvaluationCorpus,
  INSTRUMENT_EVALUATION_HYDRATION_MANIFEST_PATH,
  INSTRUMENT_EVALUATION_HYDRATION_MANIFEST_SHA256,
  loadInstrumentEvaluationHydrationManifest,
  validateInstrumentEvaluationArchiveRedirect,
  validateInstrumentEvaluationHydrationManifest,
  type InstrumentEvaluationHydrationManifest,
} from '../scripts/hydrate-instrument-evaluation-corpus.mts';

const repositoryRoot = process.cwd();
const corpus = JSON.parse(readFileSync('tests/corpus/corpus.json', 'utf8'));
const rawManifest = JSON.parse(
  readFileSync(INSTRUMENT_EVALUATION_HYDRATION_MANIFEST_PATH, 'utf8')
);

function cloneManifest(): InstrumentEvaluationHydrationManifest {
  return structuredClone(loadInstrumentEvaluationHydrationManifest(repositoryRoot));
}

function hash(algorithm: 'md5' | 'sha1' | 'sha256', bytes: Buffer): string {
  return createHash(algorithm).update(bytes).digest('hex');
}

function responseJson(value: unknown): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    },
  });
}

test('hydration manifest pins every frozen classroom source and exact bytes', () => {
  const bytes = readFileSync(INSTRUMENT_EVALUATION_HYDRATION_MANIFEST_PATH);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), INSTRUMENT_EVALUATION_HYDRATION_MANIFEST_SHA256);
  const manifest = loadInstrumentEvaluationHydrationManifest(repositoryRoot);
  assert.equal(manifest.sources.length, 11);
  assert.equal(
    manifest.sources.reduce((total, source) => total + source.media.bytes, 0),
    76_560_674
  );
  assert.deepEqual(
    manifest.sources.map((source) => source.slug),
    [
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
    ]
  );
});

test('hydration manifest rejects policy, order, rights, corpus, and content drift', () => {
  const cases: Array<[string, (value: any, corpusValue: any) => void]> = [
    ['policy', (value) => { value.downloadPolicy.maximumRedirects = 2; }],
    ['order', (value) => { value.sources.reverse(); }],
    ['rights', (value) => { value.sources[0].licenseUrl = 'https://creativecommons.org/licenses/by/4.0/'; }],
    ['archive file', (value) => { value.sources[0].archiveFile = 'other.mp3'; }],
    ['content', (value) => { value.sources[0].media.sha256 = '0'.repeat(64); }],
    ['bytes', (value) => { value.sources[0].media.bytes += 1; }],
    ['corpus', (_value, corpusValue) => {
      corpusValue.sources.find((source: any) => source.slug === 'folk-duet').source =
        'tests/corpus/audio/other.mp3';
    }],
  ];
  for (const [name, mutate] of cases) {
    const value = structuredClone(rawManifest);
    const corpusValue = structuredClone(corpus);
    mutate(value, corpusValue);
    assert.throws(
      () => validateInstrumentEvaluationHydrationManifest(value, corpusValue),
      /./,
      name
    );
  }
});

test('Archive redirects remain on the exact pinned object', () => {
  const manifest = cloneManifest();
  const source = manifest.sources[0];
  const accepted = validateInstrumentEvaluationArchiveRedirect(
    `https://dn710709.ca.archive.org/0/items/${source.archiveIdentifier}/${source.archiveFile}`,
    source,
    manifest
  );
  assert.equal(accepted.hostname, 'dn710709.ca.archive.org');
  for (const location of [
    `https://example.com/0/items/${source.archiveIdentifier}/${source.archiveFile}`,
    `https://dn710709.ca.archive.org/0/items/other/${source.archiveFile}`,
    `https://dn710709.ca.archive.org/0/items/extra/items/${source.archiveIdentifier}/${source.archiveFile}`,
    `https://dn710709.ca.archive.org/0/items/${source.archiveIdentifier}/${source.archiveFile}?download=1`,
    `https://user@dn710709.ca.archive.org/0/items/${source.archiveIdentifier}/${source.archiveFile}`,
  ]) {
    assert.throws(
      () => validateInstrumentEvaluationArchiveRedirect(location, source, manifest),
      /Archive redirect/
    );
  }
});

test('hydrator verifies metadata, streams exact content, and writes owner-only files', async () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'stem-splitter-corpus-hydration-'));
  try {
    const manifest = cloneManifest();
    const source = manifest.sources[0];
    const audio = Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000hydration-fixture');
    source.media = {
      bytes: audio.byteLength,
      md5: hash('md5', audio),
      sha1: hash('sha1', audio),
      sha256: hash('sha256', audio),
    };
    manifest.sources = [source];
    const requests: string[] = [];
    const fetchImplementation = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      requests.push(url.href);
      if (url.pathname.startsWith('/metadata/')) {
        return responseJson({
          metadata: {
            identifier: source.archiveIdentifier,
            licenseurl: source.licenseUrl,
          },
          files: [
            {
              name: source.archiveFile,
              size: String(source.media.bytes),
              md5: source.media.md5,
              sha1: source.media.sha1,
              format: 'VBR MP3',
              source: 'original',
            },
          ],
        });
      }
      if (url.hostname === 'archive.org') {
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://dn123.us.archive.org/0/items/${source.archiveIdentifier}/${source.archiveFile}`,
          },
        });
      }
      return new Response(audio, {
        status: 200,
        headers: {
          'content-type': 'audio/mpeg',
          'content-length': String(audio.byteLength),
        },
      });
    };
    const [result] = await hydrateInstrumentEvaluationCorpus({
      repositoryRoot: temporaryRoot,
      manifest,
      fetchImplementation,
    });
    assert.equal(result.state, 'downloaded');
    assert.equal(result.sha256, source.media.sha256);
    assert.equal(requests.length, 3);
    const output = resolve(temporaryRoot, manifest.downloadPolicy.outputDirectory, source.localFile);
    assert.deepEqual(readFileSync(output), audio);
    assert.equal(statSync(output).mode & 0o777, 0o600);

    const [verified] = await hydrateInstrumentEvaluationCorpus({
      repositoryRoot: temporaryRoot,
      manifest,
      slugs: [source.slug],
      verifyOnly: true,
    });
    assert.equal(verified.state, 'verified');
    assert.equal(verified.sha1, source.media.sha1);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('hydrator rejects metadata drift before audio and leaves no partial file', async () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'stem-splitter-corpus-reject-'));
  try {
    const manifest = cloneManifest();
    const source = manifest.sources[0];
    manifest.sources = [source];
    let requests = 0;
    await assert.rejects(
      () => hydrateInstrumentEvaluationCorpus({
        repositoryRoot: temporaryRoot,
        manifest,
        fetchImplementation: async () => {
          requests += 1;
          return responseJson({
            metadata: {
              identifier: source.archiveIdentifier,
              licenseurl: 'https://creativecommons.org/licenses/by/4.0/',
            },
            files: [],
          });
        },
      }),
      /identity or license drifted/
    );
    assert.equal(requests, 1);
    const outputDirectory = resolve(temporaryRoot, manifest.downloadPolicy.outputDirectory);
    assert.deepEqual(readdirSync(outputDirectory), []);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
