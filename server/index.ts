// Node host for the shared Hono app. Railway is the active integration and
// release target until the finished product migrates to Cloudflare Workers.
// This file supplies Node-backed DB/AUDIO bindings and serves public/ without
// changing the shared application under src/.
//
// It runs in LOCAL_HOSTING mode, so uploads stream through /api/local-uploads/
// and sources are exposed via short-lived HMAC-signed /api/local-sources/ URLs —
// no R2 credentials and no presigning. Unlike localhost dev, Railway's public
// domain means Replicate can actually reach both the source URL and the webhook.

import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import app from '../src/index';
import type { Env } from '../src/env';
import { runtimeConfigurationSummary, runtimeConfigurationWarnings } from './config';
import { SqliteD1 } from './d1';
import { FsR2Bucket } from './r2';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? join(repoRoot, '.railway-data');

/** Railway injects RAILWAY_PUBLIC_DOMAIN; Replicate needs an absolute https origin. */
function publicBaseUrl(): string {
  const explicit = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '');
  if (explicit) return explicit;
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (domain) return `https://${domain}`;
  return `http://127.0.0.1:${PORT}`;
}

/**
 * Fail fast on the secrets every request path needs. R2_* are deliberately
 * absent: LOCAL_HOSTING never presigns.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[startup] missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

/**
 * Separation and coach credentials are checked lazily, not at boot: without them
 * the upload, mixer, labels, and stem-playback paths still work, and a separation
 * attempt fails with the backend's own error instead of the whole service
 * crash-looping. Warn once so the gap is visible in the deploy logs.
 */
function optionalEnv(name: string): string {
  const value = process.env[name];
  if (!value) console.warn(`[startup] ${name} is unset — routes needing it will fail until it is set`);
  return value ?? '';
}

mkdirSync(DATA_DIR, { recursive: true });

const db = new SqliteD1(join(DATA_DIR, 'stem-splitter.sqlite'));
db.applySchema(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
db.applyNodeMigrations();

const audio = new FsR2Bucket(join(DATA_DIR, 'audio'));

const env = {
  DB: db,
  AUDIO: audio,

  R2_BUCKET_NAME: 'local',
  CF_ACCOUNT_ID: 'local',
  PUBLIC_BASE_URL: publicBaseUrl(),
  LOCAL_HOSTING: 'true',

  SEPARATION_BACKEND: process.env.SEPARATION_BACKEND ?? 'replicate',
  REPLICATE_YT_MODEL: process.env.REPLICATE_YT_MODEL,
  REPLICATE_YT_MODEL_VERSION: process.env.REPLICATE_YT_MODEL_VERSION,
  YOUTUBE_FETCH_ORDER: process.env.YOUTUBE_FETCH_ORDER ?? 'replicate-first',
  ASSISTANT_MODEL: process.env.ASSISTANT_MODEL,
  // Absent means no instructor accounts, which is a valid configuration: the
  // seed is upserted on boot, so leaving it unset just leaves the console shut.
  TEACHER_SEED: process.env.TEACHER_SEED,
  AUDIO_SEPARATOR_URL: process.env.AUDIO_SEPARATOR_URL,
  AUDIO_SEPARATOR_TOKEN: process.env.AUDIO_SEPARATOR_TOKEN,
  SERVER_AUTO_ENABLED: process.env.SERVER_AUTO_ENABLED,
  SERVER_AUTO_MODE: process.env.SERVER_AUTO_MODE,
  INSTRUMENT_DISCOVERY_ENABLED: process.env.INSTRUMENT_DISCOVERY_ENABLED,
  QUERY_ISOLATION_ENABLED: process.env.QUERY_ISOLATION_ENABLED,
  AUDIO_ANALYSIS_URL: process.env.AUDIO_ANALYSIS_URL,
  AUDIO_ANALYSIS_TOKEN: process.env.AUDIO_ANALYSIS_TOKEN,
  AUDIO_ANALYSIS_TIMEOUT_MS: process.env.AUDIO_ANALYSIS_TIMEOUT_MS,

  // Unused under LOCAL_HOSTING, but the Env type requires them.
  R2_ACCESS_KEY_ID: '',
  R2_SECRET_ACCESS_KEY: '',

  WEBHOOK_SECRET: requireEnv('WEBHOOK_SECRET'),
  CLASS_CODE: requireEnv('CLASS_CODE'),

  REPLICATE_API_TOKEN: optionalEnv('REPLICATE_API_TOKEN'),
  REPLICATE_MODEL_VERSION: optionalEnv('REPLICATE_MODEL_VERSION'),
  OPENROUTER_API_KEY: optionalEnv('OPENROUTER_API_KEY'),
} as unknown as Env;

for (const warning of runtimeConfigurationWarnings(env)) {
  console.warn(`[startup] ${warning}`);
}

const host = new Hono();

// Every app route lives under /api/*; everything else is a static asset.
host.all('/api/*', (c) => app.fetch(c.req.raw, env));
host.get('/healthz', async (c) => {
  const settings = await db
    .prepare('SELECT revision FROM assistant_settings WHERE id = 1')
    .first<{ revision: number }>();
  // Preparing this query proves the append-only table and its monotonic join
  // column both exist, even before the first instructor revision is written.
  await db
    .prepare('SELECT settings_revision FROM assistant_prompt_revisions LIMIT 1')
    .all();
  return c.json({
    ok: true,
    base: env.PUBLIC_BASE_URL,
    promptSchema: Number.isInteger(settings?.revision) ? 'ready' : 'missing',
    configuration: runtimeConfigurationSummary(env),
  });
});
host.use('/*', serveStatic({ root: './public' }));

serve({ fetch: host.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`[startup] stem-splitter listening on :${info.port}`);
  console.log(`[startup] public base url: ${env.PUBLIC_BASE_URL}`);
  console.log(`[startup] data dir: ${DATA_DIR}`);
  console.log(`[startup] separation backend: ${env.SEPARATION_BACKEND}`);
});
