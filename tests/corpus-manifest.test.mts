import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { getSeparationOption } from '../src/separation/options.ts';

const manifest = JSON.parse(
  readFileSync(new URL('./corpus/corpus.json', import.meta.url), 'utf8')
) as {
  sources: Array<{
    slug: string;
    kind: 'file' | 'youtube';
    source: string;
    coverage?: string[];
    expectedInstruments?: string[];
    provenance?: {
      archiveIdentifier: string;
      archiveFile?: string;
      sha1?: string;
      contentSha256: string;
      license: string;
      licenseUrl: string;
      verifiedAt: string;
    };
    models: string[];
    expect: Record<string, { loud: string[]; quiet: string[] }>;
    manualChecks: string[];
  }>;
};

const autoExpectations = JSON.parse(
  readFileSync(new URL('./corpus/autosplit-expectations.json', import.meta.url), 'utf8')
) as {
  schemaVersion: string;
  classifierVersion: string;
  analysisSampleRate: number;
  sources: Array<{
    slug: string;
    preferredChoice: 'two' | 'four' | 'six';
    acceptedChoices: Array<'two' | 'four' | 'six'>;
    rejectedChoices: Array<'two' | 'four' | 'six'>;
    rationale: string;
  }>;
};

const REQUIRED_COVERAGE = [
  'rock',
  'jazz',
  'orchestral',
  'electronic',
  'hip-hop',
  'folk-traditional',
  'sparse-acoustic',
] as const;
const SAFE_LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

