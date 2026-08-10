#!/usr/bin/env node

import { findYouTubePinViolations } from './lib/pin-check.mjs';

const model = process.env.REPLICATE_YT_MODEL?.trim() ?? '';
const version = process.env.REPLICATE_YT_MODEL_VERSION?.trim() ?? '';
const token = process.env.REPLICATE_API_TOKEN?.trim() ?? '';

for (const [key, value] of [
  ['REPLICATE_YT_MODEL', model],
  ['REPLICATE_YT_MODEL_VERSION', version],
  ['REPLICATE_API_TOKEN', token],
]) {
  if (!value) {
    console.error(`✗ ${key} is not set.`);
    process.exit(2);
  }
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(model)) {
  console.error('✗ REPLICATE_YT_MODEL must be owner/model.');
  process.exit(2);
}
if (version.toLowerCase() === 'latest') {
  console.error('✗ REPLICATE_YT_MODEL_VERSION must be an exact version id, never "latest".');
  process.exit(2);
}

const response = await fetch(`https://api.replicate.com/v1/models/${model}/versions/${version}`, {
  headers: { Authorization: `Bearer ${token}` },
});
if (!response.ok) {
  console.error(`✗ pinned YouTube version lookup failed (${response.status}).`);
  process.exit(1);
}
const pinned = await response.json();
const failures = findYouTubePinViolations(pinned.openapi_schema);
console.log(`  model: ${model}`);
console.log(`  pin:   ${version.slice(0, 12)}…`);
if (failures.length) {
  console.error('\n✗ The pinned YouTube version no longer satisfies the importer contract:');
  for (const failure of failures) console.error(`    - ${failure}`);
  process.exit(1);
}
console.log('  input: url, max_duration');
console.log('  output: audio, duration, title');
console.log('\n✓ The pinned YouTube version satisfies the importer contract.');
