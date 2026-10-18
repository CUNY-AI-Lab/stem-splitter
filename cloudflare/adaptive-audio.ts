import { composeProminentLayers, compositionGain, encodeLayer, measureLayer } from '../src/separation/compose-layers.ts';
import { createMp3Decoder } from './audio-validator.ts';
import { createMp3Encoder } from './mp3-encoder.ts';
import { InvalidStemAudioError, mp3FrameInfo } from '../src/reliability/media.ts';
import type { OutputAudio } from '../src/reliability/output.ts';
export type AdaptiveAudioInput = Omit<Parameters<typeof composeProminentLayers>[0], 'createDecoder' | 'createEncoder'>;
export const composeStemAudio = (input: AdaptiveAudioInput) => composeProminentLayers({
  ...input, createDecoder: createMp3Decoder, createEncoder: createMp3Encoder,
});
export const outputAudio: OutputAudio = {
  async measure(data, name, checkpoint) {
    const frames = mp3FrameInfo(data);
    if (!frames) throw new InvalidStemAudioError('Invalid source frames');
    const energy = await measureLayer({name, open: async () => new Blob([data]).stream()}, createMp3Decoder, checkpoint);
    const seconds = energy.samples / energy.sampleRate;
    if (energy.sampleRate !== frames.sampleRate || seconds > frames.seconds + .1 || frames.seconds - seconds > .5) {
      throw new InvalidStemAudioError('Incomplete source decode');
    }
    return energy;
  },
  gain: (sources, energy, plan, checkpoint) => compositionGain(sources, energy, plan, createMp3Decoder, checkpoint),
  encode: input => encodeLayer({...input, createDecoder: createMp3Decoder, createEncoder: createMp3Encoder}),
};
