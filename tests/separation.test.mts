import assert from 'node:assert/strict';
import test from 'node:test';

import { findPinViolations, resolveInputProperties } from '../scripts/lib/pin-check.mjs';
import { parseAudioSeparatorResult } from '../src/separation/audio-separator.ts';
import {
  BS_ROFORMER_MODEL,
  TWO_STEM_MODEL,
  allSeparationOptions,
  getReplicateRunner,
  getSeparationOption,
  getSeparationOptions,
  modelIsAllowed,
  replicateContractSurface,
  validateAndOrderStems,
} from '../src/separation/options.ts';

const CONTRACT_MODELS = [
  BS_ROFORMER_MODEL,
  TWO_STEM_MODEL,
  'htdemucs_ft',
  'htdemucs_6s',
];

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
  assert.deepEqual(
    {
      label: getSeparationOption('bs_roformer_vocals')?.label,
      engine: getSeparationOption('bs_roformer_vocals')?.engine,
    },
    {
      label: '2 parts: voice, everything else',
      engine: 'BS-ROFORMER',
    }
  );
  assert.equal(
    getSeparationOption('htdemucs_ft')?.label,
    '4 parts: voice, percussion, low end, the rest'
  );
  assert.equal(
    getSeparationOption('htdemucs_6s')?.label,
    '6 parts: adds plucked strings and keys'
  );
  assert.equal(getSeparationOption('htdemucs_ft')?.engine, 'DEMUCS');
  assert.equal(getSeparationOption('htdemucs_6s')?.engine, 'DEMUCS');
});

