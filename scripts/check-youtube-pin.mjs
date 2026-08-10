#!/usr/bin/env node

import { findYouTubePinViolations } from './lib/pin-check.mjs';

const MAX_SCHEMA_BYTES = 1024 * 1024;
const LOOKUP_TIMEOUT_MS = 15_000;

function requiredValue(name, pattern, { minimum = 1, maximum = 256 } = {}) {
  const value = process.env[name] ?? '';
  if (
    value.length < minimum ||
    value.length > maximum ||
    value !== value.trim() ||
    /\s|[\u0000-\u001f\u007f]/.test(value) ||
    !pattern.test(value)
  ) {
    console.error(`✗ ${name} is missing or invalid.`);
    process.exit(2);
  }
  return value;
}

async function readBoundedJson(response) {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('json')) throw new Error('lookup did not return JSON');
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SCHEMA_BYTES) {
      throw new Error('lookup response is too large');
    }
  }
  if (!response.body) throw new Error('lookup response is empty');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SCHEMA_BYTES) {
        await reader.cancel('lookup response is too large');
        throw new Error('lookup response is too large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
  } catch {
    throw new Error('lookup returned invalid JSON');
  }
}

const model = requiredValue('REPLICATE_YT_MODEL', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const version = requiredValue('REPLICATE_YT_MODEL_VERSION', /^[0-9a-f]{64}$/, { maximum: 64 });
const token = requiredValue('REPLICATE_API_TOKEN', /^[^\s\u0000-\u001f\u007f]+$/, {
  minimum: 20,
  maximum: 512,
});

let response;
try {
  response = await fetch(`https://api.replicate.com/v1/models/${model}/versions/${version}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
} catch {
  console.error('✗ pinned YouTube version lookup failed before receiving a response.');
  process.exit(1);
}
if (!response.ok) {
  await response.body?.cancel().catch(() => undefined);
  console.error(`✗ pinned YouTube version lookup failed (${response.status}).`);
  process.exit(1);
}

let pinned;
try {
  pinned = await readBoundedJson(response);
} catch (error) {
  console.error(`✗ pinned YouTube version lookup failed: ${error.message}.`);
  process.exit(1);
}
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
