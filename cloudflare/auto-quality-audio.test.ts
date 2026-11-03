import test from 'node:test';
import assert from 'node:assert/strict';
import { composeProminentLayers } from '../src/separation/compose-layers.ts';
import { AutoOutputQualityError, concentratedSharedEnergy, type WindowedLayerEnergy } from '../src/separation/quality.ts';
import { NAMED_LAYERS, type SourceLayer } from '../src/separation/prominent-layers.ts';
import type { PcmDecoder } from '../src/reliability/media.ts';

const names: SourceLayer[] = [...NAMED_LAYERS, 'other'];
function measurements(peaks: number[], seconds = 10, scale = 1): WindowedLayerEnergy[] {
  return names.map((name, index) => {
    const windows = Array(seconds * 20).fill(index === 5 ? 0.5 * scale : 0.0001 * scale);
    if (peaks[index] >= 0) windows[peaks[index]] = scale;
    return { energy: { name, samples: seconds * 32000, sampleRate: 32000, rmsDb: -20, peak: .9 }, windows };
  });
}

test('Auto uses one shared 150ms energy window, retaining sustained, dispersed, silent and short sources', () => {
  const shared = measurements([160, 161, 162, 160, -1, -1]);
  const decision = concentratedSharedEnergy(shared)!;
  assert.equal(decision.qualifyingSources, 4);
  assert.ok(decision.minimumEnergyFraction > .5);
  assert.equal(concentratedSharedEnergy(measurements([160, 161, 163, 160, -1, -1])), null, 'fourth event lies outside the common window');
  assert.equal(concentratedSharedEnergy(measurements([10, 40, 80, 120, 160, -1])), null, 'separate instrument entries retain their parts');
  assert.equal(concentratedSharedEnergy(measurements([-1,-1,-1,-1,-1,-1])), null, 'sustained estimates retain their parts');
  assert.equal(concentratedSharedEnergy(measurements([60,60,60,60,60,-1], 4)), null, 'short recordings retain the prior selection');
  assert.ok(concentratedSharedEnergy(measurements([60,60,60,60,60,-1], 5)), 'five-second recordings qualify');
  assert.equal(concentratedSharedEnergy(shared.map(row => ({ ...row, windows: row.windows.map(() => 0) }))), null);
  const half = measurements([-1,-1,-1,-1,-1,-1]).map(row => ({ ...row, windows: row.windows.map((_,index) => index === 20 || index === 100 ? 1 : 0) }));
  assert.equal(concentratedSharedEnergy(half), null, 'a shared window must contain more than half the energy');
  const quiet = concentratedSharedEnergy(measurements([160,161,162,160,-1,-1], 10, 1e-8))!;
  assert.equal(quiet.qualifyingSources, decision.qualifyingSources);
  assert.equal(quiet.windowStartSeconds, decision.windowStartSeconds);
  assert.ok(Math.abs(quiet.minimumEnergyFraction - decision.minimumEnergyFraction) < 1e-12);
  const invalid = measurements([160,161,162,160,-1,-1]); invalid[0].windows[0] = NaN;
  assert.throws(() => concentratedSharedEnergy(invalid), /Invalid measured energy windows/);
});

function composition(shared: boolean, requested: 4 | 'auto', scale = 1, invertRight = false) {
  const rate = 32000, count = rate * 10, chunk = 65536;
  let writes = 0, encoders = 0;
  const run = () => composeProminentLayers({
    requested,
    sources: names.map((name, index) => ({ name, open: async () => new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(4096 * Math.ceil(count / chunk)).fill(index)); controller.close();
    } }) })),
    createDecoder: () => {
      let offset = 0;
      return { ready: Promise.resolve(), free() {}, decode(bytes: Uint8Array) {
        const index = bytes[0], length = Math.min(chunk, count - offset), left = new Float32Array(length), right = new Float32Array(length);
        for (let i = 0; i < length; i++) {
          const time = (offset + i) / rate;
          const level = index === 5 ? .2 : shared ? (time >= 8.001 && time < 8.041 ? .7 : .00001) : .06;
          left[i] = Math.sin((offset + i) * .045) * level * scale; right[i] = left[i] * (invertRight ? -1 : 1);
        }
        offset += length;
        return { errors: [], channelData: [left, right], samplesDecoded: length, sampleRate: rate };
      } } satisfies PcmDecoder;
    },
    createEncoder: () => { encoders++; return { encodeBuffer: () => new Uint8Array([1]), flush: () => new Uint8Array([1]) }; },
    write: async name => { writes++; return `display/${name}.mp3`; },
  });
  return { run, counts: () => ({ writes, encoders }) };
}

test('streamed stereo energy requests a genuine Auto fallback before any encoding or publication', async () => {
  for (const [scale, invert] of [[1,false],[.0001,false],[1,true]] as const) {
    const fixture = composition(true, 'auto', scale, invert);
    await assert.rejects(fixture.run(), (error: unknown) => {
      assert.ok(error instanceof AutoOutputQualityError);
      assert.equal(error.reason, 'concentrated_shared_energy');
      assert.equal(error.details.qualifyingSources, 5);
      assert.ok(Object.values(error.details).every(value => Number.isFinite(value) && value >= 0 && value <= 900.1));
      return true;
    });
    assert.deepEqual(fixture.counts(), { writes: 0, encoders: 0 });
  }
});

test('ordinary six-part Auto audio and explicit four-part choices preserve their existing paths', async () => {
  const sustained = composition(false, 'auto', .01, true);
  assert.equal((await sustained.run()).plan.parts, 6);
  assert.deepEqual(sustained.counts(), { writes: 0, encoders: 0 });
  const explicit = composition(true, 4);
  assert.equal((await explicit.run()).plan.parts, 4);
  assert.deepEqual(explicit.counts(), { writes: 4, encoders: 4 });
});
