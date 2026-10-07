import type { Env } from '../src/env.ts';
import { activeGuest, guestFailure, GUEST_SESSION_MS, GUEST_SUBJECT, type GuestSession } from '../src/guest/access.ts';
import { dailyWindow } from '../src/daily-allowance.ts';
import { readBoundedJsonRequest } from '../src/http/bounded-request.ts';
import { readBoundedResponse } from '../src/http/bounded-response.ts';
import { uniqueCookie } from './session-contract/session.js';
import { gatewayModelsConfigured } from './gateway.ts';

export const GUEST_COOKIE = '__Host-stem-guest';
const MEMBER_COOKIE = '__Host-stem-session';
const TOKEN = /^([0-9a-f]{64})\.(\d{13})\.([A-Za-z0-9_-]{43})$/;
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const cookie = (value: string, seconds: number) => `${GUEST_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
export const clearGuestCookie = () => cookie('',0);
export const hasMemberCookie = (request: Request) => (request.headers.get('cookie') ?? '').split(';').some(part=>part.trim().split('=',1)[0]===MEMBER_COOKIE);
export interface GuestAdapterEnv extends Env {
  GATEWAY?: Fetcher;
  GATEWAY_MODEL?: string;
  GATEWAY_FALLBACK_MODEL?: string;
  CANONICAL_BASE_URL?: string;
}
/** Presence is a local readiness gate, not proof that Registry granted spend.
 * Every model request still receives live Registry authorization at Gateway. */
export function guestConfigured(env: GuestAdapterEnv): boolean {
  return env.GUEST_ENABLED === 'true' && typeof env.GUEST_COOKIE_SECRET === 'string' && env.GUEST_COOKIE_SECRET.length >= 32 && env.GUEST_COOKIE_SECRET.length <= 512
    && /^[A-Za-z0-9_-]{10,128}$/.test(env.GUEST_TURNSTILE_SITE_KEY ?? '')
    && /^[A-Za-z0-9_-]{20,512}$/.test(env.GUEST_TURNSTILE_SECRET ?? '')
    && /^sk-cail-[A-Za-z0-9_-]{20,256}$/.test(env.GUEST_GATEWAY_API_KEY ?? '')
    && Boolean(env.GATEWAY && env.REQUEST_LIMIT && gatewayModelsConfigured(env.GATEWAY_MODEL,env.GATEWAY_FALLBACK_MODEL));
}
async function signingKey(env: Env) {
  if (!env.GUEST_COOKIE_SECRET || env.GUEST_COOKIE_SECRET.length < 32) throw new Error('Guest signing unavailable');
  return crypto.subtle.importKey('raw',new TextEncoder().encode(env.GUEST_COOKIE_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
const message = (origin: string,id: string,expires: number) => new TextEncoder().encode(`stem-splitter-guest-v1\n${origin}\n${id}.${expires}`);
export async function readGuestSession(request: Request,env: Env): Promise<GuestSession | null> {
  const match = TOKEN.exec(uniqueCookie(request,GUEST_COOKIE));
  if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= Date.now() || Number(match[2]) > Date.now()+GUEST_SESSION_MS+1000) return null;
  try {
    const signature = Uint8Array.from(atob(match[3].replaceAll('-','+').replaceAll('_','/')+'='),c=>c.charCodeAt(0));
    if (encode(signature) !== match[3]) return null;
    if (!await crypto.subtle.verify('HMAC',await signingKey(env),signature,message(new URL(request.url).origin,match[1],Number(match[2])))) return null;
  } catch { return null; }
  // An unavailable database is not an invalid cookie. Preserve the browser's
  // session and let the adapter report 503 while keeping private content hidden.
  const session=await activeGuest(env.DB,`guest-${match[1]}`);
  return session?.expiresAt === Number(match[2]) ? session : null;
}
export async function revokeGuestSession(request: Request,env: Env): Promise<void> {
  const session=await readGuestSession(request,env);
  if (session) await env.DB.prepare('UPDATE guest_sessions SET revoked_at=? WHERE subject=? AND revoked_at IS NULL').bind(Date.now(),session.subject).run();
}
export async function startGuestSession(request: Request,env: GuestAdapterEnv): Promise<Response> {
  const url=new URL(request.url);
  if (request.method !== 'POST') return new Response(null,{status:405,headers:{Allow:'POST'}});
  if (url.protocol !== 'https:' || ![env.PUBLIC_BASE_URL,env.CANONICAL_BASE_URL].includes(url.origin)
    || request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') return guestFailure('guest_origin_invalid',403,'Open Stem Splitter directly to start a guest session.');
  if (hasMemberCookie(request)) return guestFailure('guest_signout_required',403,'Sign out of your existing account before starting a separate guest session.');
  if (!guestConfigured(env)) return guestFailure('guest_unavailable',503,'Guest access is not available. You can use CUNY Login.');
  const limited=await env.REQUEST_LIMIT!.limit({key:`stem-guest-start:${request.headers.get('cf-connecting-ip') || 'unknown'}`});
  if (!limited.success) return new Response(JSON.stringify({error:{code:'guest_rate_limited',message:'Please wait a minute before trying again.'}}),{status:429,headers:{'Content-Type':'application/json','Retry-After':'60'}});
  let token: unknown;
  try { token=(await readBoundedJsonRequest(request,4096) as {token?:unknown})?.token; } catch { return guestFailure('guest_verification_invalid',403,'Complete the guest check and try again.'); }
  if (typeof token !== 'string' || token.length < 1 || token.length > 2048) return guestFailure('guest_verification_invalid',403,'Complete the guest check and try again.');
  let result: {success?:unknown;hostname?:unknown;action?:unknown;challenge_ts?:unknown};
  try {
    const response=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({secret:env.GUEST_TURNSTILE_SECRET,response:token}),redirect:'manual',signal:AbortSignal.timeout(5000)});
    if (!response.ok) throw new Error('Verification unavailable');
    const failed=()=>new Error('Verification unavailable');
    result=JSON.parse(new TextDecoder().decode(await readBoundedResponse(response,{maximumBytes:8192,timeoutMs:5000,errors:{tooLarge:failed,timedOut:failed,unreadable:failed}})));
  } catch { return guestFailure('guest_verification_unavailable',503,'The guest check is temporarily unavailable. Try again shortly.'); }
  const time=typeof result.challenge_ts==='string'?Date.parse(result.challenge_ts):NaN;
  if (result.success !== true || result.hostname !== url.hostname || result.action !== 'stem_guest' || !Number.isFinite(time) || time>Date.now()+30000 || time<Date.now()-300000) return guestFailure('guest_verification_invalid',403,'Complete a new guest check and try again.');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
  const tokenHash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  const now=Date.now(), day=dailyWindow().day;
  const previous=await readGuestSession(request,env);
  const id=previous?.subject.slice(6) ?? Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
  const subject=`guest-${id}`,expiresAt=previous?.expiresAt ?? now+GUEST_SESSION_MS;
  if (!GUEST_SUBJECT.test(subject)) throw new Error('Guest subject invalid');
  const signature=encode(new Uint8Array(await crypto.subtle.sign('HMAC',await signingKey(env),message(url.origin,id,expiresAt))));
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO guest_challenges(token_hash,expires_at) VALUES(?,?)').bind(tokenHash,now+600000),
      previous ? env.DB.prepare('UPDATE guest_sessions SET verified_day=? WHERE subject=? AND revoked_at IS NULL AND expires_at>?').bind(day,subject,now)
        : env.DB.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)').bind(subject,now,expiresAt,day),
    ]);
  } catch {
    try {
      if(await env.DB.prepare('SELECT 1 FROM guest_challenges WHERE token_hash=?').bind(tokenHash).first()) return guestFailure('guest_verification_replayed',403,'This guest check was already used. Complete a new check.');
    } catch { /* Keep storage failures distinct from rejected verification. */ }
    return guestFailure('guest_session_unavailable',503,'The guest session could not be saved. Try again shortly.');
  }
  return Response.json({ok:true,expiresAt,splitLimit:5,chatLimit:25},{headers:{'Cache-Control':'private, no-store','Set-Cookie':cookie(`${id}.${expiresAt}.${signature}`,Math.floor((expiresAt-now)/1000))}});
}
