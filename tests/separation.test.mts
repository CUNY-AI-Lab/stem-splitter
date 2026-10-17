import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findPinViolations,
  findYouTubePinViolations,
  resolveInputProperties,
} from '../scripts/lib/pin-check.mjs';
import {
  LOST_JOB_MESSAGE,
  audioSeparatorBackend,
  isAudioSeparatorPayload,
  parseAudioSeparatorResult,
} from '../src/separation/audio-separator.ts';
import { failoverBackend, splitExternalId } from '../src/separation/failover.ts';
import { getJobBackend, webhookMatchesJob } from '../src/separation/index.ts';
import type { SeparationBackend } from '../src/separation/types.ts';
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

test('core stem names are frozen literal contracts and auto is never a separator model', () => {
  assert.deepEqual(getSeparationOption('vocals_instrumental')?.stems, ['vocals', 'instrumental']);
  assert.deepEqual(getSeparationOption('htdemucs_ft')?.stems, [
    'vocals',
    'drums',
    'bass',
    'other',
  ]);
  assert.deepEqual(getSeparationOption('htdemucs_6s')?.stems, [
    'vocals',
    'drums',
    'bass',
    'other',
    'guitar',
    'piano',
  ]);
  assert.equal(getSeparationOption('auto'), undefined);
  assert.equal(modelIsAllowed('replicate', 'auto'), false);
  assert.equal(getReplicateRunner('auto'), undefined);
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
  for (const backend of ['replicate', 'audio-separator', 'failover']) {
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
  for (const backend of ['replicate', 'audio-separator', 'failover']) {
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

test('the YouTube version guard freezes the importer input and output contract', () => {
  const schema = {
    components: {
      schemas: {
        Input: {
          required: ['url'],
          properties: {
            url: { type: 'string', format: 'uri' },
            max_duration: { type: 'integer', default: 900 },
          },
        },
        Output: {
          type: 'object',
          required: ['audio', 'duration', 'title'],
          properties: {
            audio: { type: 'string', format: 'uri' },
            duration: { type: 'number' },
            title: { type: 'string' },
          },
        },
      },
    },
  };
  assert.deepEqual(findYouTubePinViolations(schema), []);

  const drifted = structuredClone(schema);
  delete drifted.components.schemas.Input.properties.max_duration;
  delete drifted.components.schemas.Output.properties.audio;
  drifted.components.schemas.Output.required = ['duration', 'title'];
  drifted.components.schemas.Input.required = [];
  const failures = findYouTubePinViolations(drifted);
  assert.ok(failures.some((line) => line.includes('input "max_duration"')));
  assert.ok(failures.some((line) => line.includes('output "audio"')));
  assert.ok(failures.some((line) => line.includes('input "url" is no longer required')));

  const typeDrift = structuredClone(schema);
  typeDrift.components.schemas.Input.properties.url.type = 'integer';
  typeDrift.components.schemas.Output.properties.duration.type = 'string';
  typeDrift.components.schemas.Output.required = ['audio', 'title'];
  const typeFailures = findYouTubePinViolations(typeDrift);
  assert.ok(typeFailures.some((line) => line.includes('input "url" is no longer a string')));
  assert.ok(typeFailures.some((line) => line.includes('output "duration" is no longer required')));
  assert.ok(typeFailures.some((line) => line.includes('output "duration" is no longer a number')));
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

// --- failover: self-hosted first, Replicate behind it ------------------------

const SEPARATOR = 'https://separator.test';
const SERVICE_UUID = '6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const failoverEnv = (overrides: Record<string, string | undefined> = {}) =>
  ({
    SEPARATION_BACKEND: 'failover',
    AUDIO_SEPARATOR_URL: SEPARATOR,
    AUDIO_SEPARATOR_TOKEN: 's'.repeat(64),
    REPLICATE_API_TOKEN: 'r8_test_token_000000000000',
    REPLICATE_MODEL_VERSION: 'a'.repeat(64),
    ...overrides,
  }) as never;

const startRequest = (model?: string) => ({
  jobId: 'job-1',
  audioUrl: 'https://app.test/api/local-sources/source.wav?sig=x',
  webhookUrl: 'https://app.test/api/webhooks/separation?job=job-1&token=t',
  model,
});

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** Replace global fetch for one test; every call is recorded. */
function stubFetch(t: { after(fn: () => void): void }, respond: (url: string) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    return respond(url);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const recordingBackend = (name: string, calls: string[], fail?: Error): SeparationBackend => ({
  async start(req) {
    calls.push(`${name}.start:${req.model}`);
    if (fail) throw fail;
    return { externalId: `${name}-id` };
  },
  parseResult: () => ({ status: 'processing' }),
  async fetchStatus(id) {
    calls.push(`${name}.status:${id}`);
    return { status: 'processing' };
  },
});

test('failover advertises exactly the Replicate catalogue and default', () => {
  const failover = getSeparationOptions('failover');
  const replicate = getSeparationOptions('replicate');
  // Byte-identical across a flip, including the catalogue name the frozen
  // listening baseline compares (scripts/lib/railway-baseline.mjs).
  assert.deepEqual(failover, replicate);
  assert.equal(failover.defaultModel, 'htdemucs_ft');
  assert.equal(modelIsAllowed('failover', TWO_STEM_MODEL), true);
  assert.equal(modelIsAllowed('failover', BS_ROFORMER_MODEL), false);
});

test('stored provider ids carry their provider', () => {
  assert.deepEqual(splitExternalId('as:3f1c'), { provider: 'audio-separator', providerId: '3f1c' });
  assert.deepEqual(splitExternalId('rep:abc123'), { provider: 'replicate', providerId: 'abc123' });
  assert.deepEqual(splitExternalId('abc123'), { provider: null, providerId: 'abc123' });
  assert.throws(() => splitExternalId('as:'), /empty/);
});

test('failover runs a split on the self-hosted service when it accepts the job', async (t) => {
  const calls = stubFetch(t, () => json({ id: 'svc-1', status: 'queued', stems: [], error: null }, 202));
  const { externalId } = await failoverBackend(failoverEnv(), {
    log: () => assert.fail('nothing should fall back'),
  }).start(startRequest('htdemucs_ft'));

  assert.equal(externalId, 'as:svc-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${SEPARATOR}/v1/jobs`);
  assert.ok(calls[0].init?.signal, 'the self-hosted start must carry a timeout signal');
  assert.equal(new Headers(calls[0].init?.headers).get('authorization'), `Bearer ${'s'.repeat(64)}`);
  assert.equal(JSON.parse(String(calls[0].init?.body)).model, 'htdemucs_ft');
});

test('failover hands the job to Replicate whenever the self-hosted start fails', async () => {
  const failures: [string, Error][] = [
    ['unreachable', new TypeError('fetch failed')],
    ['timed out', new DOMException('The operation timed out.', 'TimeoutError')],
    ['tunnel down', new Error('Audio Separator start failed (502)')],
    ['origin offline', new Error('Audio Separator start failed (530)')],
    ['busy', new Error('Audio Separator start failed (503): {"error":"separator busy"}')],
    ['bad token', new Error('Audio Separator start failed (401): {"error":"unauthorized"}')],
  ];
  for (const [label, error] of failures) {
    const calls: string[] = [];
    const logs: string[] = [];
    const { externalId } = await failoverBackend(failoverEnv(), {
      primary: recordingBackend('legion', calls, error),
      fallback: recordingBackend('replicate', calls),
      log: (message) => logs.push(message),
    }).start(startRequest('htdemucs_6s'));
    assert.equal(externalId, 'rep:replicate-id', label);
    assert.deepEqual(calls, ['legion.start:htdemucs_6s', 'replicate.start:htdemucs_6s'], label);
    assert.equal(logs.length, 1, label);
    assert.ok(logs[0].startsWith('[separation] job job-1 -> Replicate ('), label);
    assert.ok(!logs[0].includes('s'.repeat(64)), `${label} logged the separator token`);
  }
});

test('failover skips the self-hosted service for choices it cannot run or when unset', async () => {
  for (const [env, model] of [
    [failoverEnv(), TWO_STEM_MODEL],
    [failoverEnv({ AUDIO_SEPARATOR_URL: undefined }), 'htdemucs_ft'],
    // Plain http off loopback would send the token and the webhook secret in the clear.
    [failoverEnv({ AUDIO_SEPARATOR_URL: 'http://separator.test' }), 'htdemucs_ft'],
    [failoverEnv({ AUDIO_SEPARATOR_TOKEN: 'short' }), 'htdemucs_ft'],
  ] as const) {
    const calls: string[] = [];
    const { externalId } = await failoverBackend(env, {
      primary: recordingBackend('legion', calls),
      fallback: recordingBackend('replicate', calls),
      log: () => {},
    }).start(startRequest(model));
    assert.equal(externalId, 'rep:replicate-id');
    assert.deepEqual(calls, [`replicate.start:${model}`]);
  }
});

test('failover still fails the start when Replicate fails too', async () => {
  const calls: string[] = [];
  await assert.rejects(
    failoverBackend(failoverEnv(), {
      primary: recordingBackend('legion', calls, new TypeError('fetch failed')),
      fallback: recordingBackend('replicate', calls, new Error('Replicate start failed (402)')),
      log: () => {},
    }).start(startRequest('htdemucs_ft')),
    /Replicate start failed \(402\)/
  );
});

test('jobs are polled where they started, whatever the backend is now', async (t) => {
  const calls = stubFetch(t, (url) =>
    url.startsWith(SEPARATOR)
      ? json({ id: 'svc-1', status: 'processing', stems: [], error: null })
      : json({ id: 'p1', status: 'processing' })
  );
  const poll = async (env: never, externalId: string) => {
    const job = getJobBackend(env, externalId);
    return job.backend.fetchStatus(job.providerId);
  };

  // Rollback case: production is back on Replicate with a self-hosted job in flight.
  await poll(failoverEnv({ SEPARATION_BACKEND: 'replicate' }), 'as:svc-1');
  await poll(failoverEnv(), 'rep:p1');
  // Unprefixed ids predate the flip: Replicate prediction ids never contain a
  // dash, and the self-hosted service issues UUIDs.
  await poll(failoverEnv(), 'p1');
  await poll(failoverEnv(), SERVICE_UUID);
  await poll(failoverEnv({ SEPARATION_BACKEND: 'audio-separator' }), 'svc-1');

  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      `${SEPARATOR}/v1/jobs/svc-1`,
      'https://api.replicate.com/v1/predictions/p1',
      'https://api.replicate.com/v1/predictions/p1',
      `${SEPARATOR}/v1/jobs/${SERVICE_UUID}`,
      `${SEPARATOR}/v1/jobs/svc-1`,
    ]
  );
  assert.ok(calls[0].init?.signal, 'the self-hosted poll must carry a timeout signal');
});

test('a job the self-hosted service lost fails instead of polling forever', async (t) => {
  const responses = [
    json({ error: 'job not found' }, 404),
    new Response('<html>Not Found</html>', { status: 404 }),
    json({ error: 'job not found', detail: 'x' }, 404),
    new Response('bad gateway', { status: 502 }),
  ];
  stubFetch(t, () => responses.shift()!);
  const backend = audioSeparatorBackend(failoverEnv());

  assert.deepEqual(await backend.fetchStatus('svc-1'), {
    status: 'failed',
    error: LOST_JOB_MESSAGE,
  });
  // Anything short of the service's own answer could be a tunnel or proxy
  // fault, so the job keeps polling until the stall deadline.
  await assert.rejects(backend.fetchStatus('svc-1'), /status failed \(404\)/);
  await assert.rejects(backend.fetchStatus('svc-1'), /status failed \(404\)/);
  await assert.rejects(backend.fetchStatus('svc-1'), /status failed \(502\)/);
});

test('webhooks count only for the provider id the job stored', () => {
  assert.equal(webhookMatchesJob({ id: 'p1', status: 'succeeded' }, 'p1'), true);
  assert.equal(webhookMatchesJob({ id: 'svc-1', status: 'succeeded', stems: [] }, 'p1'), false);
  assert.equal(webhookMatchesJob({ status: 'succeeded' }, 'p1'), false);
  assert.equal(webhookMatchesJob(null, 'p1'), false);
});

test('service payloads are told apart from Replicate predictions', () => {
  assert.equal(isAudioSeparatorPayload({ id: 'svc-1', status: 'succeeded', stems: [] }), true);
  assert.equal(
    isAudioSeparatorPayload({ id: 'p1', status: 'succeeded', output: { vocals: 'https://x' } }),
    false
  );
  assert.equal(isAudioSeparatorPayload({ id: 'p1', status: 'starting', stems: [] }), false);
});

test('webhook URLs carry a per-job token, never the shared secret', async () => {
  const { jobWebhookToken, webhookTokenMatches } = await import('../src/separation/webhook-token.ts');
  const secret = 'w'.repeat(64);
  const token = await jobWebhookToken(secret, 'job-1');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!token.includes(secret));
  assert.equal(await webhookTokenMatches(secret, 'job-1', token), true);
  // Bound to the job and to the secret.
  assert.equal(await webhookTokenMatches(secret, 'job-2', token), false);
  assert.equal(await webhookTokenMatches('x'.repeat(64), 'job-1', token), false);
  assert.equal(await webhookTokenMatches(secret, undefined, token), false);
  // URLs issued before this change carried the raw secret; retries still land.
  assert.equal(await webhookTokenMatches(secret, 'job-1', secret), true);
  assert.equal(await webhookTokenMatches(secret, 'job-1', ''), false);
  assert.equal(await webhookTokenMatches('', 'job-1', ''), false);
});