test('authorized file corpus has fixed rights, coverage, and audible-instrument annotations', () => {
  const files = manifest.sources.filter((source) => source.kind === 'file');
  assert.ok(files.length >= 7, 'the authorized corpus must span more than a rock-band baseline');

  const slugs = manifest.sources.map((source) => source.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'corpus slugs must be unique');
  const filePaths = files.map((source) => source.source);
  assert.equal(new Set(filePaths).size, filePaths.length, 'corpus file paths must be unique');

  const represented = new Set(files.flatMap((source) => source.coverage ?? []));
  for (const category of REQUIRED_COVERAGE) {
    assert.ok(represented.has(category), `authorized corpus is missing ${category} coverage`);
  }

  for (const source of files) {
    assert.match(source.slug, SAFE_LABEL, `${source.slug}: slug must be stable and normalized`);
    assert.match(
      source.source,
      /^tests\/corpus\/audio\/[a-z0-9][a-z0-9._-]*$/,
      `${source.slug}: audio must stay in the ignored corpus directory`
    );

    assert.ok(source.coverage?.length, `${source.slug}: coverage annotations are required`);
    assert.equal(
      new Set(source.coverage).size,
      source.coverage!.length,
      `${source.slug}: coverage annotations must be unique`
    );
    for (const label of source.coverage!) assert.match(label, SAFE_LABEL);

    assert.ok(
      source.expectedInstruments?.length,
      `${source.slug}: expected audible instruments are required`
    );
    assert.equal(
      new Set(source.expectedInstruments).size,
      source.expectedInstruments!.length,
      `${source.slug}: expected audible instruments must be unique`
    );
    for (const instrument of source.expectedInstruments!) assert.match(instrument, SAFE_LABEL);

    const provenance = source.provenance;
    assert.ok(provenance, `${source.slug}: source-rights provenance is required`);
    assert.match(provenance.archiveIdentifier, /^[A-Za-z0-9._-]+$/);
    if (provenance.archiveFile) {
      assert.match(provenance.archiveFile, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    }
    assert.match(
      provenance.license,
      /^(?:CC BY(?:\s|$)|CC0(?:\s|$))/,
      `${source.slug}: license must allow derivatives`
    );
    assert.doesNotMatch(provenance.license, /\b(?:NC|ND)\b/i);
    if (provenance.sha1) assert.match(provenance.sha1, /^[a-f0-9]{40}$/);
    assert.match(
      provenance.contentSha256,
      /^[a-f0-9]{64}$/,
      `${source.slug}: exact corpus content needs a SHA-256 pin`
    );

    const licenseUrl = new URL(provenance.licenseUrl);
    assert.ok(['http:', 'https:'].includes(licenseUrl.protocol));
    assert.equal(licenseUrl.hostname, 'creativecommons.org');
    assert.match(licenseUrl.pathname, /^(?:\/licenses\/by\/|\/publicdomain\/zero\/)/);
    assert.doesNotMatch(licenseUrl.pathname, /(?:^|-)nd(?:-|\/|$)/i);
    assert.match(provenance.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(
      Number.isFinite(Date.parse(`${provenance.verifiedAt}T00:00:00Z`)),
      `${source.slug}: provenance verification date is invalid`
    );
  }
});

test('corpus expectations cannot invent models or tracks outside the frozen core contracts', () => {
  for (const source of manifest.sources) {
    assert.ok(source.models.length >= 1, `${source.slug}: at least one model is required`);
    assert.equal(
      new Set(source.models).size,
      source.models.length,
      `${source.slug}: models must be unique`
    );
    assert.deepEqual(
      Object.keys(source.expect).sort(),
      [...source.models].sort(),
      `${source.slug}: every model needs exactly one expectation`
    );
    assert.ok(source.manualChecks.length, `${source.slug}: manual listening checks are required`);

    for (const model of source.models) {
      const contract = getSeparationOption(model);
      assert.ok(contract, `${source.slug}: ${model} is not a separator contract`);
      const expectation = source.expect[model];
      assert.ok(expectation.loud.length, `${source.slug}/${model}: at least one loud track is required`);

      const loud = new Set(expectation.loud);
      const quiet = new Set(expectation.quiet);
      assert.equal(loud.size, expectation.loud.length, `${source.slug}/${model}: duplicate loud track`);
      assert.equal(quiet.size, expectation.quiet.length, `${source.slug}/${model}: duplicate quiet track`);
      for (const track of [...loud, ...quiet]) {
        assert.ok(contract.stems.includes(track), `${source.slug}/${model}: impossible track ${track}`);
      }
      for (const track of loud) {
        assert.ok(!quiet.has(track), `${source.slug}/${model}: ${track} cannot be loud and quiet`);
      }
    }
  }
});

test('AutoSplit review expectations cover every authorized source without inventing stem labels', () => {
  assert.equal(autoExpectations.schemaVersion, '1');
  assert.equal(autoExpectations.classifierVersion, 'autosplit-role-v3');
  assert.equal(autoExpectations.analysisSampleRate, 22_050);
  const fileSlugs = manifest.sources
    .filter((source) => source.kind === 'file')
    .map((source) => source.slug)
    .sort();
  const expectationSlugs = autoExpectations.sources.map((source) => source.slug).sort();
  assert.deepEqual(expectationSlugs, fileSlugs);
  assert.equal(new Set(expectationSlugs).size, expectationSlugs.length);
  for (const expectation of autoExpectations.sources) {
    const allChoices = ['two', 'four', 'six'] as const;
    assert.ok(expectation.acceptedChoices.length, `${expectation.slug}: choices are required`);
    assert.equal(
      new Set(expectation.acceptedChoices).size,
      expectation.acceptedChoices.length,
      `${expectation.slug}: choices must be unique`
    );
    assert.ok(expectation.rationale.trim().length >= 40, `${expectation.slug}: rationale is too thin`);
    assert.ok(
      expectation.acceptedChoices.includes(expectation.preferredChoice),
      `${expectation.slug}: preferred choice must be accepted`
    );
    assert.ok(expectation.rejectedChoices.length, `${expectation.slug}: at least one rejection is required`);
    assert.equal(
      new Set(expectation.rejectedChoices).size,
      expectation.rejectedChoices.length,
      `${expectation.slug}: rejected choices must be unique`
    );
    assert.deepEqual(
      [...expectation.acceptedChoices, ...expectation.rejectedChoices].sort(),
      [...allChoices].sort(),
      `${expectation.slug}: accepted and rejected choices must partition the contracts`
    );
    for (const choice of expectation.acceptedChoices) {
      assert.ok(['two', 'four', 'six'].includes(choice), `${expectation.slug}: invalid choice ${choice}`);
    }
  }
});
