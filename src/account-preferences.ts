import type { Env } from './env.ts';

export const PREFERENCE_KINDS = ['classChoice','modelChoice','benchTab','sampleRotation','rackLayout'] as const;
export type PreferenceKind = typeof PREFERENCE_KINDS[number];
export type PreferenceValue = string | null | Record<string, unknown>;
export type PreferenceSeedInput = { requestId: string; records: Array<{ kind: PreferenceKind; value: PreferenceValue }> };
export type PreferenceWrite = { kind: PreferenceKind; requestId: string; baseRevision: number; value: PreferenceValue };
type DB = Env['DB'];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_ID = /^[a-zA-Z0-9-]{1,80}$/;
const PREFERENCE_TTL_MS = 90 * 86400000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RECEIPT_TTL_MS = 60 * 60 * 1000;

export class PreferenceError extends Error {
  constructor(public readonly status: 400 | 403 | 409 | 413 | 422 | 429 | 503, public readonly code: string) { super(code); }
}

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
}
const canonical = (value: unknown) => JSON.stringify(value);
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
async function digest(value: string): Promise<string> {
  const data = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(data)].map(byte => byte.toString(16).padStart(2,'0')).join('');
}
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
const kindOf = (value: unknown): value is PreferenceKind => typeof value === 'string' && (PREFERENCE_KINDS as readonly string[]).includes(value);

/** Structural validation only. Current courses, models, sample tracks and jobs
 * are rechecked by their ordinary application APIs before a preference is used. */
export function normalizePreference(kind: PreferenceKind, value: unknown): PreferenceValue {
  if (value === null) return null;
  if (kind === 'classChoice') {
    if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new PreferenceError(422,'preference_invalid');
    return value;
  }
  if (kind === 'modelChoice') {
    if (typeof value !== 'string' || value.length > 80 || !/^(?:auto|[a-zA-Z0-9][a-zA-Z0-9_-]*)$/.test(value)) throw new PreferenceError(422,'preference_invalid');
    return value;
  }
  if (kind === 'benchTab') {
    if (value !== 'splitter' && value !== 'remixer') throw new PreferenceError(422,'preference_invalid');
    return value;
  }
  if (kind === 'sampleRotation') {
    if (!plain(value) || !exact(value,['revision','seen','last','pass','order'])
      || !(typeof value.revision === 'string' && value.revision.length > 0 && value.revision.length <= 128
        || Number.isSafeInteger(value.revision) && (value.revision as number) >= 0)
      || !Array.isArray(value.seen) || value.seen.length > 64 || !value.seen.every(sampleKey)
      || new Set(value.seen).size !== value.seen.length
      || !(value.last === '' || value.last === null || sampleKey(value.last))
      || !Number.isSafeInteger(value.pass) || (value.pass as number) < 0
      || !Array.isArray(value.order) || value.order.length > 64 || !value.order.every(sampleKey)
      || new Set(value.order).size !== value.order.length) throw new PreferenceError(422,'preference_invalid');
    return {revision:value.revision as string|number,seen:[...value.seen] as string[],last:value.last as string|null,
      pass:value.pass as number,order:[...value.order] as string[]};
  }
  if (!plain(value) || !exact(value,['entries','suppressedJobIds']) || !Array.isArray(value.entries) || value.entries.length > 200
    || !Array.isArray(value.suppressedJobIds) || value.suppressedJobIds.length > 200) throw new PreferenceError(422,'preference_invalid');
  const entries: Array<{jobId:string;collapsed:boolean;rank:number}> = [];
  const ids = new Set<string>(), ranks = new Set<number>();
  for (const entry of value.entries) {
    if (!plain(entry) || !exact(entry,['jobId','collapsed','rank']) || typeof entry.jobId !== 'string' || !JOB_ID.test(entry.jobId)
      || typeof entry.collapsed !== 'boolean' || !Number.isSafeInteger(entry.rank) || (entry.rank as number) < 0 || (entry.rank as number) >= 200
      || ids.has(entry.jobId) || ranks.has(entry.rank as number)) throw new PreferenceError(422,'preference_invalid');
    ids.add(entry.jobId); ranks.add(entry.rank as number); entries.push({jobId:entry.jobId,collapsed:entry.collapsed,rank:entry.rank as number});
  }
  const suppressed = value.suppressedJobIds;
  if (!suppressed.every((id): id is string => typeof id === 'string' && JOB_ID.test(id)) || new Set(suppressed).size !== suppressed.length
    || suppressed.some(id => ids.has(id))) throw new PreferenceError(422,'preference_invalid');
  return {entries,suppressedJobIds:[...suppressed] as string[]};
}
function sampleKey(value: unknown): value is string {
  if(typeof value!=='string'||value.length>641||/[\u0000-\u001f\u007f]/.test(value))return false;
  const slash=value.indexOf('/');if(slash<1)return false;
  const archiveId=value.slice(0,slash),archiveFile=value.slice(slash+1);
  return archiveId.length<=128&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(archiveId)
    &&archiveFile.length>0&&archiveFile.length<=512&&archiveFile.toLowerCase().endsWith('.mp3');
}

