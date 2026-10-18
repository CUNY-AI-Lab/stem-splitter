import { createEncoder } from 'wasm-media-encoders/esnext';
import module from './vendor/lame-0.7.0.wasm';
import type { Mp3Encoder } from '../src/separation/compose-layers.ts';

/** Static module injection: no runtime compilation, network or browser worker. */
export async function createMp3Encoder(sampleRate: number): Promise<Mp3Encoder> {
  if (![32000,44100,48000].includes(sampleRate)) throw new Error('Unsupported output sample rate');
  const encoder = await createEncoder('audio/mpeg', module);
  encoder.configure({channels: 2, sampleRate, outputSampleRate: sampleRate as 32000 | 44100 | 48000, bitrate: 192});
  const left = new Float32Array(1152), right = new Float32Array(1152);
  return {
    encodeBuffer(l, r) {
      for (let i = 0; i < l.length; i++) { left[i] = l[i] / 32768; right[i] = r[i] / 32768; }
      return encoder.encode([left.subarray(0, l.length), right.subarray(0, r.length)]);
    },
    flush: () => encoder.finalize(),
  };
}
