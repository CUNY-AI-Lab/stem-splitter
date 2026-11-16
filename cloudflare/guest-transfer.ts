import type { WorkerEnv } from './worker.ts';
import { guestConfigured, readGuestSession, guestSessionCookie, startGuestSession, hasMemberCookie } from './guest.ts';
import { activeGuest } from '../src/guest/access.ts';
import { uniqueCookie } from './session-contract/session.js';
import { JsonRequestError, readBoundedJsonRequest } from '../src/http/bounded-request.ts';
import { claimedUiStateStatements, seedGuestJobUiState, writeGuestJobUiState, UiStateError, type UiStateWrite, type ActiveUiStateKind } from '../src/ui-state.ts';

export const TRANSFER_COOKIE = '__Host-stem-transfer';
const tools = 'https://tools.ailab.gc.cuny.edu';
const legacy = 'https://stem-splitter.ailab-452.workers.dev';
const toolsTransitionFailure = `${tools}/stem-splitter/guest-transfer.html#transfer-failed`;
const noncePattern = /^[A-Za-z0-9_-]{43}$/;
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const decode = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4-value.length%4)%4)), c => c.charCodeAt(0));
const cookie = (value: string, age: number) => `${TRANSFER_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };
async function key(env: WorkerEnv) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('stem-guest-transfer-v1\n' + env.GUEST_COOKIE_SECRET));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function redirect(location: string, setCookie?: string) {
  return new Response(null, { status: 303, headers: { ...headers, Location: location, ...(setCookie ? { 'Set-Cookie': setCookie } : {}) } });
}
function failure() {
  return Response.json({ error: { message: 'Your previous workspace could not be restored. Try again from the previous Stem Splitter address.' } }, { status: 403, headers });
}
function topLevelFailure() { return redirect(toolsTransitionFailure); }

function validSourceMutation(request: Request): boolean {
  return new URL(request.url).origin === legacy && request.method === 'POST'
    && request.headers.get('origin') === legacy && request.headers.get('sec-fetch-site') !== 'cross-site'
    && !request.headers.has('x-cail-identity-jwt') && !request.headers.has('x-cail-gateway-identity-jwt');
}

async function copyLateClaim(env: WorkerEnv, subject: string, expiresAt: number) {
  const claim = await env.DB.prepare('SELECT member_subject FROM guest_account_claims WHERE guest_subject=?')
    .bind(subject).first<{ member_subject: string }>();
  if (claim) await env.DB.batch(claimedUiStateStatements(env.DB, subject, claim.member_subject, { now: Date.now(), expiresAt }));
}

function sourceSeedDocument(nonce: string, existingOnly: boolean): Response {
  const continueUrl = `/auth/guest-transfer/continue?state=${nonce}${existingOnly ? '&existingOnly=1' : ''}`;
  const metadata = JSON.stringify({ continueUrl }).replaceAll('<', '\\u003c');
  // Keep the original guest cookie until the first-party script has seeded its
  // namespace. In particular, a claimed cookie must not be bootstrapped away.
  // The refresh also bounds this empty document when its script cannot load.
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="8;url=${continueUrl.replaceAll('&', '&amp;')}"><title>Stem Splitter</title><script type="application/json" id="stem-transfer-source">${metadata}</script><script src="/guest-claim.js" defer></script><script src="/workspace-continuity.js" defer></script><script src="/guest-transfer-source.js" defer></script></head><body></body></html>`, {
    headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

async function seedSourceGuest(request: Request, env: WorkerEnv): Promise<Response> {
  if (!validSourceMutation(request)) return failure();
  try {
    const limited = await env.REQUEST_LIMIT!.limit({ key: `stem-transfer-seed:${request.headers.get('cf-connecting-ip') || 'unknown'}` });
    if (!limited.success) return new Response(null, { status: 429, headers });
    const session = await readGuestSession(request, env);
    if (!session) return new Response(null, { status: 401, headers });
    if (request.headers.get('X-Stem-Account') !== session.subject) return new Response(null, { status: 409, headers });
    const body = await readBoundedJsonRequest(request, 512 * 1024) as { requestId?: unknown; records?: unknown };
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(name => !['requestId', 'records'].includes(name))
      || typeof body.requestId !== 'string' || !requestIdPattern.test(body.requestId)
      || !Array.isArray(body.records) || body.records.length < 1 || body.records.length > 64) return new Response(null, { status: 400, headers });
    const accepted: Array<{ jobId: string; kind: string }> = [], denied: typeof accepted = [], deferred: typeof accepted = [];
    const seen = new Set<string>();
    for (const record of body.records) {
      if (!record || typeof record !== 'object' || Array.isArray(record)
        || Object.keys(record).some(name => !['jobId', 'kind', 'value'].includes(name))
        || typeof record.jobId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(record.jobId)
        || !['listeningDraft', 'listeningPlayer', 'pendingConversation', 'pendingChat', 'pendingGuide'].includes(record.kind)
        || !Object.prototype.hasOwnProperty.call(record, 'value') || seen.has(`${record.jobId}:${record.kind}`)) return new Response(null, { status: 400, headers });
      seen.add(`${record.jobId}:${record.kind}`);
    }
    for (const record of body.records) {
      const reference = { jobId: record.jobId, kind: record.kind };
      try {
        // The helper rechecks live cookie lifetime and exact guest/claim job
        // ownership inside its atomic write. Browser IDs grant no authority.
        await seedGuestJobUiState(env.DB, session.subject, record, {
          requestId: body.requestId, guestExpiresAt: session.expiresAt, now: Date.now(),
        });
        accepted.push(reference);
      } catch (error) {
        const status = (error as { status?: number })?.status;
        (status === 400 || status === 403 || status === 404 || status === 422 ? denied : deferred).push(reference);
      }
    }
    // A claim before, during or after seeding cannot strand newly seeded work:
    // claim copies inside its transaction; late seeds copy via its exact journal.
    if (accepted.length) await copyLateClaim(env, session.subject, session.expiresAt);
    return Response.json({ accepted, denied, deferred }, { headers: { ...headers, 'X-Stem-Account': session.subject } });
  } catch (error) {
    // No submitted text, account identity or SQL detail is returned or logged.
    return new Response(null, { status: error instanceof JsonRequestError ? error.status : 503, headers });
  }
}

