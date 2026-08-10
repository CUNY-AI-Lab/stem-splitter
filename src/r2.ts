import { AwsClient } from 'aws4fetch';
import type { Env } from './env';
import { audioAnalysisSourceScopeForKey } from './analysis/source-scope.ts';

// Presigned URLs let the browser upload straight to R2 (and let the
// separation backend download the source) without the audio bytes ever
// flowing through the Worker.

const SOURCE_URL_TTL_SECONDS = 6 * 60 * 60;
const ANALYSIS_URL_TTL_SECONDS = 10 * 60;
const ISOLATION_URL_TTL_SECONDS = 15 * 60;
const LOCAL_AUDIO_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const LOCAL_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

let nextLocalCleanupAt = 0;
let localCleanupInFlight: Promise<number> | null = null;

export function isLocalHosting(env: Env): boolean {
  return env.LOCAL_HOSTING === 'true' || env.LOCAL_DEV === '1';
}

function client(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });
}

function objectUrl(env: Env, key: string): string {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${encodedKey}`;
}

async function presign(env: Env, method: 'PUT' | 'GET', key: string, expiresSeconds: number): Promise<string> {
  const url = new URL(objectUrl(env, key));
  url.searchParams.set('X-Amz-Expires', String(expiresSeconds));
  const signed = await client(env).sign(new Request(url, { method }), {
    aws: { signQuery: true, service: 's3', region: 'auto' },
  });
  return signed.url;
}

function localObjectPath(route: string, key: string): string {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${route}${encodedKey}`;
}

function localObjectUrl(env: Env, route: string, key: string): URL {
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  return new URL(`${base}${localObjectPath(route, key)}`);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function signaturePayload(key: string, expiresAt: number): Uint8Array {
  return new TextEncoder().encode(`${key}\n${expiresAt}`);
}

async function signLocalSource(env: Env, key: string, expiresAt: number): Promise<string> {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(env.WEBHOOK_SECRET),
    signaturePayload(key, expiresAt)
  );
  return base64Url(new Uint8Array(signature));
}

export async function verifyLocalSource(
  env: Env,
  key: string,
  expiresValue: string | undefined,
  signatureValue: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  if (!expiresValue || !signatureValue || !/^\d+$/.test(expiresValue)) return false;
  const expiresAt = Number(expiresValue);
  if (
    !Number.isSafeInteger(nowSeconds) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < nowSeconds ||
    expiresAt > nowSeconds + SOURCE_URL_TTL_SECONDS + 60
  ) {
    return false;
  }
  const signature = decodeBase64Url(signatureValue);
  if (!signature) return false;
  return crypto.subtle.verify(
    'HMAC',
    await hmacKey(env.WEBHOOK_SECRET),
    signature,
    signaturePayload(key, expiresAt)
  );
}

const ISOLATION_SOURCE_KEY_PATTERN =
  /^isolation-inputs\/v1\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/[0-9a-f]{64}$/;
export function isAuthoritativeAutoSourceKey(key: string): boolean {
  return audioAnalysisSourceScopeForKey(key) === 'authoritative_auto_snapshot';
}

/**
 * Local source GETs expose ordinary uploads and app-owned Auto/isolation
 * snapshots. The upload PUT route deliberately accepts only `uploads/`, so a
 * browser PUT can never overwrite either snapshot even if its original URL is
 * live.
 */
export function isLocalSourceDownloadKey(key: string): boolean {
  return (
    key.startsWith('uploads/') ||
    isAuthoritativeAutoSourceKey(key) ||
    ISOLATION_SOURCE_KEY_PATTERN.test(key)
  );
}

function isExpiredLocalObject(object: R2Object, nowMs: number): boolean {
  return object.uploaded.getTime() <= nowMs - LOCAL_AUDIO_RETENTION_MS;
}

/**
 * Delete local Miniflare objects older than the production bucket's 30-day
 * lifecycle. Pass nowMs explicitly in tests to verify expiry without waiting.
 */
