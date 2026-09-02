// The Remixer's devil's-advocate register narrows the assistant toolset to
// solo/set_mute twice over: the deck surface offers only those tools, and the
// sanitizer drops anything else a model calls anyway.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMixerTools, sanitizeToolCalls } from '../src/assistant/tools.ts';

const STEMS = ['vocals', 'drums', 'bass', 'other'];

test('the deck surface offers only solo and set_mute, in deck language', () => {
  const tools = buildMixerTools(STEMS, 'deck');
  assert.deepEqual(tools.map((t) => t.function.name), ['solo', 'set_mute']);
  for (const tool of tools) {
    assert.match(tool.function.description, /remix deck/);
  }

  // The mixer surface is unchanged: full console, mixer language.
  const mixer = buildMixerTools(STEMS);
  assert.deepEqual(mixer.map((t) => t.function.name), ['solo', 'set_mute', 'seek', 'add_note']);
  assert.doesNotMatch(mixer[0].function.description, /remix deck/);
});

test('sanitizeToolCalls drops calls outside the allowed set', () => {
  const raw = [
    { function: { name: 'solo', arguments: '{"stem":"vocals"}' } },
    { function: { name: 'seek', arguments: '{"seconds":30}' } },
    { function: { name: 'add_note', arguments: '{"seconds":10,"text":"hi"}' } },
    { function: { name: 'set_mute', arguments: '{"stem":"drums","muted":true}' } },
  ];

  const deckCalls = sanitizeToolCalls(raw, STEMS, 210, ['solo', 'set_mute']);
  assert.deepEqual(deckCalls, [
    { name: 'solo', args: { stem: 'vocals' } },
    { name: 'set_mute', args: { stem: 'drums', muted: true } },
  ]);

  // Without the filter the full set still validates as before.
  assert.equal(sanitizeToolCalls(raw, STEMS, 210).length, 4);
});
