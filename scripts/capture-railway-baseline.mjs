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

try {
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
    railway: {
      projectId: process.env.RAILWAY_PROJECT_ID || null,
      environmentId: process.env.RAILWAY_ENVIRONMENT_ID || null,
      serviceId: process.env.RAILWAY_SERVICE_ID || null,
      deploymentId: process.env.BASELINE_DEPLOYMENT_ID || null,
      deployedCommit: process.env.BASELINE_DEPLOYED_COMMIT || null,
      imageDigest: process.env.BASELINE_IMAGE_DIGEST || null,
    },
    provider: {
      separation: {
        backend: process.env.SEPARATION_BACKEND || 'replicate',
        version: process.env.REPLICATE_MODEL_VERSION || null,
      },
      youtubeConfigPlane: {
        model: process.env.REPLICATE_YT_MODEL || null,
        stagedVersion: process.env.REPLICATE_YT_MODEL_VERSION || null,
      },
    },
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (process.env.BASELINE_OUT) {
    const out = resolve(process.env.BASELINE_OUT);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, json, { mode: 0o600 });
    console.error(`baseline evidence: ${out}`);
  }
  process.stdout.write(json);
} catch (error) {
  console.error(`baseline capture failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
