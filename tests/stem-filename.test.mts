import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { stemFilename } from '../src/stem-filename.ts';
import { buildSystemPrompt } from '../src/assistant/prompt.ts';

test('download, export and Guide filenames agree for labels, Unicode and path characters', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const browserName = runInNewContext(app.slice(app.indexOf('function stemFilename('), app.indexOf('function stemDownloadUrl(')) + '\nstemFilename', { TextEncoder, TextDecoder });
  const cases = [
    ['Tab Steps Out.mp3', 'vocals', 'Tab Steps Out — vocals.mp3'],
    ['Tab Steps Out.mp3', 'Trumpet', 'Tab Steps Out — Trumpet.mp3'],
    ['Björk — Jóga', 'Synth / bass', 'Björk — Jóga — Synth bass.mp3'],
    ['../A "song".wav', '../Lead\nwind', 'A song — Lead wind.mp3'],
    ['', '', 'Recording — Split.mp3'],
  ];
  for (const [title, label, expected] of cases) {
    assert.equal(stemFilename(title, label), expected);
    assert.equal(browserName(title, label), expected);
  }
  const longName = stemFilename('歌'.repeat(200), '🎷'.repeat(100));
  assert.ok(Buffer.byteLength(longName) < 255);
  assert.equal(browserName('歌'.repeat(200), '🎷'.repeat(100)), longName);
});

test('Guide identifies the filename and current label while keeping audio claims separate', () => {
  const ctx = { title: 'Tab Steps Out.mp3', model: 'htdemucs_ft', stems: [{ name: 'vocals', label: 'Trumpet' }], annotations: [], mode: 'chat' as const };
  const prompt = buildSystemPrompt(ctx);
  assert.match(prompt, /Tab Steps Out — Trumpet\.mp3 \(channel: vocals; label source: user edit\)/);
  assert.match(prompt, /instrument classification verified from audio/);
  assert.doesNotMatch(prompt, /it will be near-silent/);
  const changed = buildSystemPrompt({ ...ctx, stems: [{ name: 'vocals', label: 'Lead wind' }] });
  assert.match(changed, /Tab Steps Out — Lead wind\.mp3/);
  assert.doesNotMatch(changed, /Tab Steps Out — Trumpet\.mp3/);
});
