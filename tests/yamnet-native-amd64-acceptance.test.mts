import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  loadYamnetNativeAmd64Acceptance,
  validateYamnetNativeAmd64Acceptance,
  YAMNET_NATIVE_AMD64_ACCEPTANCE_PATH,
} from '../scripts/lib/yamnet-native-amd64-acceptance.mts';

function fixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(YAMNET_NATIVE_AMD64_ACCEPTANCE_PATH, 'utf8'));
}

test('canonical native-amd64 YAMNet pending comparison evidence validates without granting acceptance', () => {
  const evidence = loadYamnetNativeAmd64Acceptance(process.cwd(), true);
  assert.equal(evidence.status, 'pending-source-gate');
});

test('native-amd64 evidence cannot be changed into promotion approval', () => {
  const value = fixture();
  (value.candidate as Record<string, unknown>).promotionEligible = true;
  assert.throws(() => validateYamnetNativeAmd64Acceptance(value, true), /must remain false/);
});

test('artifact identity must remain bound to the exact source commit', () => {
  const value = fixture();
  (value.source as Record<string, unknown>).commit = 'a'.repeat(40);
  assert.throws(() => validateYamnetNativeAmd64Acceptance(value, true), /artifact identity/);
});

test('native evidence cannot claim that audio was uploaded', () => {
  const value = fixture();
  (value.artifact as Record<string, unknown>).containsAudio = true;
  assert.throws(() => validateYamnetNativeAmd64Acceptance(value, true), /must not contain audio/);
});

test('the separate instrument review cannot be accepted with zero completed sources', () => {
  const value = fixture();
  (value.humanReview as Record<string, unknown>).instrumentReviewAccepted = true;
  assert.throws(() => validateYamnetNativeAmd64Acceptance(value, true), /human-review boundaries/);
});

test('pending Yamnet evidence cannot satisfy accepted comparison evidence', () => {
  assert.throws(() => loadYamnetNativeAmd64Acceptance(), /status drifted|identity drifted/);
  const value = fixture();
  value.status = 'passed-comparison-only';
  assert.throws(() => validateYamnetNativeAmd64Acceptance(value, true), /source run identity/);
});
