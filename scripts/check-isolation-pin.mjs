// Guards the dormant AudioSep Replicate adapter against input/output drift.
// It never starts a prediction and is not part of an application request.
//
//   REPLICATE_AUDIOSEP_VERSION=<64-hex> npm run check:isolation

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  AUDIOSEP_REPLICATE_MODEL,
  queryIsolationReplicateContractSurface,
} from '../src/isolation/options.ts';
import { findQueryIsolationPinViolations } from './lib/pin-check.mjs';

const API = 'https://api.replicate.com/v1';

function fromDevVars(key) {
  try {
    const path = fileURLToPath(new URL('../.dev.vars', import.meta.url));
    const line = readFileSync(path, 'utf8')
      .split('\n')
      .find((row) => row.startsWith(`${key}=`));
    return line?.slice(key.length + 1).replace(/^["']|["']$/g, '') ?? '';
  } catch {
    return '';
  }
}

function requireEnv(key) {
  const value = process.env[key] ?? fromDevVars(key);
  if (!value) {
    console.error(`✗ ${key} is not set (env or .dev.vars).`);
    process.exit(2);
  }
  return value;
}

const token = requireEnv('REPLICATE_API_TOKEN');
const surface = queryIsolationReplicateContractSurface();
const pin = requireEnv(surface.versionVar);
if (!/^[0-9a-f]{64}$/.test(pin)) {
  console.error(`✗ ${surface.versionVar} must be an exact lowercase 64-character version id.`);
  process.exit(2);
}
if (pin !== surface.reviewedVersion) {
  console.error(`✗ ${surface.versionVar} has not passed repository contract review.`);
  console.error('  Review the candidate schema and update the source pin in the same commit.');
  process.exit(2);
}
const headers = { Authorization: `Bearer ${token}` };

async function getJson(url, what) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    console.error(`✗ ${what} failed (${response.status}).`);
    process.exit(1);
  }
  return response.json();
}

const version = await getJson(
  `${API}/models/${AUDIOSEP_REPLICATE_MODEL}/versions/${pin}`,
  'pinned AudioSep version lookup'
);
if (version.id !== pin) {
  console.error('✗ Replicate returned a different AudioSep version id.');
  process.exit(1);
}
const failures = findQueryIsolationPinViolations(surface, version.openapi_schema);

console.log(`  model:       ${surface.model}`);
console.log(`  reviewed pin:${pin.slice(0, 12)}…`);
console.log(`  inputs sent: ${surface.inputKeys.join(', ')}`);
console.log(`  output:      one ${surface.output}; residual=${surface.supportsResidual}`);

if (failures.length) {
  console.error('\n✗ The pinned AudioSep version no longer satisfies the isolation contract:');
  for (const failure of failures) console.error(`    - ${failure}`);
  console.error('\n  Do not enable or deploy query isolation.');
  process.exit(1);
}

console.log('\n✓ The pinned AudioSep version satisfies the dormant adapter contract.');

const model = await getJson(`${API}/models/${AUDIOSEP_REPLICATE_MODEL}`, 'AudioSep model lookup');
const latest = model.latest_version?.id;
if (latest && latest !== pin) {
  console.log(`\n! A newer community version exists: ${latest.slice(0, 12)}…`);
  console.log('  Review its schema on a branch, update the source-reviewed pin, then rerun this check.');
}
console.log('\n  This is a community Replicate deployment, not an Audio-AGI-operated service.');
