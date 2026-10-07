// The root entry also constructs browser WebWorker helpers. Use the pinned
// main-thread entry so no browser Worker global is needed in workerd.
// @ts-expect-error Upstream only types its root exports. The exact pin is tested below.
import MPEGDecoder from './node_modules/mpg123-decoder/src/MPEGDecoder.js';
import type { MPEGDecoder as DecoderType } from 'mpg123-decoder';
import module from './vendor/mpg123-1.0.3.wasm';
import { validateMp3Pcm } from '../src/reliability/media.ts';
// The pinned package's module injection hook bypasses runtime compilation.
// Wrangler emits a compiled Wasm module; no code or binaries are fetched.
(MPEGDecoder as unknown as {module:WebAssembly.Module}).module=module;
export const validateStemAudio=(data:ArrayBuffer)=>validateMp3Pcm(data,()=>new MPEGDecoder() as DecoderType);
