import type { Env } from './env.ts';
import type { AppPrincipal } from './identity.ts';
import { CourseError, jobPermission } from './classroom/access.ts';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const JOB_ID = /^[A-Za-z0-9-]{1,80}$/;
const TTL_MS = 5 * 60 * 1000;
const MAX_JOBS = 500;
const PRODUCTION_SOURCE_ORIGIN = 'https://stem-splitter.ailab-452.workers.dev';
const PRODUCTION_DESTINATION_ORIGIN = 'https://tools.ailab.gc.cuny.edu';

export type TransferActor = 'member' | 'guest';
export type TransferError = 'forbidden' | 'invalid' | 'expired' | 'replayed' | 'unavailable';

type ProofRow = {
  proof_hash: string;
  subject: string;
  actor_kind: TransferActor;
  source_origin: string;
  destination_origin: string;
  expires_at: number;
  state: 'issued' | 'source_verified' | 'staged' | 'consumed';
};

function fail(code: TransferError, status = 403): Response {
  return Response.json({ error: { code } }, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

function actorKind(principal: AppPrincipal): TransferActor | null {
  if (principal.quotaClass === 'guest' && principal.role === 'guest' && /^guest-[0-9a-f]{64}$/.test(principal.subject)) return 'guest';
  if (principal.quotaClass !== 'guest' && /^cail-[0-9a-f]{32}$/.test(principal.subject)) return 'member';
  return null;
}

function origin(value: string | undefined): string | null {
  try {
    const url = new URL(value || '');
    return url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

function transferOrigins(env: Env): { source: string; destination: string; active: string } | null {
  const source = origin(env.PUBLIC_BASE_URL);
  const destination = origin(env.CAIL_BROWSER_ORIGIN);
  if (source !== PRODUCTION_SOURCE_ORIGIN || destination !== PRODUCTION_DESTINATION_ORIGIN) return null;
  const active = env.APP_BASE_PATH === '/stem-splitter' ? destination : source;
  return { source, destination, active };
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`stem-browser-transfer:v1\n${token}`));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

function newToken(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function validPrincipal(principal: AppPrincipal): TransferActor | Response {
  return actorKind(principal) ?? fail('forbidden');
}

export async function createBrowserTransferProof(env: Env, principal: AppPrincipal): Promise<Response> {
  const scopes = transferOrigins(env);
  const actor = validPrincipal(principal);
  if (actor instanceof Response) return actor;
  if (!scopes || scopes.active !== scopes.destination) return fail('forbidden');
  const now = Date.now();
  const token = newToken();
  try {
    if (!env.REQUEST_LIMIT) return fail('unavailable', 503);
    const limited = await env.REQUEST_LIMIT.limit({ key: `browser-transfer:${await hashToken(principal.subject)}` });
    if (!limited.success) return fail('unavailable', 429);
    await env.DB.prepare(`INSERT INTO browser_transfer_proofs
      (proof_hash,subject,actor_kind,source_origin,destination_origin,expires_at,state,created_at)
      VALUES(?,?,?,?,?,?,'issued',?)`)
      .bind(await hashToken(token), principal.subject, actor, scopes.source, scopes.destination, now + TTL_MS, now).run();
    return Response.json({ proof: token, sourceOrigin: scopes.source, destinationOrigin: scopes.destination, expiresAt: now + TTL_MS }, {
      headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' },
    });
  } catch { return fail('unavailable', 503); }
}

async function readProof(env: Env, token: unknown): Promise<ProofRow | null> {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  return env.DB.prepare(`SELECT proof_hash,subject,actor_kind,source_origin,destination_origin,expires_at,state
    FROM browser_transfer_proofs WHERE proof_hash=?`).bind(await hashToken(token)).first<ProofRow>();
}

function matchesCurrent(row: ProofRow | null, env: Env, principal: AppPrincipal, expectedState: ProofRow['state'], activeOrigin: string): boolean {
  const scopes = transferOrigins(env);
  return Boolean(row && scopes && scopes.active === activeOrigin && row.source_origin === scopes.source &&
    row.destination_origin === scopes.destination && row.subject === principal.subject &&
    row.actor_kind === actorKind(principal) && row.expires_at > Date.now() && row.state === expectedState);
}

export async function authorizeBrowserTransferSource(env: Env, principal: AppPrincipal, proof: unknown): Promise<Response> {
  const scopes = transferOrigins(env);
  if (!scopes || scopes.active !== scopes.source || !actorKind(principal)) return fail('forbidden');
  try {
    const row = await readProof(env, proof);
    if (!row || row.expires_at <= Date.now()) return fail(row ? 'expired' : 'invalid');
    if (!matchesCurrent(row, env, principal, 'issued', scopes.source)) return fail('forbidden');
    const result = await env.DB.prepare(`UPDATE browser_transfer_proofs SET state='source_verified',source_verified_at=?
      WHERE proof_hash=? AND subject=? AND state='issued' AND expires_at>?`)
      .bind(Date.now(), row.proof_hash, principal.subject, Date.now()).run();
    if ((result.meta?.changes ?? 0) !== 1) return fail('replayed', 409);
    return Response.json({ authorized: true }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch { return fail('unavailable', 503); }
}

function parseJobIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_JOBS || value.some(id => typeof id !== 'string' || !JOB_ID.test(id))) return null;
  const ids = value as string[];
  return new Set(ids).size === ids.length ? ids : null;
}

async function currentlyAllowedJobIds(env: Env, principal: AppPrincipal, ids: string[]): Promise<string[]> {
  const allowed: string[] = [];
  for (const id of ids) {
    try { if (await jobPermission(env, principal, id)) allowed.push(id); }
    catch (error) {
      // One revoked class grant should omit that job, while unavailable current
      // authority must abort the whole check rather than guess.
      if (error instanceof CourseError && error.status === 403) continue;
      throw error;
    }
  }
  return allowed;
}

export async function stageBrowserTransfer(env: Env, principal: AppPrincipal, proof: unknown, rawJobIds: unknown): Promise<Response> {
  const scopes = transferOrigins(env);
  if (!scopes || scopes.active !== scopes.destination || !actorKind(principal)) return fail('forbidden');
  const ids = parseJobIds(rawJobIds);
  if (!ids) return fail('invalid', 400);
  try {
    const row = await readProof(env, proof);
    if (!row || row.expires_at <= Date.now()) return fail(row ? 'expired' : 'invalid');
    if (!matchesCurrent(row, env, principal, 'source_verified', scopes.destination)) return fail('forbidden');
    const allowed = await currentlyAllowedJobIds(env, principal, ids);
    const result = await env.DB.prepare(`UPDATE browser_transfer_proofs SET state='staged'
      WHERE proof_hash=? AND subject=? AND state='source_verified' AND expires_at>?`)
      .bind(row.proof_hash, principal.subject, Date.now()).run();
    if ((result.meta?.changes ?? 0) !== 1) return fail('replayed', 409);
    return Response.json({ allowedJobIds: allowed }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch { return fail('unavailable', 503); }
}

/** Recheck every imported job at apply time, because class grants can change while a recovery copy is staged. */
export async function reauthorizeBrowserTransferJobs(env: Env, principal: AppPrincipal, rawJobIds: unknown): Promise<Response> {
  if (!actorKind(principal)) return fail('forbidden');
  const ids = parseJobIds(rawJobIds);
  if (!ids) return fail('invalid', 400);
  try {
    const allowed = await currentlyAllowedJobIds(env, principal, ids);
    return Response.json({ allowedJobIds: allowed }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch { return fail('unavailable', 503); }
}

export async function consumeBrowserTransfer(env: Env, principal: AppPrincipal, proof: unknown): Promise<Response> {
  const scopes = transferOrigins(env);
  if (!scopes || scopes.active !== scopes.destination || !actorKind(principal)) return fail('forbidden');
  try {
    const row = await readProof(env, proof);
    if (!row || row.expires_at <= Date.now()) return fail(row ? 'expired' : 'invalid');
    if (!matchesCurrent(row, env, principal, 'staged', scopes.destination)) return fail('forbidden');
    const result = await env.DB.prepare(`UPDATE browser_transfer_proofs SET state='consumed',consumed_at=?
      WHERE proof_hash=? AND subject=? AND state='staged' AND expires_at>?`)
      .bind(Date.now(), row.proof_hash, principal.subject, Date.now()).run();
    if ((result.meta?.changes ?? 0) !== 1) return fail('replayed', 409);
    return Response.json({ consumed: true }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch { return fail('unavailable', 503); }
}

/** Test-only contract exports; all callers still go through the authenticated API routes. */
export const browserTransferContract = { actorKind, parseJobIds, transferOrigins };
