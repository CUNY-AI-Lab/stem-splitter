// Read-only contract guard for the evaluation-only community SAM-Audio image.
// It fetches one exact Replicate version and never starts a prediction.
//
//   node --experimental-strip-types scripts/check-sam-audio-eval-pin.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { findSamAudioEvaluationPinViolations } from './lib/pin-check.mjs';
import {
  SAM_AUDIO_REPLICATE_MODEL,
  SAM_AUDIO_REPLICATE_VERSION,
  samAudioEvaluationContractSurface,
} from './lib/query-isolation-bakeoff.mts';

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

const token = process.env.REPLICATE_API_TOKEN ?? fromDevVars('REPLICATE_API_TOKEN');
if (!token) {
  console.error('✗ REPLICATE_API_TOKEN is not set (env or .dev.vars).');
  process.exit(2);
}

const surface = samAudioEvaluationContractSurface();
if (
  surface.purpose !== 'evaluation-only' ||
  surface.reviewedVersion !== SAM_AUDIO_REPLICATE_VERSION ||
  surface.model !== SAM_AUDIO_REPLICATE_MODEL
) {
  console.error('✗ SAM-Audio evaluation identity drifted before remote lookup.');
  process.exit(1);
}

const response = await fetch(
  `${API}/models/${SAM_AUDIO_REPLICATE_MODEL}/versions/${SAM_AUDIO_REPLICATE_VERSION}`,
  {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  }
);
if (!response.ok) {
  console.error(`✗ pinned SAM-Audio evaluation lookup failed (${response.status}).`);
  process.exit(1);
}
const version = await response.json();
if (version.id !== SAM_AUDIO_REPLICATE_VERSION) {
  console.error('✗ Replicate returned a different SAM-Audio version id.');
  process.exit(1);
}

const failures = findSamAudioEvaluationPinViolations(surface, version.openapi_schema);
console.log(`  purpose:      ${surface.purpose}`);
console.log(`  model:        ${surface.model}`);
console.log(`  reviewed pin: ${surface.reviewedVersion.slice(0, 12)}…`);
console.log(`  inputs:       ${surface.inputKeys.join(', ')}`);
console.log(`  outputs:      ${surface.outputRoles.join(', ')}`);

if (failures.length) {
  console.error('\n✗ The pinned community schema no longer satisfies the evaluation harness:');
  for (const failure of failures) console.error(`    - ${failure}`);
  process.exit(1);
}

console.log('\n✓ The pinned community schema still matches the evaluation-only harness.');
console.log('  This does not approve the SAM License, gated checkpoint, wrapper provenance,');
console.log('  application integration, provider spend, or Railway deployment.');
