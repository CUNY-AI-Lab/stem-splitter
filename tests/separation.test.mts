import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAudioSeparatorResult } from '../src/separation/audio-separator.ts';
import {
  BS_ROFORMER_MODEL,
  getSeparationOption,
  getSeparationOptions,
  modelIsAllowed,
  validateAndOrderStems,
} from '../src/separation/options.ts';

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

test('model choices state every track they produce', () => {
  assert.equal(getSeparationOption('bs_roformer_vocals')?.label, '2 STEMS · vocals + instrumental');
  assert.equal(
    getSeparationOption('htdemucs_ft')?.label,
    '4 STEMS · vocals + drums + bass + other'
  );
  assert.equal(
    getSeparationOption('htdemucs_6s')?.label,
    '6 STEMS · vocals + drums + bass + other + guitar + piano'
  );
});

test('two, four, and six track contracts accept any source and order only their expected outputs', () => {
  for (const model of ['bs_roformer_vocals', 'htdemucs_ft', 'htdemucs_6s']) {
    const expected = getSeparationOption(model)!.stems;
    const received = [...expected]
      .reverse()
      .map((name) => ({ name, url: `https://audio.invalid/${name}.mp3` }));
    assert.deepEqual(
      validateAndOrderStems(model, received).map(({ name }) => name),
      expected
    );
  }
});

test('two, four, and six track contracts reject missing or repeated outputs', () => {
  for (const model of ['bs_roformer_vocals', 'htdemucs_ft', 'htdemucs_6s']) {
    const expected = getSeparationOption(model)!.stems;
    const complete = expected.map((name) => ({
      name,
      url: `https://audio.invalid/${name}.mp3`,
    }));
    assert.throws(() => validateAndOrderStems(model, complete.slice(0, -1)), /incomplete/);
    assert.throws(
      () => validateAndOrderStems(model, [...complete.slice(0, -1), complete[0]]),
      /more than once/
    );
  }
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
