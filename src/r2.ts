import { AwsClient } from 'aws4fetch';
import type { Env } from './env';

// Presigned URLs let the browser upload straight to R2 (and let the
// separation backend download the source) without the audio bytes ever
// flowing through the Worker.

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

/** Presigned PUT for browser uploads (15 min). */
export function presignUpload(env: Env, key: string): Promise<string> {
  return presign(env, 'PUT', key, 15 * 60);
}

/** Presigned GET so the separation backend can fetch the source (6 h). */
export function presignDownload(env: Env, key: string): Promise<string> {
  return presign(env, 'GET', key, 6 * 60 * 60);
}
