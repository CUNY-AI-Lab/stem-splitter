import { NAMED_LAYERS, type LayerEnergy } from './prominent-layers.ts';

export const ENERGY_WINDOW_SECONDS = 0.05;
const SHARED_WINDOWS = 3;
const MAX_WINDOWS = 18003; // At most 900.1 seconds, including a partial window.
export interface WindowedLayerEnergy {
  energy: LayerEnergy;
  windows: number[];
}
export type AutoQualityDetails = {
  durationSeconds: number;
  windowStartSeconds: number;
  windowSeconds: number;
  qualifyingSources: number;
  minimumEnergyFraction: number;
};

export class AutoOutputQualityError extends Error {
  readonly reason = 'concentrated_shared_energy';
  readonly details: AutoQualityDetails;
  constructor(details: AutoQualityDetails) {
    super('The audio separation failed its quality check. Your split allowance is unchanged. Choose a split option and try again.');
    this.name = 'AutoOutputQualityError';
    this.details = details;
  }
}

/** Detect concentrated shared energy in an experimental adaptive result.
 * A failed quality check ends the operation; it never changes the selected
 * model or infers instrument presence. Stereo energy preserves polarity. */
export function concentratedSharedEnergy(measured: readonly WindowedLayerEnergy[]): AutoQualityDetails | null {
  const duration = Math.min(...measured.map(({ energy }) => energy.samples / energy.sampleRate));
  for (const { energy, windows } of measured) {
    if (windows.length > MAX_WINDOWS || windows.length !== Math.ceil(energy.samples / (energy.sampleRate * ENERGY_WINDOW_SECONDS)) ||
      windows.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid measured energy windows');
  }
  if (!Number.isFinite(duration) || duration < 5 || duration > 900.1) return null;
  const named = measured.filter(({ energy }) => NAMED_LAYERS.includes(energy.name as typeof NAMED_LAYERS[number]));
  if (named.length !== NAMED_LAYERS.length || new Set(named.map(({ energy }) => energy.name)).size !== NAMED_LAYERS.length) throw new Error('Missing measured source');
  const totals = named.map(({ windows }) => windows.reduce((sum, value) => sum + value, 0));
  const count = Math.min(...named.map(({ windows }) => windows.length));
  for (let start = 0; start <= count - SHARED_WINDOWS; start++) {
    const fractions = named.map(({ windows }, index) => totals[index] > 0
      ? Math.min(1, (windows[start] + windows[start + 1] + windows[start + 2]) / totals[index]) : 0);
    const qualifying = fractions.filter(fraction => fraction > 0.5);
    if (qualifying.length >= 4) return {
      durationSeconds: duration,
      windowStartSeconds: start * ENERGY_WINDOW_SECONDS,
      windowSeconds: 0.15,
      qualifyingSources: qualifying.length,
      minimumEnergyFraction: Math.min(...qualifying),
    };
  }
  return null;
}
