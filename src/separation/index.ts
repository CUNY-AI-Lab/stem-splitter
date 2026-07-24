import type { Env } from '../env';
import type { SeparationBackend } from './types';
import { replicateBackend } from './replicate';
import { modalBackend } from './modal';
import { audioSeparatorBackend } from './audio-separator';

export type { SeparationBackend, SeparationResult, StemRef } from './types';

export function getBackend(env: Env): SeparationBackend {
  switch (env.SEPARATION_BACKEND ?? 'replicate') {
    case 'replicate':
      return replicateBackend(env);
    case 'modal':
      return modalBackend(env);
    case 'audio-separator':
      return audioSeparatorBackend(env);
    default:
      throw new Error(`Unknown SEPARATION_BACKEND: ${env.SEPARATION_BACKEND}`);
  }
}
