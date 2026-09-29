import { authFailure } from '../src/identity.ts';
import { CAIL_CANONICAL_ISSUER, loadIdentityVerifierConfig, verifyIdentityJwt } from '@cuny-ai-lab/cail-identity';
import { REQUEST_ID } from './gateway.ts';

// Doorway owns CUNY OIDC, one-use PKCE grants, session revocation and Admission.
// These RPC capabilities have deployment-pinned audiences and callback hosts.
export interface WorkerIdentity {
  begin(challenge: string, state: string): Promise<{ url: string }>;
  redeem(code: string, verifier: string): Promise<{ ok: true; token: string; expiresAt: number } | { ok: false; status: number }>;
  identities(token: string): Promise<{ ok: true; appJwt: string; gatewayJwt: string; workspaceJwt: string | null } | { ok: false; status: number }>;
  revoke(token: string): Promise<unknown>;
}
export interface SsoEnv {
  PUBLIC_BASE_URL: string;
  CANONICAL_BASE_URL?: string;
  IDENTITY?: WorkerIdentity;
  PREVIEW_IDENTITY?: WorkerIdentity;
  REQUEST_LIMIT?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  CAIL_IDENTITY_JWKS?: string;
}
export const SESSION_COOKIE = '__Host-stem-session';
export const LOGIN_COOKIE = '__Host-stem-login';
const PROOF = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/;
const DOORWAY = 'https://tools.ailab.gc.cuny.edu';
const cookie = (name: string, value: string, seconds: number) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

