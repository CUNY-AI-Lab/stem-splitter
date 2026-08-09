import vocabulary from '../../instrument-discovery/vocabulary.json' with { type: 'json' };

/**
 * Exact ID/label pairs compiled into both application hops.
 *
 * The vocabulary bytes are hash-pinned in `types.ts` and checked in CI. Keeping
 * the map sourced from that same file prevents a service that merely echoes the
 * expected version/hash strings from introducing an unknown or relabelled item.
 */
export const PINNED_INSTRUMENT_LABELS: ReadonlyMap<string, string> = new Map(
  vocabulary.instruments.map((instrument) => [instrument.id, instrument.label])
);
