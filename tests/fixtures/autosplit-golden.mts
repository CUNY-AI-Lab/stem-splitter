/**
 * Deterministic PCM fixtures shared by browser/server parity tests.
 *
 * They are generated from fixed seeds rather than checked-in recordings, so
 * they carry no music rights and their raw float digest catches accidental
 * changes to the synthesis or sample ordering.
 */

export const GOLDEN_SAMPLE_RATE = 22_050;
const SECONDS = 6;

function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function empty(): Float32Array {
  return new Float32Array(GOLDEN_SAMPLE_RATE * SECONDS);
}

function add(dest: Float32Array, source: Float32Array, atSeconds: number, gain = 1): void {
  const offset = Math.floor(atSeconds * GOLDEN_SAMPLE_RATE);
  for (let index = 0; index < source.length && offset + index < dest.length; index++) {
    dest[offset + index] += source[index] * gain;
  }
}

function harmonic(freq: number, seconds: number, attack = 0.2): Float32Array {
  const out = new Float32Array(Math.floor(seconds * GOLDEN_SAMPLE_RATE));
  for (let index = 0; index < out.length; index++) {
    const time = index / GOLDEN_SAMPLE_RATE;
    const envelope = Math.min(1, time / attack) * Math.min(1, (seconds - time) / 0.25);
    let value = 0;
    for (let partial = 1; partial <= 6; partial++) {
      value += Math.sin(2 * Math.PI * freq * partial * time) / (partial * 1.5);
    }
    out[index] = value * envelope * 0.22;
  }
  return out;
}

function lowSequence(frequencies: readonly number[], noteSeconds: number): Float32Array {
  const out = new Float32Array(
    Math.floor(frequencies.length * noteSeconds * GOLDEN_SAMPLE_RATE)
  );
  for (let note = 0; note < frequencies.length; note++) {
    const offset = Math.floor(note * noteSeconds * GOLDEN_SAMPLE_RATE);
    const length = Math.floor(noteSeconds * GOLDEN_SAMPLE_RATE);
    for (let index = 0; index < length; index++) {
      const time = index / GOLDEN_SAMPLE_RATE;
      const envelope = Math.min(1, time / 0.02) * Math.min(1, (noteSeconds - time) / 0.05);
      out[offset + index] =
        (Math.sin(2 * Math.PI * frequencies[note] * time) +
          0.35 * Math.sin(4 * Math.PI * frequencies[note] * time)) *
        envelope *
        0.45;
    }
  }
  return out;
}

function noiseHit(random: () => number, seconds = 0.08): Float32Array {
  const out = new Float32Array(Math.floor(seconds * GOLDEN_SAMPLE_RATE));
  for (let index = 0; index < out.length; index++) {
    const time = index / GOLDEN_SAMPLE_RATE;
    out[index] = (random() * 2 - 1) * Math.exp(-time * 45) * 0.55;
  }
  return out;
}

function hammered(freq: number, seconds = 0.9): Float32Array {
  const out = new Float32Array(Math.floor(seconds * GOLDEN_SAMPLE_RATE));
  for (let index = 0; index < out.length; index++) {
    const time = index / GOLDEN_SAMPLE_RATE;
    let value = 0;
    for (let partial = 1; partial <= 8; partial++) {
      value += Math.sin(2 * Math.PI * freq * partial * time) / partial;
    }
    out[index] = value * Math.exp(-time * 4) * 0.32;
  }
  return out;
}

function sustainedFixture(): Float32Array {
  const track = empty();
  add(track, harmonic(110, SECONDS, 0.5), 0, 0.6);
  add(track, harmonic(220, SECONDS, 0.4), 0, 0.8);
  return track;
}

function rhythmFixture(): Float32Array {
  const track = empty();
  const random = randomSource(0x4004);
  for (let time = 0; time < SECONDS; time += 0.25) {
    add(track, noiseHit(random), time, 0.8);
  }
  return track;
}

function pitchedAttackFixture(): Float32Array {
  const track = empty();
  const pattern = [220, 262, 330, 392, 330, 262];
  for (let time = 0, note = 0; time < SECONDS; time += 0.3, note++) {
    add(track, hammered(pattern[note % pattern.length]), time, 0.85);
  }
  add(track, lowSequence([73, 82, 73, 65], 1.5), 0, 0.55);
  return track;
}

export interface GoldenAutoSplitFixture {
  id: string;
  samples: Float32Array;
  sha256: string;
  expectedChoice: 'two' | 'four' | 'six';
}

export function goldenAutoSplitFixtures(): GoldenAutoSplitFixture[] {
  return [
    {
      id: 'sustained-voice-drone',
      samples: sustainedFixture(),
      sha256: '901557f35c0ac618f7a1ac12dbe86a6c7f0b4b16b495d028061eafd69ec9f0e4',
      expectedChoice: 'two',
    },
    {
      id: 'percussion-ensemble',
      samples: rhythmFixture(),
      sha256: '98637f476aa2243167f9a4535af8468a779de856beac9ed409f0b3b17978901f',
      expectedChoice: 'four',
    },
    {
      id: 'hammered-pitched-layers',
      samples: pitchedAttackFixture(),
      sha256: 'b20df9e442e3aba994e5580a04c117689f967ce9931d6e25531bc48fd442b74f',
      expectedChoice: 'six',
    },
  ];
}
