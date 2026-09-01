import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  EFFICIENTAT_NATIVE_AMD64_ACCEPTANCE_PATH,
  loadEfficientatNativeAmd64Acceptance,
  validateEfficientatNativeAmd64Acceptance,
} from '../scripts/lib/efficientat-native-amd64-acceptance.mts';

function fixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(EFFICIENTAT_NATIVE_AMD64_ACCEPTANCE_PATH, 'utf8'));
}

test('canonical native-amd64 EfficientAT comparison evidence validates', () => {
  const evidence = loadEfficientatNativeAmd64Acceptance();
  assert.equal(evidence.status, 'passed-comparison-only');
});

test('EfficientAT native evidence cannot become promotion approval', () => {
  const value = fixture();
  (value.candidate as Record<string, unknown>).promotionEligible = true;
  assert.throws(() => validateEfficientatNativeAmd64Acceptance(value), /must remain false/);
});

test('EfficientAT native evidence remains bound to exact artifact bytes', () => {
  const value = fixture();
  const artifact = value.artifact as Record<string, unknown>;
  const files = artifact.files as Array<Record<string, unknown>>;
  files[0].sha256 = '0'.repeat(64);
  assert.throws(() => validateEfficientatNativeAmd64Acceptance(value), /file surface/);
});

test('emulated evidence cannot satisfy the native-amd64 gate', () => {
  const value = fixture();
  (value.execution as Record<string, unknown>).emulated = true;
  assert.throws(() => validateEfficientatNativeAmd64Acceptance(value), /native linux\/amd64/);
});

test('instrument review cannot be inferred from the accepted core listening review', () => {
  const value = fixture();
  (value.humanReview as Record<string, unknown>).instrumentReviewAccepted = true;
  assert.throws(() => validateEfficientatNativeAmd64Acceptance(value), /human-review boundaries/);
});