export function validatePreferenceWrite(value: unknown): asserts value is PreferenceWrite {
  if (!plain(value) || !exact(value,['kind','requestId','baseRevision','value']) || !kindOf(value.kind)
    || typeof value.requestId !== 'string' || !UUID_V4.test(value.requestId)
    || !Number.isSafeInteger(value.baseRevision) || (value.baseRevision as number) < 0) throw new PreferenceError(400,'preference_write_invalid');
  normalizePreference(value.kind,value.value);
  if (bytes(canonical(value)) > MAX_BODY_BYTES) throw new PreferenceError(413,'preference_too_large');
}
export function validatePreferenceSeed(value: unknown): asserts value is PreferenceSeedInput {
  if (!plain(value) || !exact(value,['requestId','records']) || typeof value.requestId !== 'string' || !UUID_V4.test(value.requestId)
    || !Array.isArray(value.records) || value.records.length > PREFERENCE_KINDS.length) throw new PreferenceError(400,'preference_seed_invalid');
  const seen = new Set<string>();
  for (const record of value.records) {
    if (!plain(record) || !exact(record,['kind','value']) || !kindOf(record.kind) || seen.has(record.kind)) throw new PreferenceError(400,'preference_seed_invalid');
    normalizePreference(record.kind,record.value); seen.add(record.kind);
  }
  if (bytes(canonical(value)) > MAX_BODY_BYTES) throw new PreferenceError(413,'preference_too_large');
}

export type PreferenceScope = { now?: number; maximumExpiry?: number; guard?: { sql:string; values:unknown[] } };
async function cleanup(db: DB, subject: string, now: number) {
  await db.batch([
    db.prepare('DELETE FROM account_preference_receipts WHERE subject=? AND expires_at<=?').bind(subject,now),
    db.prepare('DELETE FROM account_preferences WHERE subject=? AND expires_at<=?').bind(subject,now),
    db.prepare('DELETE FROM account_preference_versions WHERE subject=? AND expires_at<=?').bind(subject,now),
  ]);
}
const guard = (scope: PreferenceScope,subject:string) => scope.guard ?? {sql:"EXISTS(SELECT 1 FROM app_users u WHERE u.subject=? AND u.disabled=0)",values:[subject]};

