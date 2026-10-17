import type { PcmDecoder } from '../reliability/media.ts';
import { prominentLayerPlan, type LayerEnergy, type SourceLayer, type ProminentLayerPlan } from './prominent-layers.ts';

export interface EncodedLayerSource {
  name: SourceLayer;
  /** A fresh, trusted stored source for each pass. Never a browser-supplied PCM claim. */
  open(): Promise<ReadableStream<Uint8Array>>;
}
export interface Mp3Encoder {
  encodeBuffer(left: Int16Array, right: Int16Array): Uint8Array;
  flush(): Uint8Array;
}
interface Block { left: Float32Array; right: Float32Array; length: number }
const FRAME = 1152;
const MAX_BYTES = 24 * 1024 * 1024;

/** Bounded streaming decode. No full-track PCM or unbounded input chunks are retained. */
class PcmReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private raw: Uint8Array = new Uint8Array(0);
  private rawAt = 0;
  private pcm: Float32Array[] = [];
  private pcmAt = 0;
  private ended = false;
  private bytes = 0;
  private samples = 0;
  private left = new Float32Array(FRAME);
  private right = new Float32Array(FRAME);
  sampleRate = 0;
  constructor(stream: ReadableStream<Uint8Array>, private decoder: PcmDecoder) { this.reader = stream.getReader(); }
  async ready() { await this.decoder.ready; }
  async pull(): Promise<Block> {
    let count = 0;
    while (count < FRAME) {
      if (this.pcm.length && this.pcmAt < this.pcm[0].length) {
        const take = Math.min(FRAME - count, this.pcm[0].length - this.pcmAt);
        this.left.set(this.pcm[0].subarray(this.pcmAt, this.pcmAt + take), count);
        this.right.set((this.pcm[1] ?? this.pcm[0]).subarray(this.pcmAt, this.pcmAt + take), count);
        this.pcmAt += take; count += take;
        continue;
      }
      if (this.ended) break;
      if (this.rawAt >= this.raw.length) {
        const next = await this.reader.read();
        if (next.done) { this.ended = true; break; }
        this.bytes += next.value.byteLength;
        if (next.value.byteLength > 1024 * 1024 || this.bytes > MAX_BYTES) throw new Error('Stored source exceeds streaming bounds');
        this.raw = next.value; this.rawAt = 0;
      }
      const part = this.decoder.decode(this.raw.subarray(this.rawAt, this.rawAt + 4096));
      this.rawAt += 4096;
      if (part.errors.length || !Number.isSafeInteger(part.samplesDecoded) || part.samplesDecoded < 0 || part.samplesDecoded > 131072) throw new Error('Invalid decoded source');
      if (!part.samplesDecoded) continue;
      if (![32000, 44100, 48000].includes(part.sampleRate) || (this.sampleRate && this.sampleRate !== part.sampleRate) ||
        part.channelData.length < 1 || part.channelData.length > 2 || part.channelData.some(c => c.length !== part.samplesDecoded)) throw new Error('Invalid source PCM format');
      this.sampleRate = part.sampleRate;
      this.samples += part.samplesDecoded;
      if (this.samples / this.sampleRate > 900.1) throw new Error('Source is too long');
      for (const channel of part.channelData) for (const sample of channel) {
        if (!Number.isFinite(sample) || Math.abs(sample) > 8) throw new Error('Invalid source samples');
      }
      this.pcm = part.channelData; this.pcmAt = 0;
    }
    return { left: this.left, right: this.right, length: count };
  }
  async close() {
    try { await this.reader.cancel(); } catch { /* The stream may already be closed. */ }
    this.reader.releaseLock(); this.decoder.free();
  }
}

async function open(source: EncodedLayerSource, create: () => PcmDecoder): Promise<PcmReader> {
  const reader = new PcmReader(await source.open(), create());
  try { await reader.ready(); return reader; }
  catch (error) { await reader.close(); throw error; }
}

async function measure(source: EncodedLayerSource, create: () => PcmDecoder): Promise<LayerEnergy> {
  const reader = await open(source, create);
  let sum = 0, peak = 0, samples = 0;
  try {
    for (;;) {
      const part = await reader.pull(); if (!part.length) break;
      samples += part.length;
      for (let i = 0; i < part.length; i++) {
        const l = part.left[i], r = part.right[i];
        sum += l * l + r * r; peak = Math.max(peak, Math.abs(l), Math.abs(r));
      }
    }
    if (samples < reader.sampleRate || !reader.sampleRate) throw new Error('Source audio is too short');
    return { name: source.name, rmsDb: 10 * Math.log10(Math.max(1e-20, sum / (samples * 2))), peak, samples, sampleRate: reader.sampleRate };
  } finally { await reader.close(); }
}