test('two, four, and six track contracts accept any source and order only their expected outputs', () => {
  for (const model of CONTRACT_MODELS) {
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
  for (const model of CONTRACT_MODELS) {
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

test('Replicate advertises a two-track choice without claiming the RoFormer engine', () => {
  const options = getSeparationOptions('replicate');
  assert.deepEqual(
    options.models.map((model) => model.id),
    [TWO_STEM_MODEL, 'htdemucs_ft', 'htdemucs_6s']
  );
  const twoTrack = getSeparationOption(TWO_STEM_MODEL)!;
  assert.deepEqual(twoTrack.stems, ['vocals', 'instrumental']);
  assert.equal(twoTrack.label, '2 parts: voice, everything else');
  // It runs Demucs in karaoke mode, so it must not advertise BS-RoFormer.
  assert.equal(twoTrack.engine, 'DEMUCS');
  assert.equal(modelIsAllowed('replicate', TWO_STEM_MODEL), true);
  // The local profile stays local; the Replicate one stays off the local host.
  assert.equal(modelIsAllowed('audio-separator', TWO_STEM_MODEL), false);
});

test('no backend offers two choices under the same label', () => {
  for (const backend of ['replicate', 'audio-separator']) {
    const labels = getSeparationOptions(backend).models.map((model) => model.label);
    assert.equal(new Set(labels).size, labels.length, `duplicate label on ${backend}`);
  }
});

test('the two-track Replicate choice asks Demucs to isolate vocals', () => {
  const input = getReplicateRunner(TWO_STEM_MODEL)!.input();
  assert.equal(input.model, 'htdemucs_ft');
  assert.equal(input.stem, 'vocals');
  assert.equal(input.output_format, 'mp3');
  assert.equal(input.mp3_bitrate, 192);
  // The four-track choice must not inherit the isolation flag.
  assert.equal(getReplicateRunner('htdemucs_ft')!.input().stem, undefined);
});

test('Demucs no_vocals is renamed to the instrumental contract name', () => {
  assert.deepEqual(
    validateAndOrderStems(TWO_STEM_MODEL, [
      { name: 'no_vocals', url: 'https://audio.invalid/no_vocals.mp3' },
      { name: 'vocals', url: 'https://audio.invalid/vocals.mp3' },
    ]),
    [
      { name: 'vocals', url: 'https://audio.invalid/vocals.mp3' },
      { name: 'instrumental', url: 'https://audio.invalid/no_vocals.mp3' },
    ]
  );
});

test('an unmapped provider track name fails the job instead of being guessed at', () => {
  assert.throws(
    () =>
      validateAndOrderStems(TWO_STEM_MODEL, [
        { name: 'vocals', url: 'https://audio.invalid/vocals.mp3' },
        { name: 'accompaniment', url: 'https://audio.invalid/accompaniment.mp3' },
      ]),
    /unexpected accompaniment/
  );
});

test('the version guard reads every model id and input key from the catalogue', () => {
  const surface = replicateContractSurface();
  assert.deepEqual(surface.modelIds, ['htdemucs_6s', 'htdemucs_ft']);
  assert.deepEqual(surface.inputKeys, [
    'audio',
    'model',
    'mp3_bitrate',
    'output_format',
    'stem',
  ]);
  assert.deepEqual(surface.versionVars, ['REPLICATE_MODEL_VERSION']);
});

test('the options endpoint never leaks runner wiring to the browser', () => {
  for (const backend of ['replicate', 'audio-separator']) {
    // What the route actually ships: JSON.parse(JSON.stringify(...)) is the
    // same projection Hono's c.json() performs.
    const wire = JSON.parse(JSON.stringify(getSeparationOptions(backend)));
    for (const model of wire.models) {
      assert.deepEqual(
        Object.keys(model).sort(),
        ['engine', 'id', 'label', 'stems'],
        `${backend} leaked internal fields`
      );
    }
  }
});

test('catalogue rows stay internally consistent', () => {
  const options = allSeparationOptions();
  assert.equal(new Set(options.map((option) => option.id)).size, options.length, 'duplicate id');

  for (const option of options) {
    const backends = Object.keys(option.runners);
    assert.ok(backends.length > 0, `${option.id} has no runner`);
    assert.ok(option.stems.length > 0, `${option.id} has no stems`);

    const rename = option.runners.replicate?.outputNames ?? {};
    for (const [providerName, contractName] of Object.entries(rename)) {
      // A typo'd target would fail every job of this option at runtime.
      assert.ok(
        option.stems.includes(contractName),
        `${option.id} renames to "${contractName}", which is not one of its tracks`
      );
      // An alias must never shadow a channel the provider legitimately returns.
      assert.ok(
        !option.stems.includes(providerName),
        `${option.id} renames "${providerName}", which is already one of its tracks`
      );
    }
  }

  for (const backend of ['replicate', 'audio-separator']) {
    const defaults = options.filter(
      (option) => backend in option.runners && option.defaultFor?.includes(backend)
    );
    assert.equal(defaults.length, 1, `${backend} must have exactly one default choice`);
  }
});

test('a backend with no runners advertises nothing rather than an unrunnable list', () => {
  // modal.ts is a stub that throws on start(); offering it choices would
  // promise a split that cannot run.
  const options = getSeparationOptions('modal');
  assert.deepEqual(options.models, []);
  assert.equal(options.defaultModel, '');
  assert.equal(modelIsAllowed('modal', 'htdemucs_ft'), false);
});

// The pinned version's published schema, in the shape Replicate serves it
// (enums behind allOf/$ref). This is what the catalogue currently relies on.
const PINNED_SCHEMA = {
  components: {
    schemas: {
      model: {
        enum: ['htdemucs', 'htdemucs_ft', 'htdemucs_6s', 'hdemucs_mmi', 'mdx_q', 'mdx_extra_q'],
        type: 'string',
      },
      stem: { enum: ['none', 'vocals', 'drums', 'bass', 'other', 'guitar', 'piano'], type: 'string' },
      output_format: { enum: ['mp3', 'wav', 'flac'], type: 'string' },
      Input: {
        properties: {
          audio: { type: 'string', format: 'uri' },
          model: { allOf: [{ $ref: '#/components/schemas/model' }], default: 'htdemucs' },
          stem: { allOf: [{ $ref: '#/components/schemas/stem' }], default: 'none' },
          output_format: { allOf: [{ $ref: '#/components/schemas/output_format' }], default: 'mp3' },
          mp3_bitrate: { type: 'integer', default: 320 },
        },
      },
    },
  },
};

test('the version guard accepts the pinned schema the catalogue was built against', () => {
  const properties = resolveInputProperties(PINNED_SCHEMA);
  assert.deepEqual(properties.model.enum?.includes('htdemucs_6s'), true);
  assert.deepEqual(findPinViolations(replicateContractSurface(), properties), []);
});

test('the version guard catches the upstream drift that would break 4 and 6 STEMS', () => {
  // Ryan5453/demucs-next HEAD: htdemucs only, output_format renamed to format,
  // mp3_bitrate dropped. Bumping to it blind must fail loudly, not silently.
  const drifted = resolveInputProperties({
    components: {
      schemas: {
        model: { enum: ['htdemucs'], type: 'string' },
        isolate_stem: { enum: ['none', 'vocals', 'drums', 'bass', 'other'], type: 'string' },
        Input: {
          properties: {
            audio: { type: 'string', format: 'uri' },
            model: { allOf: [{ $ref: '#/components/schemas/model' }], default: 'htdemucs' },
            format: { type: 'string', default: 'wav' },
            isolate_stem: { allOf: [{ $ref: '#/components/schemas/isolate_stem' }] },
          },
        },
      },
    },
  });
  const failures = findPinViolations(replicateContractSurface(), drifted);
  assert.ok(
    failures.some((line) => line.includes('"htdemucs_ft"')),
    'must report the dropped 4-track model'
  );
  assert.ok(
    failures.some((line) => line.includes('"htdemucs_6s"')),
    'must report the dropped 6-track model'
  );
  assert.ok(
    failures.some((line) => line.includes('"output_format"')),
    'must report the renamed output format input'
  );
  assert.ok(
    failures.some((line) => line.includes('"mp3_bitrate"')),
    'must report the dropped bitrate input'
  );
  assert.ok(
    failures.some((line) => line.includes('"stem"')),
    'must report that the 2-track isolation input is gone'
  );
});

test('the version guard refuses to pass when it cannot read a schema', () => {
  assert.deepEqual(findPinViolations(replicateContractSurface(), {}), [
    'the pinned version exposes no Input schema — cannot verify anything',
  ]);
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
