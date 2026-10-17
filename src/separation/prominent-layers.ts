/** These names come from the six-source separator, never a title or a relabelled
 * four-source bass track. Energy ranks estimated sources; it is not an
 * instrument-presence probability or a claim of perfect isolation. */
export const NAMED_LAYERS = ['vocals', 'drums', 'bass', 'guitar', 'piano'] as const;
export type NamedLayer = typeof NAMED_LAYERS[number];
export type SourceLayer = NamedLayer | 'other';
export interface LayerEnergy {
  name: SourceLayer;
  rmsDb: number;
  peak: number;
  samples: number;
  sampleRate: number;
}
export interface ProminentLayerPlan {
  parts: 2 | 4 | 6;
  selected: SourceLayer[];
  remainder: SourceLayer[];
  model: string;
}

/** Explicit four selects three named sources and a combined remainder. Auto
 * keeps six when more than three named sources carry substantial signal. A
 * source below -90 dBFS or 24 dB below the strongest source does not force an
 * extra displayed layer. Every source remains in exactly one output. */
export function prominentLayerPlan(energy: readonly LayerEnergy[], requested: 4 | 'auto'): ProminentLayerPlan {
  const names: SourceLayer[] = [...NAMED_LAYERS, 'other'];
  if (energy.length !== 6 || new Set(energy.map(e => e.name)).size !== 6 ||
    energy.some(e => !names.includes(e.name) || !Number.isFinite(e.rmsDb) ||
      !Number.isFinite(e.peak) || e.peak < 0 || !Number.isSafeInteger(e.samples) || e.samples <= 0 ||
      ![32000, 44100, 48000].includes(e.sampleRate))) throw new Error('Invalid measured separator sources');
  if (new Set(energy.map(e => e.sampleRate)).size !== 1 ||
    Math.max(...energy.map(e => e.samples)) - Math.min(...energy.map(e => e.samples)) > 1152) {
    throw new Error('Separator sources are not aligned');
  }
  const ranked = NAMED_LAYERS.map(name => energy.find(e => e.name === name)!)
    .sort((a, b) => b.rmsDb - a.rmsDb || NAMED_LAYERS.indexOf(a.name as NamedLayer) - NAMED_LAYERS.indexOf(b.name as NamedLayer));
  const floor = Math.max(-90, Math.max(...energy.map(e => e.rmsDb)) - 24);
  const substantial = ranked.filter(e => e.rmsDb >= floor).length;
  const parts = requested === 4 ? 4 : substantial > 3 ? 6 : substantial <= 1 ? 2 : 4;
  if (parts === 6) return { parts, selected: names, remainder: [], model: 'htdemucs_6s' };
  const chosen = new Set(ranked.slice(0, parts - 1).map(e => e.name));
  const selected = NAMED_LAYERS.filter(name => chosen.has(name));
  return { parts, selected, remainder: names.filter(name => !chosen.has(name)),
    model: `adaptive_${parts}__${selected.join('_')}` };
}

/** Only canonical, finite derived contracts can describe persisted results.
 * Derived ids are not provider runners and must never be accepted as starts. */
export function derivedLayerNames(model: string): SourceLayer[] | null {
  const match = /^adaptive_([24])__(.+)$/.exec(model);
  if (!match) return null;
  const selected = match[2].split('_');
  if (selected.length !== Number(match[1]) - 1 || new Set(selected).size !== selected.length ||
    selected.some(name => !NAMED_LAYERS.includes(name as NamedLayer)) ||
    NAMED_LAYERS.filter(name => selected.includes(name)).join('_') !== selected.join('_')) return null;
  return [...selected as NamedLayer[], 'other'];
}