async function writeSourceGuest(request: Request, env: WorkerEnv): Promise<Response> {
  if (!validSourceMutation(request)) return failure();
  try {
    const limited = await env.REQUEST_LIMIT!.limit({ key: `stem-transfer-write:${request.headers.get('cf-connecting-ip') || 'unknown'}` });
    if (!limited.success) return new Response(null, { status: 429, headers });
    const session = await readGuestSession(request, env);
    if (!session) return new Response(null, { status: 401, headers });
    if (request.headers.get('X-Stem-Account') !== session.subject) return new Response(null, { status: 409, headers });
    const body = await readBoundedJsonRequest(request, 32768) as UiStateWrite & { jobId: string };
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 5
      || !['jobId','requestId','kind','baseRevision','value'].every(name => Object.hasOwn(body,name))
      || typeof body.jobId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(body.jobId)
      || typeof body.requestId !== 'string' || !requestIdPattern.test(body.requestId)
      || !['listeningDraft','listeningPlayer'].includes(body.kind)
      || !Number.isSafeInteger(body.baseRevision) || body.baseRevision! < 0) return new Response(null, { status: 400, headers });
    const { jobId, ...input } = body;
    const result = await writeGuestJobUiState(env.DB, session.subject, jobId, { ...input, kind: input.kind as ActiveUiStateKind, baseRevision: input.baseRevision! }, {
      guestExpiresAt: session.expiresAt, now: Date.now(),
    });
    await copyLateClaim(env, session.subject, session.expiresAt);
    return Response.json(result, { status: result.outcome === 'conflict' ? 409 : 200, headers: { ...headers, 'X-Stem-Account': session.subject } });
  } catch (error) {
    return new Response(null, { status: error instanceof JsonRequestError || error instanceof UiStateError ? error.status : 503, headers });
  }
}

/** A top-level visit lets the original host read its own HttpOnly guest cookie.
 * An encrypted, five-minute fragment returns it to the initiating browser only.
 * No identity, session cookie or audio locator is placed in a query or server log. */
