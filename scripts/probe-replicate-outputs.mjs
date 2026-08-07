// Records the RAW output object a catalogue option produces on Replicate.
//
// The Replicate schema declares inputs but not output track names, so the only
// way to know what a split actually returns is to run one. This exists because
// the 2-track option depends on Demucs naming its summed remainder `no_vocals`
// (separate.py:214 writes "no_" + args.stem) — a claim that must be observed,
// not assumed, before the rename in options.ts is trusted.
//
// Takes a caller-supplied audio URL: no default song, per
// docs/superpowers/specs/2026-07-30-reliable-model-output-design.md.
//
//   npm run probe:replicate -- vocals_instrumental https://example.test/clip.mp3
//
// Costs one prediction (~$0.05) and takes ~1-2 minutes including cold start.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getReplicateRunner, getSeparationOption } from '../src/separation/options.ts';

const API = 'https://api.replicate.com/v1';
const [optionId, audioUrl] = process.argv.slice(2);

if (!optionId || !audioUrl) {
  console.error('Usage: npm run probe:replicate -- <option-id> <audio-url>');
  console.error('  <audio-url> must be audio you are allowed to test.');
  process.exit(2);
}
if (!/^https?:\/\//.test(audioUrl)) {
  console.error('✗ <audio-url> must be an http(s) URL the provider can fetch.');
  process.exit(2);
}

function fromDevVars(key) {
  try {
    const path = fileURLToPath(new URL('../.dev.vars', import.meta.url));
    const line = readFileSync(path, 'utf8')
      .split('\n')
      .find((row) => row.startsWith(`${key}=`));
    return line?.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') ?? '';
  } catch {
    return '';
  }
}

function requireEnv(key) {
  const value = (process.env[key] ?? fromDevVars(key)).trim();
  if (!value) {
    console.error(`✗ ${key} is not set (env or .dev.vars).`);
    process.exit(2);
  }
  return value;
}

const option = getSeparationOption(optionId);
const runner = getReplicateRunner(optionId);
if (!option || !runner) {
  console.error(`✗ "${optionId}" is not a catalogue option with a Replicate runner.`);
  process.exit(2);
}

const token = requireEnv('REPLICATE_API_TOKEN');
const version = requireEnv(runner.versionVar);
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const input = { audio: audioUrl, ...runner.input() };

console.log(`option:   ${optionId}`);
console.log(`contract: ${option.stems.join(', ')}`);
console.log(`renames:  ${JSON.stringify(runner.outputNames ?? {})}`);
console.log(`input:    ${JSON.stringify(input)}\n`);

const startRes = await fetch(`${API}/predictions`, {
  method: 'POST',
  headers,
  // No webhook: this is a one-off probe, polled to completion.
  body: JSON.stringify({ version, input }),
});
if (!startRes.ok) {
  console.error(`✗ start failed (${startRes.status}): ${(await startRes.text()).slice(0, 500)}`);
  process.exit(1);
}

let prediction = await startRes.json();
console.log(`prediction ${prediction.id} …`);

const deadline = Date.now() + 10 * 60 * 1000;
while (!['succeeded', 'failed', 'canceled'].includes(prediction.status)) {
  if (Date.now() > deadline) {
    console.error('✗ timed out after 10 minutes');
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const poll = await fetch(`${API}/predictions/${prediction.id}`, { headers });
  prediction = await poll.json();
}

if (prediction.status !== 'succeeded') {
  console.error(`✗ prediction ${prediction.status}: ${JSON.stringify(prediction.error)}`);
  process.exit(1);
}

// Print the RAW object, not just the non-null keys: a fixed-shape output full
// of nulls is a real possibility, and replicate.ts filters those out silently.
console.log(`\nraw output:\n${JSON.stringify(prediction.output, null, 2)}`);

const allKeys = Object.keys(prediction.output ?? {});
const liveKeys = allKeys.filter(
  (key) => typeof prediction.output[key] === 'string' && prediction.output[key].length > 0
);
console.log(`\nall keys:      ${allKeys.join(', ') || '(none)'}`);
console.log(`non-empty:     ${liveKeys.join(', ') || '(none)'}`);

const renamed = liveKeys.map((key) => runner.outputNames?.[key] ?? key).sort();
const expected = [...option.stems].sort();
const matches = JSON.stringify(renamed) === JSON.stringify(expected);
console.log(`after rename:  ${renamed.join(', ')}`);
console.log(`contract:      ${expected.join(', ')}`);

console.log(
  matches
    ? '\n✓ The rename map matches the contract. Safe to ship this option.'
    : '\n✗ MISMATCH. Do not ship. Update outputNames in src/separation/options.ts to match the observed keys, or stop and re-plan if the shape is unexpected.'
);
process.exit(matches ? 0 : 1);