export async function cleanupExpiredLocalAudio(env: Env, nowMs = Date.now()): Promise<number> {
  if (!isLocalHosting(env)) return 0;

  const expiredKeys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.AUDIO.list({ cursor });
    for (const object of page.objects) {
      if (isExpiredLocalObject(object, nowMs)) expiredKeys.push(object.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  for (let start = 0; start < expiredKeys.length; start += 1000) {
    await env.AUDIO.delete(expiredKeys.slice(start, start + 1000));
  }
  return expiredKeys.length;
}

/** Run local retention maintenance at most hourly while the Worker is active. */
export async function maintainLocalAudioRetention(env: Env, nowMs = Date.now()): Promise<void> {
  if (!isLocalHosting(env) || nowMs < nextLocalCleanupAt) return;

  if (!localCleanupInFlight) {
    localCleanupInFlight = cleanupExpiredLocalAudio(env, nowMs);
  }
  try {
    await localCleanupInFlight;
    nextLocalCleanupAt = nowMs + LOCAL_CLEANUP_INTERVAL_MS;
  } finally {
    localCleanupInFlight = null;
  }
}

/** Fetch audio while enforcing the local 30-day retention boundary on access. */
export async function getRetainedAudio(env: Env, key: string, nowMs = Date.now()): Promise<R2ObjectBody | null> {
  const object = await env.AUDIO.get(key);
  if (!object || !isLocalHosting(env) || !isExpiredLocalObject(object, nowMs)) return object;

  await env.AUDIO.delete(key);
  return null;
}

/** Presigned PUT for browser uploads (15 min). */
export function presignUpload(env: Env, key: string): Promise<string> {
  if (isLocalHosting(env)) {
    return Promise.resolve(localObjectPath('/api/local-uploads/', key));
  }
  return presign(env, 'PUT', key, 15 * 60);
}

/** Presigned GET so the separation backend can fetch the source (6 h). */
export async function presignDownload(env: Env, key: string): Promise<string> {
  if (isLocalHosting(env)) {
    const expiresAt = Math.floor(Date.now() / 1000) + SOURCE_URL_TTL_SECONDS;
    const url = localObjectUrl(env, '/api/local-sources/', key);
    url.searchParams.set('expires', String(expiresAt));
    url.searchParams.set('signature', await signLocalSource(env, key, expiresAt));
    return url.toString();
  }
  return presign(env, 'GET', key, SOURCE_URL_TTL_SECONDS);
}

/** Short-lived GET for the private analyzer; separate from the separator URL. */
export async function presignAnalysisDownload(env: Env, key: string): Promise<string> {
  if (!audioAnalysisSourceScopeForKey(key)) {
    throw new Error('Invalid analysis source key');
  }
  if (isLocalHosting(env)) {
    const expiresAt = Math.floor(Date.now() / 1000) + ANALYSIS_URL_TTL_SECONDS;
    const url = localObjectUrl(env, '/api/local-sources/', key);
    url.searchParams.set('expires', String(expiresAt));
    url.searchParams.set('signature', await signLocalSource(env, key, expiresAt));
    return url.toString();
  }
  return presign(env, 'GET', key, ANALYSIS_URL_TTL_SECONDS);
}

/** Fresh GET for an app-owned, immutable isolation input snapshot. */
export async function presignIsolationDownload(env: Env, key: string): Promise<string> {
  if (!ISOLATION_SOURCE_KEY_PATTERN.test(key)) {
    throw new Error('Invalid isolation source key');
  }
  if (isLocalHosting(env)) {
    const expiresAt = Math.floor(Date.now() / 1000) + ISOLATION_URL_TTL_SECONDS;
    const url = localObjectUrl(env, '/api/local-sources/', key);
    url.searchParams.set('expires', String(expiresAt));
    url.searchParams.set('signature', await signLocalSource(env, key, expiresAt));
    return url.toString();
  }
  return presign(env, 'GET', key, ISOLATION_URL_TTL_SECONDS);
}
