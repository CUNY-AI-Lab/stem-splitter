#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { captureRailwayBaseline } from './lib/railway-baseline.mjs';

const sourcePath = process.env.SOURCE_AUDIO || process.argv[2];
const base =
  process.env.BASE ||
  process.env.PUBLIC_BASE_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
const classCode = process.env.CLASS_CODE;

function requiredEvidence(name, pattern) {
  const value = process.env[name] ?? '';
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value) || !pattern.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

try {
  const railway = {
    projectId: requiredEvidence('RAILWAY_PROJECT_ID', /^[0-9a-f-]{36}$/),
    environmentId: requiredEvidence('RAILWAY_ENVIRONMENT_ID', /^[0-9a-f-]{36}$/),
    serviceId: requiredEvidence('RAILWAY_SERVICE_ID', /^[0-9a-f-]{36}$/),
    deploymentId: requiredEvidence('BASELINE_DEPLOYMENT_ID', /^[0-9a-f-]{36}$/),
    deployedCommit: requiredEvidence('BASELINE_DEPLOYED_COMMIT', /^[0-9a-f]{40}$/),
    imageDigest: requiredEvidence('BASELINE_IMAGE_DIGEST', /^sha256:[0-9a-f]{64}$/),
    evidenceScope: 'explicit-railway-readback',
  };
  const separationBackend = requiredEvidence('SEPARATION_BACKEND', /^replicate$/);
  const separationVersion = requiredEvidence('REPLICATE_MODEL_VERSION', /^[0-9a-f]{64}$/);
  const youtubeModel = requiredEvidence(
    'REPLICATE_YT_MODEL',
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
  );
  const youtubeVersion = requiredEvidence('REPLICATE_YT_MODEL_VERSION', /^[0-9a-f]{64}$/);
  const captured = await captureRailwayBaseline({
    base,
    classCode,
    sourcePath,
    model: process.env.MODEL || 'htdemucs_ft',
    pollMs: Number(process.env.BASELINE_POLL_MS || 10_000),
    timeoutMs: Number(process.env.BASELINE_TIMEOUT_MS || 15 * 60 * 1000),
    onProgress(status) {
      console.error(`live baseline job: ${status}`);
    },
  });

  const result = {
    ...captured,
    railway,
    provider: {
      separation: {
        backend: separationBackend,
        version: separationVersion,
        evidenceScope: 'railway-config-plane',
      },
      youtubeConfigPlane: {
        model: youtubeModel,
        stagedVersion: youtubeVersion,
        evidenceScope: 'staged-not-running',
      },
    },
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (process.env.BASELINE_OUT) {
    const out = resolve(process.env.BASELINE_OUT);
    await mkdir(dirname(out), { recursive: true, mode: 0o700 });
    await writeFile(out, json, { mode: 0o600, flag: 'wx' });
    console.error(`baseline evidence: ${out}`);
  }
  process.stdout.write(json);
} catch (error) {
  console.error(`baseline capture failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
