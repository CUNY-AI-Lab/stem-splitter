// Per-job webhook tokens. The completion webhook URL travels to every
// separation provider (Replicate, and the self-hosted GPU host through its
// tunnel). WEBHOOK_SECRET is also the key that signs every source URL
// (src/r2.ts), so providers receive a token derived for one job instead of the
// secret itself. The derivation is domain-separated from source signatures.

const PURPOSE = 'stem-splitter-webhook-v1';

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function payload(jobId: string): Uint8Array {
  return new TextEncoder().encode(`${PURPOSE}\n${jobId}`);
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '=');
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function jobWebhookToken(secret: string, jobId: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), payload(jobId));
  return base64Url(new Uint8Array(signature));
}

export async function webhookTokenMatches(
  secret: string,
  jobId: string | undefined,
  token: string
): Promise<boolean> {
  if (!secret || !token) return false;
  const signature = jobId ? decodeBase64Url(token) : null;
  if (signature && (await crypto.subtle.verify('HMAC', await hmacKey(secret), signature, payload(jobId!)))) {
    return true;
  }
  // Webhook URLs issued before per-job tokens carried the raw secret, and a
  // provider may still retry one; the app is the only other holder of it.
  return token === secret;
}