export async function readAccountPreferences(db: DB, subject: string, scope: PreferenceScope = {}) {
  const now = scope.now ?? Date.now(), where=guard(scope,subject); await cleanup(db,subject,now);
  const rows = (await db.prepare(`SELECT kind,payload_json AS payload,revision,expires_at AS expiresAt FROM account_preferences WHERE subject=? AND expires_at>? AND ${where.sql} ORDER BY kind`)
    .bind(subject,now,...where.values).all<{kind:PreferenceKind;payload:string;revision:number;expiresAt:number}>()).results;
  const preferences: Partial<Record<PreferenceKind,{value:PreferenceValue;revision:number}>> = {};
  for (const row of rows) {
    try { preferences[row.kind] = {value:normalizePreference(row.kind,JSON.parse(row.payload)),revision:row.revision}; }
    catch { throw new PreferenceError(503,'preference_unavailable'); }
  }
  return {actor:subject,preferences};
}

async function apply(db: DB, subject: string, kind: PreferenceKind, requestId: string, value: unknown,
  mode:'cas'|'seed', baseRevision:number|null, scope:PreferenceScope = {}) {
  const now=scope.now??Date.now(), normalized=normalizePreference(kind,value), payload=canonical(normalized), valueDigest=await digest(`${kind}\n${payload}`);
  if(bytes(payload)>MAX_BODY_BYTES)throw new PreferenceError(413,'preference_too_large');
  const requestDigest=await digest(`${kind}\n${mode}\n${baseRevision??''}\n${payload}`), where=guard(scope,subject), expiresAt=Math.min(now+PREFERENCE_TTL_MS,scope.maximumExpiry??now+PREFERENCE_TTL_MS);
  await cleanup(db,subject,now);
  const existing=await db.prepare(`SELECT request_digest AS requestDigest,outcome,revision FROM account_preference_receipts
    WHERE subject=? AND kind=? AND request_id=? AND expires_at>? AND ${where.sql}`)
    .bind(subject,kind,requestId,now,...where.values).first<{requestDigest:string;outcome:'applied'|'already-present'|'conflict';revision:number|null}>();
  if(existing){if(existing.requestDigest!==requestDigest)throw new PreferenceError(409,'preference_request_reused');return {kind,outcome:existing.outcome,revision:existing.revision};}
  const update = mode==='cas'
    ? db.prepare(`INSERT INTO account_preferences(subject,kind,revision,payload_json,digest,updated_at,expires_at,last_request_id,last_request_digest)
        SELECT ?,?,?, ?,?,?,?,?,? WHERE ((?=0 AND NOT EXISTS(SELECT 1 FROM account_preferences WHERE subject=? AND kind=?))
          OR EXISTS(SELECT 1 FROM account_preferences WHERE subject=? AND kind=? AND revision=?)) AND ${where.sql}
        ON CONFLICT(subject,kind) DO UPDATE SET revision=account_preferences.revision+1,payload_json=excluded.payload_json,digest=excluded.digest,
          updated_at=excluded.updated_at,expires_at=excluded.expires_at,last_request_id=excluded.last_request_id,last_request_digest=excluded.last_request_digest
        WHERE account_preferences.revision=? AND NOT EXISTS(SELECT 1 FROM account_preference_receipts WHERE subject=? AND kind=? AND request_id=?)`)
      .bind(subject,kind,(baseRevision as number)+1,payload,valueDigest,now,expiresAt,requestId,requestDigest,baseRevision,subject,kind,subject,kind,baseRevision,...where.values,baseRevision,subject,kind,requestId)
    : db.prepare(`INSERT OR IGNORE INTO account_preferences(subject,kind,revision,payload_json,digest,updated_at,expires_at,last_request_id,last_request_digest)
        SELECT ?,?,1,?,?,?,?,?,? WHERE ${where.sql}`)
      .bind(subject,kind,payload,valueDigest,now,expiresAt,requestId,requestDigest,...where.values);
  await db.batch([
    update,
    db.prepare(`INSERT OR IGNORE INTO account_preference_receipts(subject,kind,request_id,request_digest,outcome,revision,received_at,expires_at)
      SELECT ?,?,?,?,CASE WHEN changes()=1 THEN 'applied' WHEN ?='seed' AND EXISTS(SELECT 1 FROM account_preferences WHERE subject=? AND kind=? AND digest=?) THEN 'already-present' ELSE 'conflict' END,
      (SELECT revision FROM account_preferences WHERE subject=? AND kind=?),?,? WHERE ${where.sql}`)
      .bind(subject,kind,requestId,requestDigest,mode,subject,kind,valueDigest,subject,kind,now,Math.min(now+MAX_RECEIPT_TTL_MS,expiresAt),...where.values),
    db.prepare(`INSERT OR IGNORE INTO account_preference_versions(subject,kind,reason,payload_json,digest,request_id,received_at,expires_at)
      SELECT ?,?,'conflict',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM account_preference_receipts r JOIN account_preferences p ON p.subject=r.subject AND p.kind=r.kind
        WHERE r.subject=? AND r.kind=? AND r.request_id=? AND r.request_digest=? AND r.outcome='conflict' AND p.digest<>?) AND ${where.sql}`)
      .bind(subject,kind,payload,valueDigest,requestId,now,expiresAt,subject,kind,requestId,requestDigest,valueDigest,...where.values),
  ]);
  const receipt=await db.prepare(`SELECT request_digest AS requestDigest,outcome,revision FROM account_preference_receipts
    WHERE subject=? AND kind=? AND request_id=? AND ${where.sql}`).bind(subject,kind,requestId,...where.values)
    .first<{requestDigest:string;outcome:'applied'|'already-present'|'conflict';revision:number|null}>();
  if(!receipt)throw new PreferenceError(403,'preference_scope_unavailable');
  if(receipt.requestDigest!==requestDigest)throw new PreferenceError(409,'preference_request_reused');
  return {kind,outcome:receipt.outcome,revision:receipt.revision};
}

