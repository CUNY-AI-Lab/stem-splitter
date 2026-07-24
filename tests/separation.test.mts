import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAudioSeparatorResult } from '../src/separation/audio-separator.ts';
import { BS_ROFORMER_MODEL, getSeparationOptions, modelIsAllowed } from '../src/separation/options.ts';

test('audio-separator backend advertises BS-RoFormer as its two-track default', () => {
  const options = getSeparationOptions('audio-separator');
  assert.equal(options.defaultModel, BS_ROFORMER_MODEL);
  assert.deepEqual(options.models[0].stems, ['vocals', 'instrumental']);
  assert.equal(modelIsAllowed('audio-separator', BS_ROFORMER_MODEL), true);
});

test('Replicate never advertises or accepts the local BS-RoFormer profile', () => {
  const options = getSeparationOptions('replicate');
  assert.equal(options.defaultModel, 'htdemucs_ft');
  assert.equal(options.models.some((model) => model.id === BS_ROFORMER_MODEL), false);
  assert.equal(modelIsAllowed('replicate', BS_ROFORMER_MODEL), false);
});

test('Audio Separator result parser normalizes the two tracks', () => {
  assert.deepEqual(
    parseAudioSeparatorResult({
      id: 'job-1',
      status: 'succeeded',
      stems: [
        { name: 'vocals', url: 'http://127.0.0.1:8765/v1/files/job-1/vocals.mp3' },
        { name: 'instrumental', url: 'http://127.0.0.1:8765/v1/files/job-1/instrumental.mp3' },
      ],
    }),
    {
      status: 'succeeded',
      stems: [
        { name: 'vocals', url: 'http://127.0.0.1:8765/v1/files/job-1/vocals.mp3' },
        { name: 'instrumental', url: 'http://127.0.0.1:8765/v1/files/job-1/instrumental.mp3' },
      ],
    }
  );
});

test('Audio Separator result parser rejects malformed success payloads', () => {
  assert.throws(
    () =>
      parseAudioSeparatorResult({
        status: 'succeeded',
        stems: [{ name: '../vocals', url: 'file:///tmp/vocals.mp3' }],
      }),
    /valid stem URLs/
  );
});
