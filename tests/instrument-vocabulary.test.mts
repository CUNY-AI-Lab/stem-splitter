import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_DISCOVERY_WINDOWS,
  MAX_DISCOVERY_WINDOW_SECONDS,
  PINNED_INSTRUMENT_VOCABULARY_SHA256,
  PINNED_INSTRUMENT_VOCABULARY_VERSION,
} from '../src/analysis/types.ts';
import { PINNED_INSTRUMENT_LABELS } from '../src/analysis/instrument-vocabulary.ts';

const vocabularyBytes = readFileSync('instrument-discovery/vocabulary.json');
const vocabulary = JSON.parse(vocabularyBytes.toString('utf8'));

test('instrument vocabulary content is pinned, reviewable, and internally consistent', () => {
  assert.equal(
    createHash('sha256').update(vocabularyBytes).digest('hex'),
    PINNED_INSTRUMENT_VOCABULARY_SHA256
  );
  assert.equal(vocabulary.$schema, 'stem-splitter.instrument-vocabulary.v1');
  assert.equal(vocabulary.version, PINNED_INSTRUMENT_VOCABULARY_VERSION);
  assert.equal(vocabulary.reviewStatus, 'uncalibrated-candidate');
  assert.equal(vocabulary.aggregation.maximumWindows, MAX_DISCOVERY_WINDOWS);
  assert.equal(vocabulary.aggregation.maximumWindowSeconds, MAX_DISCOVERY_WINDOW_SECONDS);
  assert.equal(vocabulary.aggregation.minimumWindowSupport, 2);
  assert.equal(vocabulary.aggregation.maximumReturnedDetections, 12);

  const familyIds = new Set(Object.keys(vocabulary.families));
  assert.ok(familyIds.size >= 10);
  for (const [family, thresholds] of Object.entries(vocabulary.families) as Array<
    [string, { possibleThreshold: number; uncertainFloor: number }]
  >) {
    assert.match(family, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(thresholds.uncertainFloor >= 0 && thresholds.uncertainFloor < 1);
    assert.ok(
      thresholds.possibleThreshold > thresholds.uncertainFloor &&
        thresholds.possibleThreshold <= 1
    );
  }

  assert.ok(Array.isArray(vocabulary.instruments));
  assert.ok(vocabulary.instruments.length >= 40 && vocabulary.instruments.length <= 64);
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const instrument of vocabulary.instruments) {
    assert.match(instrument.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(ids.has(instrument.id), false, `duplicate id ${instrument.id}`);
    ids.add(instrument.id);
    assert.equal(instrument.label, instrument.label.trim());
    assert.equal(labels.has(instrument.label), false, `duplicate label ${instrument.label}`);
    labels.add(instrument.label);
    assert.equal(familyIds.has(instrument.family), true, `${instrument.id} has an unknown family`);
    assert.ok(Array.isArray(instrument.promptTerms) && instrument.promptTerms.length > 0);
    assert.equal(new Set(instrument.promptTerms).size, instrument.promptTerms.length);
    for (const term of instrument.promptTerms) {
      assert.equal(term, term.trim());
      assert.ok(term.length > 0 && term.length <= 80);
    }
    assert.ok(Array.isArray(instrument.confusableWith));
    assert.equal(new Set(instrument.confusableWith).size, instrument.confusableWith.length);
    assert.equal(instrument.confusableWith.includes(instrument.id), false);
  }
  assert.deepEqual(
    [...PINNED_INSTRUMENT_LABELS],
    vocabulary.instruments.map((instrument: { id: string; label: string }) => [
      instrument.id,
      instrument.label,
    ])
  );
  for (const instrument of vocabulary.instruments) {
    for (const related of instrument.confusableWith) {
      assert.equal(ids.has(related), true, `${instrument.id} references unknown ${related}`);
    }
  }

  for (const required of [
    'strings',
    'violin',
    'viola',
    'cello',
    'double-bass',
    'brass',
    'trumpet',
    'trombone',
    'horn',
    'saxophone',
    'clarinet',
    'flute',
    'oboe',
    'organ',
    'electric-piano',
    'synthesizer',
    'pad',
    'accordion',
    'harmonica',
    'harp',
    'percussion',
  ]) {
    assert.equal(ids.has(required), true, `required vocabulary id ${required} is missing`);
  }
  for (const reserved of ['auto', 'vocals_instrumental', 'htdemucs_ft', 'htdemucs_6s']) {
    assert.equal(ids.has(reserved), false, `instrument id collides with core model ${reserved}`);
  }
});
