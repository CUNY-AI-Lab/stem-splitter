import type { StemRef } from './types';

export const BS_ROFORMER_MODEL = 'bs_roformer_vocals';
export const DEFAULT_DEMUCS_MODEL = 'htdemucs_ft';

export interface SeparationOption {
  id: string;
  stems: string[];
  label: string;
}

const DEMUCS_OPTIONS: SeparationOption[] = [
  {
    id: DEFAULT_DEMUCS_MODEL,
    stems: ['vocals', 'drums', 'bass', 'other'],
    label: '4 STEMS · vocals + drums + bass + other',
  },
  {
    id: 'htdemucs_6s',
    stems: ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'],
    label: '6 STEMS · vocals + drums + bass + other + guitar + piano',
  },
];

const BS_ROFORMER_OPTION: SeparationOption = {
  id: BS_ROFORMER_MODEL,
  stems: ['vocals', 'instrumental'],
  label: '2 STEMS · vocals + instrumental',
};

const ALL_OPTIONS = [BS_ROFORMER_OPTION, ...DEMUCS_OPTIONS];

export function getSeparationOptions(backend = 'replicate'): {
  backend: string;
  defaultModel: string;
  models: SeparationOption[];
} {
  if (backend === 'audio-separator') {
    return {
      backend,
      defaultModel: BS_ROFORMER_MODEL,
      models: [BS_ROFORMER_OPTION, ...DEMUCS_OPTIONS],
    };
  }

  return {
    backend,
    defaultModel: DEFAULT_DEMUCS_MODEL,
    models: DEMUCS_OPTIONS,
  };
}

export function modelIsAllowed(backend: string | undefined, model: string): boolean {
  return getSeparationOptions(backend).models.some((option) => option.id === model);
}

export function getSeparationOption(model: string): SeparationOption | undefined {
  return ALL_OPTIONS.find((option) => option.id === model);
}

export class StemContractError extends Error {}

export function validateAndOrderStems(model: string, stems: StemRef[] | undefined): StemRef[] {
  const option = getSeparationOption(model);
  if (!option) throw new StemContractError(`The split used an unsupported model (${model})`);

  const received = stems ?? [];
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
