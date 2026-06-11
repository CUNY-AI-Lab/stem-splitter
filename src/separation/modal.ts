import type { Env } from '../env';
import type { SeparationBackend } from './types';

// Stub for a Modal (modal.com) backend — the cheaper, more controllable
// alternative: you deploy your own Demucs (or BS-RoFormer) container as a
// Modal web endpoint with scale-to-zero GPUs, and Modal's free monthly
// credits likely cover a full class's semester at ~2k songs.
//
// To implement:
//   1. Write a Modal app: a function that takes { audio_url, webhook_url },
//      runs `demucs -n htdemucs_ft --mp3`, and POSTs stem URLs (or uploads
//      them somewhere fetchable) to webhook_url with the same JSON shape
//      parseResult expects below.
//   2. Expose it as a Modal web endpoint; put its URL + auth token in env.
//   3. Fill in start/parseResult/fetchStatus and set SEPARATION_BACKEND=modal.

export function modalBackend(_env: Env): SeparationBackend {
  return {
    async start() {
      throw new Error('Modal backend not implemented yet — see src/separation/modal.ts');
    },
    parseResult() {
      throw new Error('Modal backend not implemented yet — see src/separation/modal.ts');
    },
    async fetchStatus() {
      throw new Error('Modal backend not implemented yet — see src/separation/modal.ts');
    },
  };
}
