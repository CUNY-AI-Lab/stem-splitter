import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { verifyHistoricalWorkflow } from '../scripts/lib/historical-workflow.mts';

const sourceCommit = 'a64d5dfb98e9f6b1031ac95f631498b7b139d0d6';
const workflow = '.github/workflows/yamnet-comparator-image.yml';
const workflowSha256 = '14a928dfb73a08c3401dbf6f38833a7b634d15d2675e1f2290453ba9bbc4275a';

test('a later workflow edit does not invalidate the workflow a historical receipt ran', () => {
  const root = mkdtempSync(join(tmpdir(), 'historical-workflow-'));
  try {
    execFileSync('git', ['clone', '--shared', '--no-checkout', process.cwd(), root], {
      stdio: 'pipe',
    });
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(join(root, workflow), 'name: a later runtime update\n');
    verifyHistoricalWorkflow(root, sourceCommit, workflow, workflowSha256);
    assert.throws(
      () => verifyHistoricalWorkflow(root, sourceCommit, workflow, '0'.repeat(64)),
      /drifted from historical/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing historical source cannot be replaced by a matching working file', () => {
  const root = mkdtempSync(join(tmpdir(), 'missing-historical-workflow-'));
  try {
    execFileSync('git', ['init', '--quiet', root]);
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    const bytes = 'name: unverified working file\n';
    writeFileSync(join(root, workflow), bytes);
    assert.throws(
      () => verifyHistoricalWorkflow(root, '0'.repeat(40), workflow, createHash('sha256').update(bytes).digest('hex')),
      /source is unavailable/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('historical workflow verification rejects revision and path expressions', () => {
  assert.throws(() => verifyHistoricalWorkflow(process.cwd(), 'HEAD', workflow, workflowSha256), /identity is invalid/);
  assert.throws(() => verifyHistoricalWorkflow(process.cwd(), sourceCommit, '../workflow.yml', workflowSha256), /identity is invalid/);
});
