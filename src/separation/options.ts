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
    label: '4 STEMS · cleanest',
  },
  {
    id: 'htdemucs_6s',
    stems: ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'],
    label: '6 STEMS · +guitar & piano',
  },
];

const BS_ROFORMER_OPTION: SeparationOption = {
  id: BS_ROFORMER_MODEL,
  stems: ['vocals', 'instrumental'],
  label: '2 STEMS · HQ vocals',
};

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
