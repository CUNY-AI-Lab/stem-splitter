import vocabulary from '../../instrument-discovery/vocabulary.json' with { type: 'json' };

export const INSTRUMENT_REVIEW_ONTOLOGY_VERSION = 'instrument-review-ontology-v1' as const;

export type InstrumentReviewKind =
  | 'specific-instrument-or-voice'
  | 'family-or-ensemble'
  | 'production-texture';

export interface InstrumentReviewOptionV1 {
  id: string;
  label: string;
  family: string;
  kind: InstrumentReviewKind;
}

/**
 * These broad labels can overlap a specific instrument on the same recording.
 * Reviewers may assess both, but downstream metrics must not count the pair as
 * two independent instruments.
 */
const FAMILY_OR_ENSEMBLE_IDS = new Set(['strings', 'brass', 'percussion', 'gamelan']);

/** Production/timbre evidence is displayed separately from audible instruments. */
const PRODUCTION_TEXTURE_IDS = new Set(['pad', 'sampler']);

export function instrumentReviewKind(id: string): InstrumentReviewKind {
  if (FAMILY_OR_ENSEMBLE_IDS.has(id)) return 'family-or-ensemble';
  if (PRODUCTION_TEXTURE_IDS.has(id)) return 'production-texture';
  return 'specific-instrument-or-voice';
}

export const INSTRUMENT_REVIEW_OPTIONS: readonly InstrumentReviewOptionV1[] = Object.freeze(
  vocabulary.instruments.map((instrument) =>
    Object.freeze({
      id: instrument.id,
      label: instrument.label,
      family: instrument.family,
      kind: instrumentReviewKind(instrument.id),
    })
  )
);

export const INSTRUMENT_REVIEW_OPTIONS_BY_ID: ReadonlyMap<string, InstrumentReviewOptionV1> =
  new Map(INSTRUMENT_REVIEW_OPTIONS.map((option) => [option.id, option]));