export async function guestTransfer(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const toolsStart = url.origin === tools && url.pathname === '/auth/guest-transfer/start' && request.method === 'GET';
  const sourceStart = url.origin === legacy && url.pathname === '/auth/guest-transfer' && request.method === 'GET';
  const sourceContinue = url.origin === legacy && url.pathname === '/auth/guest-transfer/continue' && request.method === 'GET';
  if (!guestConfigured(env)) return toolsStart || sourceStart || sourceContinue ? topLevelFailure() : new Response('Guest access unavailable', { status: 503, headers });
  if (url.pathname === '/auth/guest-transfer/seed') return seedSourceGuest(request, env);
  if (url.pathname === '/auth/guest-transfer/write') return writeSourceGuest(request, env);
  if (url.pathname === '/auth/guest-transfer/context') {
    if (url.origin !== legacy || request.method !== 'GET' || request.headers.get('sec-fetch-site') === 'cross-site'
      || request.headers.has('x-cail-identity-jwt') || request.headers.has('x-cail-gateway-identity-jwt')) return failure();
    try {
      const limited = await env.REQUEST_LIMIT!.limit({ key: `stem-transfer-context:${request.headers.get('cf-connecting-ip') || 'unknown'}` });
      if (!limited.success) return new Response(null, { status: 429, headers });
      // This is deliberately independent of /api/account: both a member and a
      // guest cookie can be present, and neither namespace may label the other.
      // Claimed guests can seed late local copies but regain no job access here.
      const session = await readGuestSession(request, env);
      return Response.json({ guest: session ? { subject: session.subject, expiresAt: session.expiresAt } : null }, {
        headers: { ...headers, ...(session ? { 'X-Stem-Account': session.subject } : {}) },
      });
    } catch { return new Response(null, { status: 503, headers }); }
  }
  if (toolsStart) {
    try {
      const nonce = encode(crypto.getRandomValues(new Uint8Array(32)));
      const existingOnly = url.searchParams.get('existingOnly') === '1';
      return redirect(`${legacy}/auth/guest-transfer?state=${nonce}${existingOnly ? '&existingOnly=1' : ''}`, cookie(nonce, 300));
    } catch { return topLevelFailure(); }
  }
  if (sourceStart || sourceContinue) {
    try {
      const nonce = url.searchParams.get('state') || '';
      const existingOnly = url.searchParams.get('existingOnly') === '1';
      if (!noncePattern.test(nonce)) return topLevelFailure();
      const limited = await env.REQUEST_LIMIT!.limit({ key: `stem-transfer:${request.headers.get('cf-connecting-ip') || 'unknown'}` });
      if (!limited.success) return topLevelFailure();
      if (sourceStart) return sourceSeedDocument(nonce, existingOnly);
      let session = await readGuestSession(request, env);
      const claimed = session && await env.DB.prepare('SELECT 1 FROM guest_account_claims WHERE guest_subject=?').bind(session.subject).first();
      if (claimed) session = null;
      let sourceCookie: string | undefined;
      // Bootstrap on the original host so a first visit at either address uses
      // the same guest identity. Never replace an existing signed-in workspace.
      if (!session && !existingOnly && !hasMemberCookie(request)) {
        const bootstrapHeaders = new Headers(request.headers);
        bootstrapHeaders.set('origin', legacy);
        bootstrapHeaders.set('sec-fetch-site', 'same-origin');
        bootstrapHeaders.set('content-type', 'application/json');
        const fresh = await startGuestSession(new Request(legacy + '/auth/guest', {
          method: 'POST', headers: bootstrapHeaders, body: '{}',
        }), env);
        if (!fresh.ok) return topLevelFailure();
        sourceCookie = fresh.headers.get('set-cookie') ?? undefined;
        session = await readGuestSession(new Request(legacy, { headers: { cookie: sourceCookie?.split(';')[0] ?? '' } }), env);
        if (!session) return topLevelFailure();
      }
      const body = JSON.stringify({ nonce, expires: Date.now() + 300000, subject: session?.subject ?? null, existingOnly });
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(tools) }, await key(env), new TextEncoder().encode(body)));
      return redirect(`${tools}/stem-splitter/guest-transfer.html#${encode(iv)}.${encode(sealed)}`, sourceCookie);
    } catch { return topLevelFailure(); }
  }
  if (url.origin !== tools || url.pathname !== '/auth/guest-transfer/finish' || request.method !== 'POST'
    || request.headers.get('origin') !== tools || request.headers.get('sec-fetch-site') === 'cross-site') return failure();
  try {
    const body = await readBoundedJsonRequest(request, 2048) as { token?: unknown };
    if (typeof body?.token !== 'string' || !/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,1024}$/.test(body.token)) return failure();
    const [iv, sealed] = body.token.split('.');
    if (encode(decode(iv)) !== iv || encode(decode(sealed)) !== sealed) return failure();
    const payload = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv), additionalData: new TextEncoder().encode(tools) }, await key(env), decode(sealed)))) as { nonce?: unknown; expires?: unknown; subject?: unknown; existingOnly?: unknown };
    if (typeof payload.nonce !== 'string' || !noncePattern.test(payload.nonce) || payload.nonce !== uniqueCookie(request, TRANSFER_COOKIE)
      || typeof payload.expires !== 'number' || payload.expires <= Date.now() || payload.expires > Date.now() + 300000) return failure();
    if (payload.subject === null && payload.existingOnly !== true) return Response.json({ error: { code: 'member_workspace', message: 'Sign in with CUNY to check your previous workspace.' } }, { status: 409, headers });
    const session = typeof payload.subject === 'string' ? await activeGuest(env.DB, payload.subject) : null;
    if (payload.subject !== null && (!session || await env.DB.prepare('SELECT 1 FROM guest_account_claims WHERE guest_subject=?').bind(session.subject).first())) return failure();
    const current = await readGuestSession(request, env);
    if (session && current && current.subject !== session.subject
      && !await env.DB.prepare('SELECT 1 FROM guest_account_claims WHERE guest_subject=?').bind(current.subject).first()) {
      return Response.json({ error: { code: 'workspace_conflict', message: 'These addresses have separate guest workspaces. Open each workspace and save its tracks to your CUNY account to keep both.' } }, { status: 409, headers });
    }
    // The existing short-lived challenge table provides an atomic replay fence.
    const hash = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('transfer:' + payload.nonce))));
    await env.DB.prepare('INSERT INTO guest_challenges(token_hash,expires_at) VALUES(?,?)').bind(hash, payload.expires).run();
    const response = Response.json({ restored: Boolean(session) }, { headers });
    response.headers.append('Set-Cookie', cookie('', 0));
    if (session) response.headers.append('Set-Cookie', await guestSessionCookie(env, tools, session));
    return response;
  } catch { return failure(); }
}