export async function writeAccountPreference(db:DB,subject:string,input:PreferenceWrite,scope:PreferenceScope={}) {
  validatePreferenceWrite(input);
  return apply(db,subject,input.kind,input.requestId,input.value,'cas',input.baseRevision,scope);
}

export async function seedAccountPreferences(db:DB,subject:string,input:PreferenceSeedInput,scope:PreferenceScope={}) {
  validatePreferenceSeed(input);
  const accepted=[] as Array<{kind:PreferenceKind;outcome:string;revision:number|null}>;
  for(const record of input.records)accepted.push(await apply(db,subject,record.kind,input.requestId,record.value,'seed',null,scope));
  return {accepted,denied:[] as Array<{kind:PreferenceKind;code:string}>,deferred:[] as Array<{kind:PreferenceKind}>};
}

/** Append to a guest claim transaction. Exact account and live guest-session
 * proof are checked in each statement; member preferences always win. */
export function claimedPreferenceStatements(db:DB,guest:string,member:string,options:{now:number;expiresAt:number}) {
  const gate=`EXISTS(SELECT 1 FROM guest_sessions s JOIN guest_account_claims c ON c.guest_subject=s.subject
    JOIN app_users u ON u.subject=c.member_subject WHERE s.subject=? AND c.member_subject=? AND s.expires_at=?
    AND s.expires_at>? AND s.revoked_at IS NULL AND u.disabled=0)`;
  const gateArgs=[guest,member,options.expiresAt,options.now];
  return [
    db.prepare('DELETE FROM account_preference_receipts WHERE subject IN (?,?) AND expires_at<=?').bind(guest,member,options.now),
    db.prepare('DELETE FROM account_preferences WHERE subject IN (?,?) AND expires_at<=?').bind(guest,member,options.now),
    db.prepare('DELETE FROM account_preference_versions WHERE subject IN (?,?) AND expires_at<=?').bind(guest,member,options.now),
    db.prepare(`INSERT OR IGNORE INTO account_preferences(subject,kind,revision,payload_json,digest,updated_at,expires_at,last_request_id,last_request_digest)
      SELECT ?,g.kind,1,g.payload_json,g.digest,?,?, 'claim:'||?||':'||g.kind,g.digest
      FROM account_preferences g WHERE g.subject=? AND g.expires_at>? AND ${gate}`)
      .bind(member,options.now,options.now+PREFERENCE_TTL_MS,guest,guest,options.now,...gateArgs),
    db.prepare(`INSERT OR IGNORE INTO account_preference_versions(subject,kind,reason,payload_json,digest,request_id,received_at,expires_at)
      SELECT ?,g.kind,'claim-conflict',g.payload_json,g.digest,'claim:'||?||':'||g.kind||':'||g.digest,?,?
      FROM account_preferences g JOIN account_preferences m ON m.subject=? AND m.kind=g.kind
      WHERE g.subject=? AND g.expires_at>? AND m.digest<>g.digest
        AND NOT (m.last_request_id='claim:'||?||':'||g.kind AND m.last_request_digest=m.digest) AND ${gate}`)
      .bind(member,guest,options.now,options.now+PREFERENCE_TTL_MS,member,guest,options.now,guest,...gateArgs),
    // A late guest journal write can advance a claim-derived member slot only
    // while its provenance marker and digest still match. Any member CAS
    // changes the marker, so it wins and is never overwritten by this copy.
    db.prepare(`UPDATE account_preferences AS m SET revision=m.revision+1,payload_json=g.payload_json,digest=g.digest,
        updated_at=?,expires_at=?,last_request_id='claim:'||?||':'||g.kind,last_request_digest=g.digest
      FROM account_preferences g WHERE g.subject=? AND g.expires_at>? AND m.subject=? AND m.kind=g.kind
        AND g.digest<>m.digest AND m.last_request_id='claim:'||?||':'||g.kind AND m.last_request_digest=m.digest AND ${gate}`)
      .bind(options.now,options.now+PREFERENCE_TTL_MS,guest,guest,options.now,member,guest,...gateArgs),
    db.prepare(`INSERT OR IGNORE INTO account_preference_versions(subject,kind,reason,payload_json,digest,request_id,received_at,expires_at)
      SELECT ?,v.kind,'claim-conflict',v.payload_json,v.digest,'claim-version:'||?||':'||v.kind||':'||v.digest,?,?
      FROM account_preference_versions v WHERE v.subject=? AND v.expires_at>? AND ${gate}
      ORDER BY v.id DESC LIMIT 100`)
      .bind(member,guest,options.now,options.now+PREFERENCE_TTL_MS,guest,options.now,...gateArgs),
  ];
}

