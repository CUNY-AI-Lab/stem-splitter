import type { Env } from '../env';
import type { StemRef } from './types';

export const BS_ROFORMER_MODEL = 'bs_roformer_vocals';
export const DEFAULT_DEMUCS_MODEL = 'htdemucs_ft';
/** Contract id, deliberately provider-neutral: Phase 2 swaps the runner beneath it. */
export const TWO_STEM_MODEL = 'vocals_instrumental';

/** Env secrets holding a pinned provider version. Widen when a second model lands. */
type VersionVar = 'REPLICATE_MODEL_VERSION';

// How to actually run an option on a given backend. Keeping this next to the
// output contract is what makes the catalogue data: adding a choice is a row
// here, not an edit to a backend. Presence of a key = the option is runnable
// on that backend, so getSeparationOptions() is a filter rather than an if.
export interface ReplicateRunner {
  kind: 'replicate';
  /** Named rather than a closure so the version guard can enumerate pins. */
  versionVar: VersionVar;
  /** Option-specific provider input; the backend merges it over { audio }. */
  input(): Record<string, unknown>;
  /** Provider output key -> contract stem name. Unlisted keys pass through. */
  outputNames?: Record<string, string>;
}

export interface AudioSeparatorRunner {
  kind: 'audio-separator';
  /** Profile id the local service expects (local-separator/service.py MODEL_FILES). */
  profile: string;
}

export interface SeparationOption {
  id: string;
  stems: string[];
  /** Spoken name for the choice — the picker shows a count, this names the parts. */
  label: string;
  engine: string;
  runners: {
    replicate?: ReplicateRunner;
    'audio-separator'?: AudioSeparatorRunner;
  };
  /** Backends that preselect this option. */
  defaultFor?: string[];
}

/** What the browser is allowed to see: output contract and display copy only. */
export interface SeparationOptionSummary {
  id: string;
  stems: string[];
  label: string;
  engine: string;
}

const MP3_OUTPUT = { output_format: 'mp3', mp3_bitrate: 192 } as const;

// Ordered by track count so every backend advertises 2 → 4 → 6.
const ALL_OPTIONS: SeparationOption[] = [
  {
    id: BS_ROFORMER_MODEL,
    stems: ['vocals', 'instrumental'],
    label: '2 parts: voice, everything else',
    engine: 'BS-ROFORMER',
    runners: {
      'audio-separator': { kind: 'audio-separator', profile: BS_ROFORMER_MODEL },
    },
    defaultFor: ['audio-separator'],
  },
  {
    // Demucs karaoke mode: `stem: 'vocals'` separates fully, then sums the rest
    // into no_vocals (separate.py --other-method defaults to "add"). Same cost
    // as a 4-track split, not cheaper. Swapping this to a RoFormer model later
    // means replacing `runners.replicate` and `engine` — the id, the contract,
    // the frontend, and the track-count tests all stay as they are.
    id: TWO_STEM_MODEL,
    stems: ['vocals', 'instrumental'],
    label: '2 parts: voice, everything else',
    engine: 'DEMUCS',
    runners: {
      replicate: {
        kind: 'replicate',
        versionVar: 'REPLICATE_MODEL_VERSION',
        input: () => ({ model: DEFAULT_DEMUCS_MODEL, stem: 'vocals', ...MP3_OUTPUT }),
        outputNames: { no_vocals: 'instrumental' },
      },
    },
  },
  {
    id: DEFAULT_DEMUCS_MODEL,
    stems: ['vocals', 'drums', 'bass', 'other'],
    label: '4 parts: voice, percussion, low end, the rest',
    engine: 'DEMUCS',
    runners: {
      replicate: {
        kind: 'replicate',
        versionVar: 'REPLICATE_MODEL_VERSION',
        input: () => ({ model: DEFAULT_DEMUCS_MODEL, ...MP3_OUTPUT }),
      },
      'audio-separator': { kind: 'audio-separator', profile: DEFAULT_DEMUCS_MODEL },
    },
    defaultFor: ['replicate'],
  },
  {
    id: 'htdemucs_6s',
    stems: ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'],
    // These are guitar-/piano-trained nets, but they may catch neighboring
    // timbres such as oud, kora, mbira, celesta, or santur imperfectly.
    label: '6 parts: adds plucked strings and keys',
    engine: 'DEMUCS',
    runners: {
      replicate: {
        kind: 'replicate',
        versionVar: 'REPLICATE_MODEL_VERSION',
        input: () => ({ model: 'htdemucs_6s', ...MP3_OUTPUT }),
      },
      'audio-separator': { kind: 'audio-separator', profile: 'htdemucs_6s' },
    },
  },
];