export function safeNext(value: unknown): string {
  // Fixed page destinations, never a caller-selected host, callback or API.
  return typeof value === 'string' && ['/', '/teacher.html', '/account.html'].includes(value) ? value : '/';
}
function readCookie(request: Request, name: string): string {
  const values = (request.headers.get('cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : '';
}
function identityClient(request: Request, env: SsoEnv): WorkerIdentity | undefined {
  return new URL(request.url).origin === env.CANONICAL_BASE_URL ? env.IDENTITY : env.PREVIEW_IDENTITY;
}
export async function boundedRpc<T>(call: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([call, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Sign-in timeout')), 5000); })]);
  } finally { if (timer) clearTimeout(timer); }
}
function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(null, { status: 303, headers });
}
function denied(status: number): Response {
  const safe = status === 401 || status === 403 ? status : 503;
  return authFailure(safe === 401 ? 'authentication_required' : safe === 403 ? 'admission_required' : 'admission_unavailable', safe);
}
function loginFailure(status = 401): Response {
  const response = denied(status);
  response.headers.append('Set-Cookie', cookie(LOGIN_COOKIE, '', 0));
  return response;
}

export async function handleAuth(request: Request, env: SsoEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || ![env.PUBLIC_BASE_URL, env.CANONICAL_BASE_URL].includes(url.origin)) return denied(403);
  const client = identityClient(request, env);
  if (!client) return denied(503);
  if (!['/auth/login', '/auth/callback', '/auth/logout'].includes(url.pathname)) return new Response('Not found', { status: 404 });
  const method = url.pathname === '/auth/logout' ? 'POST' : 'GET';
  if (request.method !== method) return new Response(null, { status: 405, headers: { Allow: method } });
  if (method === 'POST' && (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site')) return denied(403);
  try {
    if (url.pathname === '/auth/login') {
      if (!env.REQUEST_LIMIT) return denied(503);
      const limited = await env.REQUEST_LIMIT.limit({ key: `stem-login:${request.headers.get('cf-connecting-ip') || 'unknown'}` });
      if (!limited.success) return new Response('Please wait a moment before signing in again.', { status: 429, headers: { 'Retry-After': '60' } });
      const verifier = random(), state = random();
      const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      const result = await boundedRpc(client.begin(challenge, state));
      const target = new URL(result.url);
      if (target.origin !== DOORWAY || target.pathname !== '/worker-login' || target.username || target.password || target.hash) return denied(503);
      return redirect(target.href, [cookie(LOGIN_COOKIE, encodeURIComponent(JSON.stringify({ verifier, state, next: safeNext(url.searchParams.get('next')), expiresAt: Date.now() + 600000 })), 600)]);
    }
    if (url.pathname === '/auth/callback') {
      const raw = readCookie(request, LOGIN_COOKIE);
      if (!raw || raw.length > 1500) return loginFailure();
      let pending;
      try { pending = JSON.parse(decodeURIComponent(raw)); } catch { return loginFailure(); }
      const code = url.searchParams.get('code');
      if (!pending || typeof pending !== 'object' || !PROOF.test(pending.state) || !PROOF.test(pending.verifier) ||
          pending.state !== url.searchParams.get('state') || !Number.isSafeInteger(pending.expiresAt) || pending.expiresAt <= Date.now() || pending.expiresAt > Date.now() + 600000 ||
          !code || !UUID.test(code) || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1) return loginFailure();
      const result = await boundedRpc(client.redeem(code, pending.verifier));
      if (!result.ok) return loginFailure(result.status);
      if (!TOKEN.test(result.token) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()) return loginFailure(503);
      // A new login replaces this browser's previous app session, not CUNY's.
      const previous = readCookie(request, SESSION_COOKIE);
      if (TOKEN.test(previous) && previous !== result.token) await boundedRpc(client.revoke(previous));
      return redirect(safeNext(pending.next), [cookie(SESSION_COOKIE, result.token, Math.min(86400, Math.floor((result.expiresAt - Date.now()) / 1000))), cookie(LOGIN_COOKIE, '', 0)]);
    }
    const token = readCookie(request, SESSION_COOKIE);
    if (TOKEN.test(token)) await boundedRpc(client.revoke(token));
    return redirect('/', [cookie(SESSION_COOKIE, '', 0), cookie(LOGIN_COOKIE, '', 0)]);
  } catch { return denied(503); }
}

export function publicApi(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return ((path === '/api/runtime' || path === '/api/separation-options' || path.startsWith('/api/local-sources/')) && request.method === 'GET') ||
    (path === '/api/webhooks/separation' && request.method === 'POST');
}

export async function authenticatedRequest(request: Request, env: SsoEnv): Promise<Request | Response> {
  const headers = new Headers(request.headers);
  const requestId = headers.get('x-cail-request-id') ?? headers.get('x-request-id');
  // Even a valid app JWT submitted by the browser is not authority here.
  for (const name of [...headers.keys()]) if (name === 'cookie' || name === 'authorization' || name.startsWith('x-cail-')) headers.delete(name);
  if (requestId && REQUEST_ID.test(requestId)) headers.set('x-cail-request-id', requestId);
  if (!publicApi(request)) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
        (request.headers.get('origin') !== env.PUBLIC_BASE_URL || request.headers.get('sec-fetch-site') === 'cross-site')) return denied(403);
    const [appConfig, gatewayConfig] = await Promise.all(['cail:stem-splitter', 'cail:gateway'].map(expectedAudience =>
      loadIdentityVerifierConfig({ jwks: env.CAIL_IDENTITY_JWKS, issuer: CAIL_CANONICAL_ISSUER, expectedAudience, supportedIssuers: [CAIL_CANONICAL_ISSUER] })));
    if (!appConfig.ok || !gatewayConfig.ok) return authFailure('identity_unavailable', 503);
    const token = readCookie(request, SESSION_COOKIE);
    if (!TOKEN.test(token)) return denied(401);
    const client = identityClient(request, env);
    if (!client) return denied(503);
    try {
      const result = await boundedRpc(client.identities(token));
      if (!result.ok) return denied(result.status);
      if (typeof result.appJwt !== 'string' || !result.appJwt || result.appJwt.length > 16384) return denied(503);
      headers.set('x-cail-identity-jwt', result.appJwt);
      const modelAction = /^\/api\/jobs\/[^/]+\/(?:guide|chat)$/.test(new URL(request.url).pathname) || new URL(request.url).pathname === '/api/model-quota';
      if (modelAction) {
        if (typeof result.gatewayJwt !== 'string' || result.gatewayJwt.length > 16384) return authFailure('invalid_credential', 401);
        const app = await verifyIdentityJwt(result.appJwt, appConfig.config);
        const gateway = await verifyIdentityJwt(result.gatewayJwt, gatewayConfig.config);
        if (!app || !gateway || app.subject !== gateway.subject) return authFailure('invalid_credential', 401);
        headers.set('x-cail-gateway-identity-jwt', result.gatewayJwt);
      }
    } catch { return denied(503); }
  }
  // The shared app still verifies signature/audience + fresh Admission + role + ownership.
  return new Request(request.url, { method: request.method, headers, body: request.body, redirect: 'manual', signal: request.signal });
}