export function guestPreferenceScope(subject:string,expiresAt:number,now=Date.now()):PreferenceScope {
  if(!subject.startsWith('guest-') || !Number.isSafeInteger(expiresAt) || expiresAt<=now)throw new PreferenceError(403,'guest_session_invalid');
  return {now,maximumExpiry:Math.min(expiresAt,now+PREFERENCE_TTL_MS),guard:{sql:`EXISTS(SELECT 1 FROM guest_sessions s WHERE s.subject=? AND s.expires_at=? AND s.expires_at>? AND s.revoked_at IS NULL)`,values:[subject,expiresAt,now]}};
}

export function claimedGuestPreferenceScope(guest:string,member:string,expiresAt:number,now=Date.now()):PreferenceScope {
  if(!guest.startsWith('guest-')||!member.startsWith('cail-')||!Number.isSafeInteger(expiresAt)||expiresAt<=now)
    throw new PreferenceError(403,'guest_claim_invalid');
  return {now,maximumExpiry:Math.min(expiresAt,now+PREFERENCE_TTL_MS),guard:{sql:`EXISTS(SELECT 1 FROM guest_sessions s
      JOIN guest_account_claims c ON c.guest_subject=s.subject JOIN app_users u ON u.subject=c.member_subject
      WHERE s.subject=? AND c.member_subject=? AND s.expires_at=? AND s.expires_at>? AND s.revoked_at IS NULL AND u.disabled=0)`,
      values:[guest,member,expiresAt,now]}};
}