async function visitGroup(sources: EncodedLayerSource[], create: () => PcmDecoder,
  visit: (part: Block) => void, checkpoint?: () => Promise<void>) {
  const readers: PcmReader[] = [];
  const left = new Float32Array(FRAME), right = new Float32Array(FRAME);
  try {
    for (const source of sources) readers.push(await open(source, create));
    let frames = 0;
    for (;;) {
      const parts = await Promise.all(readers.map(reader => reader.pull()));
      const length = Math.max(...parts.map(p => p.length)); if (!length) break;
      const rates = readers.map(r => r.sampleRate).filter(Boolean);
      if (new Set(rates).size !== 1) throw new Error('Unaligned source rates');
      left.fill(0); right.fill(0);
      for (const part of parts) for (let i = 0; i < part.length; i++) { left[i] += part.left[i]; right[i] += part.right[i]; }
      visit({ left, right, length });
      if (++frames % 2048 === 0) await checkpoint?.();
    }
  } finally { await Promise.all(readers.map(reader => reader.close())); }
}

/** Re-encode every displayed output with the same encoder so the composite
 * remainder and individual layers share encoder delay. Mixing is a sum, never
 * an average: quiet bass/keys are retained in the remainder at their real gain. */
export async function composeProminentLayers(input: {
  sources: readonly EncodedLayerSource[];
  requested: 4 | 'auto';
  createDecoder(): PcmDecoder;
  createEncoder(sampleRate: number): Mp3Encoder;
  write(name: SourceLayer, bytes: Uint8Array): Promise<string>;
  checkpoint?(): Promise<void>;
}): Promise<{ plan: ProminentLayerPlan; energy: LayerEnergy[]; gain: number; stored: { name: SourceLayer; key: string }[] }> {
  const energy: LayerEnergy[] = [];
  for (const source of input.sources) { energy.push(await measure(source, input.createDecoder)); await input.checkpoint?.(); }
  const plan = prominentLayerPlan(energy, input.requested);
  if (plan.parts === 6) return { plan, energy, gain: 1, stored: [] };
  const group = (names: SourceLayer[]) => names.map(name => {
    const source = input.sources.find(s => s.name === name); if (!source) throw new Error('Missing source'); return source;
  });
  let peak = Math.max(...energy.filter(e => plan.selected.includes(e.name)).map(e => e.peak));
  await visitGroup(group(plan.remainder), input.createDecoder, part => {
    for (let i = 0; i < part.length; i++) peak = Math.max(peak, Math.abs(part.left[i]), Math.abs(part.right[i]));
  }, input.checkpoint);
  const gain = peak > .98 ? .98 / peak : 1;
  const stored: { name: SourceLayer; key: string }[] = [];
  const groups = [...plan.selected.map(name => ({ name, sources: group([name]) })), { name: 'other' as const, sources: group(plan.remainder) }];
  for (const output of groups) {
    const encoder = input.createEncoder(energy[0].sampleRate);
    const left = new Int16Array(FRAME), right = new Int16Array(FRAME);
    const chunks: Uint8Array[] = []; let bytes = 0;
    const append = (chunk: Uint8Array) => {
      if (!chunk.length) return;
      bytes += chunk.length; if (bytes > MAX_BYTES) throw new Error('Encoded layer is too large');
      chunks.push(new Uint8Array(chunk));
    };
    await visitGroup(output.sources, input.createDecoder, part => {
      for (let i = 0; i < part.length; i++) {
        left[i] = Math.round(Math.max(-1, Math.min(1, part.left[i] * gain)) * 32767);
        right[i] = Math.round(Math.max(-1, Math.min(1, part.right[i] * gain)) * 32767);
      }
      append(encoder.encodeBuffer(left.subarray(0, part.length), right.subarray(0, part.length)));
    }, input.checkpoint);
    append(encoder.flush());
    const encoded = new Uint8Array(bytes); let at = 0;
    for (const chunk of chunks) { encoded.set(chunk, at); at += chunk.length; }
    stored.push({ name: output.name, key: await input.write(output.name, encoded) });
    await input.checkpoint?.();
  }
  return { plan, energy, gain, stored };
}
