import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildMixerTools } from '../src/assistant/tools.ts';
import { buildSystemPromptFingerprintMaterial, SYSTEM_PROMPT_VERSION } from '../src/assistant/prompt.ts';

test('Listening Guy keeps its original Splitter tools and prompt modes', () => {
  assert.deepEqual(buildMixerTools(['vocals', 'drums']).map(t => t.function.name), ['solo', 'set_mute', 'seek', 'add_note']);
  const bundle = JSON.parse(buildSystemPromptFingerprintMaterial());
  assert.equal(SYSTEM_PROMPT_VERSION, '2026-09-07.1');
  assert.equal(bundle.variants.length, 3);
  assert.doesNotMatch(JSON.stringify(bundle), /devil|weakest choice|ACTING ON THE DECK|defend the choice/i);
});

test('Remixer has no adversarial chat surface or scripted challenge shortcut', () => {
  for (const file of ['../public/index.html', '../public/app.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /devil|defend your mix|challenge.me|da-panel|daSend|da-challenge/i);
  }
});

test('the single Crate precedes the shelf and remix deck in the HTML itself', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/id="crate"/g) || []).length, 1);
  assert.ok(html.indexOf('id="crate"') < html.indexOf('id="shelf"'));
  assert.ok(html.indexOf('id="crate"') < html.indexOf('id="remix-deck"'));
});
