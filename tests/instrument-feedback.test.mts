import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InstrumentDiscoveryFeedbackError,
  normalizeInstrumentFeedbackObservations,
  summarizeInstrumentDiscoveryFeedback,
} from '../src/analysis/instrument-feedback.ts';
import {
  INSTRUMENT_REVIEW_ONTOLOGY_VERSION,
  INSTRUMENT_REVIEW_OPTIONS,
  INSTRUMENT_REVIEW_OPTIONS_BY_ID,
} from '../src/analysis/instrument-review.ts';
import { PINNED_INSTRUMENT_LABELS } from '../src/analysis/instrument-vocabulary.ts';

test('review ontology covers every pinned label without equating parents and textures', () => {
  assert.equal(INSTRUMENT_REVIEW_ONTOLOGY_VERSION, 'instrument-review-ontology-v1');
  assert.equal(INSTRUMENT_REVIEW_OPTIONS.length, PINNED_INSTRUMENT_LABELS.size);
  assert.equal(INSTRUMENT_REVIEW_OPTIONS_BY_ID.get('saxophone')?.kind, 'specific-instrument-or-voice');
  assert.equal(INSTRUMENT_REVIEW_OPTIONS_BY_ID.get('strings')?.kind, 'family-or-ensemble');
  assert.equal(INSTRUMENT_REVIEW_OPTIONS_BY_ID.get('brass')?.kind, 'family-or-ensemble');
  assert.equal(INSTRUMENT_REVIEW_OPTIONS_BY_ID.get('gamelan')?.kind, 'family-or-ensemble');
  assert.equal(INSTRUMENT_REVIEW_OPTIONS_BY_ID.get('sampler')?.kind, 'production-texture');
  assert.equal(INSTRUMENT_REVIEW_OPTIONS_BY_ID.get('pad')?.kind, 'production-texture');
  for (const option of INSTRUMENT_REVIEW_OPTIONS) {
    assert.equal(PINNED_INSTRUMENT_LABELS.get(option.id), option.label);
    assert.match(option.family, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  }
});

test('feedback requires a complete verdict for detections and only omitted labels may be missed', () => {
  assert.deepEqual(
    normalizeInstrumentFeedbackObservations(
      [
        { instrumentId: 'trumpet', verdict: 'missed' },
        { instrumentId: 'saxophone', verdict: 'confirmed' },
      ],
      ['saxophone']
    ),
    [
      { instrumentId: 'saxophone', verdict: 'confirmed' },
      { instrumentId: 'trumpet', verdict: 'missed' },
    ]
  );
  assert.throws(
    () => normalizeInstrumentFeedbackObservations([{ instrumentId: 'trumpet', verdict: 'missed' }], ['saxophone']),
    (error) =>
      error instanceof InstrumentDiscoveryFeedbackError &&
      /every surfaced detection/.test(error.message)
  );
  assert.throws(
    () => normalizeInstrumentFeedbackObservations([{ instrumentId: 'saxophone', verdict: 'missed' }], ['saxophone']),
    /surfaced detection must be marked confirmed or absent/
  );
  assert.throws(
    () => normalizeInstrumentFeedbackObservations([{ instrumentId: 'trumpet', verdict: 'confirmed' }], []),
    /Only an instrument omitted by the candidate may be marked missed/
  );
  assert.throws(
    () =>
      normalizeInstrumentFeedbackObservations(
        [
          { instrumentId: 'saxophone', verdict: 'confirmed' },
          { instrumentId: 'saxophone', verdict: 'absent' },
        ],
        ['saxophone']
      ),
    /unknown, duplicated, or invalid observation/
  );
});

test('teacher feedback summaries cannot expose reviewer or private source identity', () => {
  const summary = summarizeInstrumentDiscoveryFeedback({
    schemaVersion: '1',
    id: 'feedback_1',
    jobId: 'job_1',
    reviewer: 'teacher-private',
    revision: 1,
    analysisSha256: 'a'.repeat(64),
    sourceSha256: 'b'.repeat(64),
    classifierVersion: 'candidate-v1',
    vocabularyVersion: 'classroom-instruments-v1',
    vocabularySha256: 'c'.repeat(64),
    reviewOntologyVersion: INSTRUMENT_REVIEW_ONTOLOGY_VERSION,
    genreFamily: 'jazz',
    observations: [{ instrumentId: 'saxophone', verdict: 'confirmed' }],
    evidenceStatus: 'unreviewed-candidate',
    deidentified: false,
    trainingEligible: false,
    createdAt: '2026-08-10T12:00:00.000Z',
  });
  assert.deepEqual(summary, {
    schemaVersion: '1',
    revision: 1,
    genreFamily: 'jazz',
    observations: [{ instrumentId: 'saxophone', verdict: 'confirmed' }],
    evidenceStatus: 'unreviewed-candidate',
    deidentified: false,
    trainingEligible: false,
    createdAt: '2026-08-10T12:00:00.000Z',
  });
  assert.equal('reviewer' in summary, false);
  assert.equal('sourceSha256' in summary, false);
  assert.equal('analysisSha256' in summary, false);
});
