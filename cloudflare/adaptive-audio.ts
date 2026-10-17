import { Mp3Encoder } from '@breezystack/lamejs';
import { composeProminentLayers } from '../src/separation/compose-layers.ts';
import { createMp3Decoder } from './audio-validator.ts';
export type AdaptiveAudioInput = Omit<Parameters<typeof composeProminentLayers>[0], 'createDecoder' | 'createEncoder'>;
export const composeStemAudio = (input: AdaptiveAudioInput) => composeProminentLayers({
  ...input, createDecoder: createMp3Decoder, createEncoder: sampleRate => new Mp3Encoder(2, sampleRate, 192),
});
