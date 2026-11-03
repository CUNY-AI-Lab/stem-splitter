import test from 'node:test';
import assert from 'node:assert/strict';
import { prominentLayerPlan, derivedLayerNames, InsufficientLayerEvidenceError, NAMED_LAYERS, type LayerEnergy } from '../src/separation/prominent-layers.ts';
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

test('uniformly quieter mastering above the absolute floor preserves the selected separator estimates', () => {
  const loud = energy([-20,-22,-24,-25,-26,-23]);
  const quiet = loud.map(e => ({...e,rmsDb:e.rmsDb-35,peak:e.peak/60}));
  assert.equal(prominentLayerPlan(loud,'auto').parts, prominentLayerPlan(quiet,'auto').parts);
  assert.deepEqual(prominentLayerPlan(loud,4).selected, prominentLayerPlan(quiet,4).selected);
});

test('silence and other-dominant audio abstain instead of assigning a named estimate', () => {
  for (const levels of [[-200,-200,-200,-200,-200,-200], [-91,-92,-93,-94,-95,-96], [-80,-82,-84,-86,-88,-12]]) {
    for (const requested of [4, 'auto'] as const) assert.throws(() => prominentLayerPlan(energy(levels), requested), (error: unknown) => {
      assert.ok(error instanceof InsufficientLayerEvidenceError);
      assert.equal(error.retryable, false);
      assert.equal(error.reason, 'insufficient_named_source_energy');
      assert.equal(error.details.eligibleNamedSources, 0);
      assert.equal(error.details.requested, requested);
      return true;
    });
  }
});

test('Auto cannot fill unsupported named slots in four- or six-part partitions', () => {
  for (const [levels, parts, eligible] of [
    [[-80,-20,-80,-80,-22,-25], 4, 2],
    [[-20,-22,-24,-26,-80,-25], 6, 4],
  ] as const) assert.throws(() => prominentLayerPlan(energy([...levels]), 'auto'), (error: unknown) => {
    assert.ok(error instanceof InsufficientLayerEvidenceError);
    assert.equal(error.details.parts, parts);
    assert.equal(error.details.requiredNamedSources, parts - 1);
    assert.equal(error.details.eligibleNamedSources, eligible);
    return true;
  });
  assert.throws(() => prominentLayerPlan(energy([-80,-20,-80,-80,-22,-25]), 4), InsufficientLayerEvidenceError);
});

test('absolute and relative floor boundaries are inclusive without admitting a below-floor estimate', () => {
  const epsilon = .000001;
  for (const [floor, strongest, middle] of [[-90, -100, -85], [-44, -20, -30]]) {
    for (const offset of [0, epsilon]) {
      const plan = prominentLayerPlan(energy([floor + offset,middle,-110,-110,middle,strongest]), 4);
      assert.deepEqual(plan.selected, ['vocals','drums','piano']);
    }
    assert.throws(() => prominentLayerPlan(energy([floor - epsilon,middle,-110,-110,middle,strongest]), 4),
      (error: unknown) => {
        assert.ok(error instanceof InsufficientLayerEvidenceError);
        assert.equal(error.details.floorDb, floor);
        assert.equal(error.details.eligibleNamedSources, 2);
        return true;
      });
  }
});

test('tied estimates use canonical order regardless of measurement order', () => {
  const source = energy([-20,-20,-20,-20,-20,-20]);
  assert.deepEqual(prominentLayerPlan(source, 4).selected, ['vocals','drums','bass']);
  assert.deepEqual(prominentLayerPlan([...source].reverse(), 4), prominentLayerPlan(source, 4));
});

test('every accepted partition contains all six sources exactly once and only eligible named selections', () => {
  const names = [...NAMED_LAYERS, 'other'];
  for (let eligible = 0; eligible <= 5; eligible++) {
    const measured = energy([...NAMED_LAYERS.map((_, index) => index < eligible ? -20 : -80), -20]);
    for (const requested of [4, 'auto'] as const) {
      if (requested === 4 ? eligible < 3 : ![1,3,5].includes(eligible)) {
        assert.throws(() => prominentLayerPlan(measured, requested), InsufficientLayerEvidenceError);
        continue;
      }
      const plan = prominentLayerPlan(measured, requested);
      const partition = [...plan.selected, ...plan.remainder];
      assert.equal(partition.length, 6);
      assert.deepEqual([...partition].sort(), [...names].sort());
      assert.equal(new Set(partition).size, 6);
      for (const name of plan.selected.filter(name => name !== 'other')) {
        assert.ok(measured.find(row => row.name === name)!.rmsDb >= -44);
      }
    }
  }
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