export function getSeparationOptions(backend = 'replicate'): {
  backend: string;
  defaultModel: string;
  models: SeparationOptionSummary[];
} {
  const available = ALL_OPTIONS.filter((option) => backend in option.runners);
  const defaultModel =
    available.find((option) => option.defaultFor?.includes(backend))?.id ?? available[0]?.id ?? '';
  return {
    backend,
    defaultModel,
    // Projected deliberately: runner wiring must never reach the browser.
    models: available.map(({ id, stems, label, engine }) => ({
      id,
      stems: [...stems],
      label,
      engine,
    })),
  };
}

export function modelIsAllowed(backend: string | undefined, model: string): boolean {
  return getSeparationOptions(backend).models.some((option) => option.id === model);
}

// Searches the full catalogue, not the backend-filtered set, so a job stored
// under another backend's profile still resolves for display and validation.
export function getSeparationOption(model: string): SeparationOption | undefined {
  return ALL_OPTIONS.find((option) => option.id === model);
}

export function getReplicateRunner(model: string): ReplicateRunner | undefined {
  return getSeparationOption(model)?.runners.replicate;
}

export function getAudioSeparatorRunner(model: string): AudioSeparatorRunner | undefined {
  return getSeparationOption(model)?.runners['audio-separator'];
}

export function replicateVersion(env: Env, runner: ReplicateRunner): string {
  return env[runner.versionVar];
}

/**
 * Everything the catalogue asks of the pinned Replicate version. The version
 * guard (scripts/check-replicate-pin.mjs) reads this instead of keeping a
 * second hand-maintained list in sync.
 */
export function replicateContractSurface(): {
  modelIds: string[];
  inputKeys: string[];
  versionVars: string[];
} {
  const modelIds = new Set<string>();
  const inputKeys = new Set<string>(['audio']);
  const versionVars = new Set<string>();
  for (const option of ALL_OPTIONS) {
    const runner = option.runners.replicate;
    if (!runner) continue;
    versionVars.add(runner.versionVar);
    const input = runner.input();
    for (const key of Object.keys(input)) inputKeys.add(key);
    if (typeof input.model === 'string') modelIds.add(input.model);
  }
  return {
    modelIds: [...modelIds].sort(),
    inputKeys: [...inputKeys].sort(),
    versionVars: [...versionVars].sort(),
  };
}

/** Catalogue rows, for tests and tooling that need the runner wiring. */
export function allSeparationOptions(): readonly SeparationOption[] {
  return ALL_OPTIONS;
}

export class StemContractError extends Error {}

export function validateAndOrderStems(model: string, stems: StemRef[] | undefined): StemRef[] {
  const option = getSeparationOption(model);
  if (!option) throw new StemContractError(`The split used an unsupported model (${model})`);

  // Rename provider-specific output keys onto contract names first, so both
  // the webhook and the reconciliation path get it exactly once. Anything the
  // map does not cover still falls through to the "unexpected" check below.
  const rename = option.runners.replicate?.outputNames;
  const received = (stems ?? []).map((stem) =>
    rename?.[stem.name] ? { ...stem, name: rename[stem.name] } : stem
  );

  const byName = new Map<string, StemRef>();
  for (const stem of received) {
    if (byName.has(stem.name)) {
      throw new StemContractError(`The separator returned the "${stem.name}" track more than once`);
    }
    byName.set(stem.name, stem);
  }

  const missing = option.stems.filter((name) => !byName.has(name));
  const unexpected = [...byName.keys()].filter((name) => !option.stems.includes(name));
  if (received.length !== option.stems.length || missing.length || unexpected.length) {
    const details = [
      missing.length ? `missing ${missing.join(', ')}` : '',
      unexpected.length ? `unexpected ${unexpected.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    throw new StemContractError(
      `The ${option.stems.length}-track split was incomplete${details ? ` (${details})` : ''}`
    );
  }

  return option.stems.map((name) => byName.get(name)!);
}
