import type { Env } from './env.ts';

type Credentials = Pick<Env, 'REPLICATE_API_TOKEN' | 'REPLICATE_FALLBACK_API_TOKEN'>;

export function hasReplicateCredentials(env: Credentials): boolean {
  return Boolean(env.REPLICATE_API_TOKEN || env.REPLICATE_FALLBACK_API_TOKEN);
}

/** A second credential may follow a definitive rejection, never an uncertain
 * create. Polling and cancellation can locate predictions owned by either key.
 * Callers retain the same model, source, webhook, deadline and operation. */
export async function replicateRequest(env: Credentials, address: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(address);
  const method = (init.method || 'GET').toUpperCase();
  const api = url.origin === 'https://api.replicate.com' && url.pathname.startsWith('/v1/');
  const delivery = method === 'GET' && (url.hostname === 'replicate.delivery' || url.hostname.endsWith('.replicate.delivery'));
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || (!api && !delivery)) {
    throw new Error('Invalid Replicate request address');
  }
  const create = api && method === 'POST' && url.pathname === '/v1/predictions';
  const lookup = method === 'GET' || api && method === 'POST' && /^\/v1\/predictions\/[a-zA-Z0-9_-]{1,128}\/cancel$/.test(url.pathname);
  const tokens = [...new Set([env.REPLICATE_API_TOKEN, env.REPLICATE_FALLBACK_API_TOKEN].filter((token): token is string => Boolean(token)))];
  if (!tokens.length) throw new Error('Replicate credentials are unavailable');
  for (let index = 0; index < tokens.length; index++) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${tokens[index]}`);
    const response = await fetch(url.href, { ...init, headers, redirect: 'manual' });
    const rejected = create ? [401, 402, 403, 429].includes(response.status)
      : lookup && [401, 403, 404].includes(response.status);
    if (!rejected || index + 1 === tokens.length) return response;
    await response.body?.cancel().catch(() => undefined);
    init.signal?.throwIfAborted();
  }
  throw new Error('Replicate request could not be completed');
}
