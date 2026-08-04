// Guards REPLICATE_MODEL_VERSION against upstream drift.
//
// ryan5453/demucs has already changed shape at source: its GitHub HEAD serves
// only `htdemucs` (no htdemucs_ft, no htdemucs_6s) and renamed output_format
// to `format`. That build is not published yet, so a blind bump to
// latest_version would silently break the 4- and 6-track splits.
//
// This reads the catalogue (src/separation/options.ts) rather than a second
// hand-maintained list, so it cannot fall out of sync with what we actually
// send. Never runs in a request path.
//
//   npm run check:replicate                     # check the configured pin
//   REPLICATE_MODEL_VERSION=<hash> npm run check:replicate   # vet a candidate

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { replicateContractSurface } from '../src/separation/options.ts';
import { findPinViolations, resolveInputProperties } from './lib/pin-check.mjs';

const API = 'https://api.replicate.com/v1';
const MODEL = 'ryan5453/demucs';

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
    console.error(`  Read it with: npx wrangler secret list`);
    process.exit(2);
  }
  return value;
}

const token = requireEnv('REPLICATE_API_TOKEN');
const pin = requireEnv('REPLICATE_MODEL_VERSION');
const headers = { Authorization: `Bearer ${token}` };

async function getJson(url, what) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error(`✗ ${what} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  return res.json();
}

const version = await getJson(`${API}/models/${MODEL}/versions/${pin}`, 'pinned version lookup');
const properties = resolveInputProperties(version.openapi_schema);
const surface = replicateContractSurface();
const failures = findPinViolations(surface, properties);

for (const key of surface.versionVars) {
  console.log(`  pin ${key} = ${pin.slice(0, 12)}…`);
}
console.log(`  models advertised: ${surface.modelIds.join(', ')}`);
console.log(`  inputs sent:       ${surface.inputKeys.join(', ')}`);

if (failures.length) {
  console.error(`\n✗ The pinned version no longer satisfies the catalogue:`);
  for (const failure of failures) console.error(`    - ${failure}`);
  console.error(`\n  Do not deploy. Either keep the current pin or update the catalogue.`);
  process.exit(1);
}

console.log('\n✓ The pinned version accepts every model id and input key the catalogue uses.');

// Advisory only: a newer version existing is not a failure, but bumping to it
// blind is exactly the mistake this script exists to prevent.
const model = await getJson(`${API}/models/${MODEL}`, 'model lookup');
const latest = model.latest_version?.id;
if (latest && latest !== pin) {
  console.log(`\n! A newer version exists: ${latest.slice(0, 12)}…`);
  console.log('  Do NOT bump blind. Vet it first:');
  console.log(`    REPLICATE_MODEL_VERSION=${latest} npm run check:replicate`);
}

// Output track names are not in the input schema; they are guarded at runtime
// by validateAndOrderStems and recorded by scripts/probe-replicate-outputs.mjs.
console.log('\n  Note: output track names are not declared in the schema.');
console.log('  They are enforced at ingestion by validateAndOrderStems().');
