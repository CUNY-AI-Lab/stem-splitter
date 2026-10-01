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
  if (typeof value === 'string' && /^\/\?job=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return value;
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
function isDocumentNavigation(request: Request): boolean {
  const destination = request.headers.get('sec-fetch-dest');
  return destination === null
    ? request.headers.get('accept')?.includes('text/html') === true
    : destination === 'document';
}
function signInFailure(request: Request, status = 401): Response {
  const safe = [401, 403, 429].includes(status) ? status : 503;
  if (!isDocumentNavigation(request)) {
    return safe === 429
      ? new Response('Please wait a moment before signing in again.', { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'private, no-store' } })
      : denied(safe);
  }
  const title = safe === 401 ? 'Start sign-in again' : safe === 403 ? 'Lab access required'
    : safe === 429 ? 'Wait a minute before trying again' : 'Sign-in is temporarily unavailable';
  const message = safe === 401 ? 'This sign-in link is no longer active. Sign in again to continue.'
    : safe === 403 ? 'You need active CUNY AI Lab access to continue. Request access, or contact the Lab if you were recently approved.'
    : safe === 429 ? 'You have tried signing in several times. Your saved splits have not changed.'
    : 'We could not reach the sign-in service. Please try again shortly. Your saved splits have not changed.';
  // Only fixed links and copy enter this page. Never echo callback state, codes,
  // provider errors or caller-supplied destinations into an authentication page.
  const action = safe === 403
    ? '<a class="account-button" href="https://ailab.gc.cuny.edu/request-access/">Request Lab access</a>'
    : `<a class="account-button" href="/auth/login">${safe === 401 ? 'CUNY Login' : 'Retry'}</a>`;
  const access = safe === 403 ? '<p><a href="mailto:ailab@gc.cuny.edu">Contact the Lab</a></p>' : '';
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
  if (safe === 429) headers.set('Retry-After', '60');
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>STEM Splitter · Sign in</title><link rel="stylesheet" href="/styles.css"></head><body><main class="teacher-main signin-recovery"><h1>${title}</h1><p>${message}</p><p class="signin-actions">${action}</p>${access}<p><a href="/">Back to Splitter</a></p></main></body></html>`, { status: safe, headers });
}
async function existingSessionStatus(request: Request, env: SsoEnv): Promise<200 | 401 | 403 | 503> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!TOKEN.test(token)) return 401;
  const client = identityClient(request, env);
  if (!client) return 503;
  try {
    // A cookie is not proof of a current session. Doorway rechecks the session
    // and Admission; validate the returned app identity before navigating.
    const result = await boundedRpc(client.identities(token));
    if (!result.ok) return result.status === 401 || result.status === 403 ? result.status : 503;
    const verifier = await loadIdentityVerifierConfig({ jwks: env.CAIL_IDENTITY_JWKS,
      issuer: CAIL_CANONICAL_ISSUER, expectedAudience: 'cail:stem-splitter', supportedIssuers: [CAIL_CANONICAL_ISSUER] });
    if (!verifier.ok || typeof result.appJwt !== 'string' || result.appJwt.length > 16384) return 503;
    return await verifyIdentityJwt(result.appJwt, verifier.config) ? 200 : 503;
  } catch { return 503; }
}
async function loginFailure(request: Request, env: SsoEnv, status = 401): Promise<Response> {
  const sessionStatus = status === 401 && isDocumentNavigation(request)
    ? await existingSessionStatus(request, env) : status;
  // Recovery is navigation only: never replay the callback or renew a session.
  // Once its transaction is invalid, do not trust its destination. Use home.
  const response = sessionStatus === 200 ? redirect('/') : signInFailure(request, sessionStatus);
  response.headers.append('Set-Cookie', cookie(LOGIN_COOKIE, '', 0));
  return response;
}

export async function handleAuth(request: Request, env: SsoEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || ![env.PUBLIC_BASE_URL, env.CANONICAL_BASE_URL].includes(url.origin)) return denied(403);
  const client = identityClient(request, env);
  if (!['/auth/login', '/auth/callback', '/auth/logout'].includes(url.pathname)) return new Response('Not found', { status: 404 });
  const method = url.pathname === '/auth/logout' ? 'POST' : 'GET';
  if (request.method !== method) return new Response(null, { status: 405, headers: { Allow: method } });
  if (method === 'POST' && (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site')) return denied(403);
  if (url.pathname === '/auth/logout') {
    const cleared = [cookie(SESSION_COOKIE, '', 0), cookie(LOGIN_COOKIE, '', 0)];
    const token = readCookie(request, SESSION_COOKIE);
    try {
      if (TOKEN.test(token)) {
        if (!client) throw new Error('Identity unavailable');
        await boundedRpc(client.revoke(token));
      }
      return redirect('/', cleared);
    } catch {
      // Always remove this browser's credentials; do not claim remote revocation.
      const response = new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>STEM Splitter · Sign out</title><link rel="stylesheet" href="/styles.css"><main class="teacher-main"><h1>Signed out of this browser</h1><p>We could not confirm that your server session ended. Close any other STEM Splitter tabs on this device.</p><a href="/">Back to Splitter</a></main></html>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } });
      for (const value of cleared) response.headers.append('Set-Cookie', value);
      return response;
    }
  }
  if (!client) return signInFailure(request, 503);
  try {
    if (url.pathname === '/auth/login') {
      if (!env.REQUEST_LIMIT) return signInFailure(request, 503);
      const limited = await env.REQUEST_LIMIT.limit({ key: `stem-login:${request.headers.get('cf-connecting-ip') || 'unknown'}` });
      if (!limited.success) return signInFailure(request, 429);
      if (isDocumentNavigation(request)) {
        const status = await existingSessionStatus(request, env);
        if (status === 200) return redirect(safeNext(url.searchParams.get('next')));
        if (status !== 401) return signInFailure(request, status);
      }
      const verifier = random(), state = random();
      const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      const result = await boundedRpc(client.begin(challenge, state));
      const target = new URL(result.url);
      if (target.origin !== DOORWAY || target.pathname !== '/worker-login' || target.username || target.password || target.hash) return signInFailure(request, 503);
      return redirect(target.href, [cookie(LOGIN_COOKIE, encodeURIComponent(JSON.stringify({ verifier, state, next: safeNext(url.searchParams.get('next')), expiresAt: Date.now() + 600000 })), 600)]);
    }
    if (url.pathname === '/auth/callback') {
      const raw = readCookie(request, LOGIN_COOKIE);
      if (!raw || raw.length > 1500) return loginFailure(request, env);
      let pending;
      try { pending = JSON.parse(decodeURIComponent(raw)); } catch { return loginFailure(request, env); }
      const code = url.searchParams.get('code');
      if (!pending || typeof pending !== 'object' || !PROOF.test(pending.state) || !PROOF.test(pending.verifier) ||
          pending.state !== url.searchParams.get('state') || !Number.isSafeInteger(pending.expiresAt) || pending.expiresAt <= Date.now() || pending.expiresAt > Date.now() + 600000 ||
          !code || !UUID.test(code) || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1) return loginFailure(request, env);
      const result = await boundedRpc(client.redeem(code, pending.verifier));
      if (!result.ok) return loginFailure(request, env, result.status);
      if (!TOKEN.test(result.token) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()) return loginFailure(request, env, 503);
      // A new login replaces this browser's previous app session, not CUNY's.
      const previous = readCookie(request, SESSION_COOKIE);
      if (TOKEN.test(previous) && previous !== result.token) await boundedRpc(client.revoke(previous));
      return redirect(safeNext(pending.next), [cookie(SESSION_COOKIE, result.token, Math.min(86400, Math.floor((result.expiresAt - Date.now()) / 1000))), cookie(LOGIN_COOKIE, '', 0)]);
    }
    return new Response('Not found', { status: 404 });
  } catch { return signInFailure(request, 503); }
}

export function publicApi(request: Request): boolean {
  const path = new URL(request.url).pathname;
  if (request.method === 'GET' && /^\/api\/shared-jobs\/[a-zA-Z0-9-]+(?:\/stems\/\d+)?$/.test(path)) return true;
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
