import test from 'node:test';
import assert from 'node:assert/strict';
import { prominentLayerPlan, derivedLayerNames, type LayerEnergy } from '../src/separation/prominent-layers.ts';
const energy = (levels: number[]): LayerEnergy[] => ['vocals','drums','bass','guitar','piano','other'].map((name, i) => ({
  name: name as LayerEnergy['name'], rmsDb: levels[i], peak: .5, samples: 44100 * 20, sampleRate: 44100,
}));

test('measured guitar replaces faint bass in a four-layer result without losing any source', () => {
  const source = energy([-28.47,-27.74,-43.67,-15.35,-45.23,-28.81]);
  for (const requested of [4, 'auto'] as const) {
    const plan = prominentLayerPlan(source, requested);
    assert.equal(plan.parts, 4);
    assert.deepEqual(plan.selected, ['vocals','drums','guitar']);
    assert.deepEqual(plan.remainder, ['bass','piano','other']);
    assert.deepEqual(derivedLayerNames(plan.model), ['vocals','drums','guitar','other']);
    assert.equal(new Set([...plan.selected,...plan.remainder]).size, 6);
  }
});

test('prominent bass and piano can each earn the third named layer', () => {
  assert.deepEqual(prominentLayerPlan(energy([-18,-20,-22,-48,-52,-25]), 4).selected, ['vocals','drums','bass']);
  assert.deepEqual(prominentLayerPlan(energy([-18,-20,-48,-52,-22,-25]), 4).selected, ['vocals','drums','piano']);
});

test('Auto retains six for dense sources and combines sparse sources into two', () => {
  assert.equal(prominentLayerPlan(energy([-20,-22,-24,-25,-26,-23]), 'auto').parts, 6);
  const sparse = prominentLayerPlan(energy([-18,-60,-65,-70,-70,-22]), 'auto');
  assert.deepEqual(sparse.selected, ['vocals']);
  assert.deepEqual(sparse.remainder, ['drums','bass','guitar','piano','other']);
  assert.equal(sparse.parts, 2);
});

test('uniformly quieter mastering does not change which instruments earn layers', () => {
  const loud = energy([-20,-22,-24,-25,-26,-23]);
  const quiet = loud.map(e => ({...e,rmsDb:e.rmsDb-35,peak:e.peak/60}));
  assert.equal(prominentLayerPlan(loud,'auto').parts, prominentLayerPlan(quiet,'auto').parts);
  assert.deepEqual(prominentLayerPlan(loud,4).selected, prominentLayerPlan(quiet,4).selected);
});

test('reject corrupt, duplicated or misaligned measurements and fabricated derived contracts', () => {
  const input = energy([-18,-20,-22,-48,-52,-25]);
  assert.throws(() => prominentLayerPlan(input.slice(1), 4));
  assert.throws(() => prominentLayerPlan(input.map((e,i) => i === 2 ? {...e,rmsDb: NaN} : e), 4));
  assert.throws(() => prominentLayerPlan(input.map((e,i) => i === 2 ? {...e,samples:100} : e), 4));
  for (const bad of ['adaptive_4__guitar_drums_vocals','adaptive_4__vocals_drums_bass_other','adaptive_2__flute','adaptive_4__vocals_vocals_guitar']) {
    assert.equal(derivedLayerNames(bad), null);
  }
});
