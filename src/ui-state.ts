import type { Env } from './env.ts';

export type ActiveUiStateKind = 'listeningDraft' | 'listeningPlayer';
export type PendingUiStateKind = 'pendingConversation' | 'pendingChat' | 'pendingGuide';
export type UiStateKind = ActiveUiStateKind | PendingUiStateKind;
export type PlayerState = {
  position: number;
  rate: 0.5 | 0.75 | 1 | 1.25 | 1.5;
  muted: string[];
  solo: null | { stem: string; stage: 'behind' | 'only' };
  loop: null | { start: number; end: number };
  guideOpen: boolean;
};
export type UiStateValue = string | PlayerState | Record<string, unknown> | null;
export type UiStateWrite = { requestId: string; kind: UiStateKind; value: UiStateValue; baseRevision?: number };
export type UiStateRecord = { value: unknown; revision: number; digest: string; updatedAt: number; expiresAt: number };
export type UiStateVersion = { recordKind: UiStateKind; reason: 'conflict' | 'pending'; value: unknown; digest: string; requestId: string; receivedAt: number };
export type UiStateSnapshot = { jobId: string; actor: string; records: Record<ActiveUiStateKind, UiStateRecord | null>; versions: UiStateVersion[]; incomplete: boolean };
export type SeedInput = { requestId: string; records: Array<{ jobId: string; kind: UiStateKind; value: UiStateValue }> };
export type SeedItemResult = { jobId: string; kind: UiStateKind; outcome: 'applied' | 'already-present' | 'conflict' | 'inert'; revision: number | null };
export type SeedResults = { accepted: SeedItemResult[]; denied: string[]; deferred: string[] };

type DB = Env['DB'];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT = /^(?:cail-[0-9a-f]{32}|guest-[0-9a-f]{64})$/;
const JOB_ID = /^[a-zA-Z0-9-]{1,80}$/;
const RATES = [0.5, 0.75, 1, 1.25, 1.5] as const;
const MAX_SEED_RECORDS = 64;
const MAX_SEED_BYTES = 512 * 1024;
const MAX_PENDING_BYTES = 256 * 1024;
const MAX_ACTIVE_BYTES = 16 * 1024;
const MAX_SNAPSHOT_VERSION_BYTES = 512 * 1024;
const MAX_VERSION_ROWS = 100;
const UI_STATE_BYTES_PER_ACTOR = 2 * 1024 * 1024;
const RECEIPT_TTL_MS = 60 * 60 * 1000;

export class UiStateError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409 | 413 | 422 | 429 | 503, public readonly code: string) { super(code); }
}

export function validateSeedRequestShape(seed: unknown): asserts seed is SeedInput {
  if (!isPlainObject(seed) || !exactKeys(seed, ['requestId', 'records']) || typeof seed.requestId !== 'string'
    || !UUID_V4.test(seed.requestId) || !Array.isArray(seed.records) || seed.records.length > MAX_SEED_RECORDS) throw new UiStateError(400, 'ui_state_seed_invalid');
  if (byteLength(canonical(seed)) > MAX_SEED_BYTES) throw new UiStateError(413, 'ui_state_seed_too_large');
  const seen = new Set<string>();
  for (const record of seed.records) {
    if (!isPlainObject(record) || !exactKeys(record, ['jobId', 'kind', 'value']) || typeof record.jobId !== 'string' || !JOB_ID.test(record.jobId)
      || !['listeningDraft','listeningPlayer','pendingConversation','pendingChat','pendingGuide'].includes(String(record.kind))) throw new UiStateError(400, 'ui_state_seed_invalid');
    const key = `${record.jobId}:${record.kind}`;
    if (seen.has(key)) throw new UiStateError(400, 'ui_state_seed_duplicate');
    seen.add(key);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
}
function canonical(value: unknown): string { return JSON.stringify(value); }
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function normalizeValue(kind: UiStateKind, value: unknown, stems: Set<string>): unknown {
  if (kind === 'listeningDraft') {
    if (value === null) return null;
    if (typeof value !== 'string' || value.length > 2000) throw new UiStateError(422, 'ui_state_invalid');
    return value;
  }
  if (kind === 'listeningPlayer') {
    if (value === null) return null;
    if (!isPlainObject(value) || !exactKeys(value, ['position', 'rate', 'muted', 'solo', 'loop', 'guideOpen'])) throw new UiStateError(422, 'ui_state_invalid');
    const { position, rate, muted, solo, loop, guideOpen } = value;
    if (typeof position !== 'number' || !Number.isFinite(position) || position < 0 || position > 86400
      || !RATES.includes(rate as typeof RATES[number]) || !Array.isArray(muted) || muted.length > 24
      || !muted.every(name => typeof name === 'string' && stems.has(name)) || new Set(muted).size !== muted.length
      || typeof guideOpen !== 'boolean') throw new UiStateError(422, 'ui_state_invalid');
    let normalizedSolo: PlayerState['solo'] = null;
    if (solo !== null) {
      if (!isPlainObject(solo) || !exactKeys(solo, ['stem', 'stage']) || typeof solo.stem !== 'string' || !stems.has(solo.stem)
        || !['behind', 'only'].includes(String(solo.stage))) throw new UiStateError(422, 'ui_state_invalid');
      normalizedSolo = { stem: solo.stem, stage: solo.stage as 'behind' | 'only' };
    }
    let normalizedLoop: PlayerState['loop'] = null;
    if (loop !== null) {
      if (!isPlainObject(loop) || !exactKeys(loop, ['start', 'end']) || typeof loop.start !== 'number' || typeof loop.end !== 'number'
        || !Number.isFinite(loop.start) || !Number.isFinite(loop.end) || loop.start < 0 || loop.end <= loop.start || loop.end > 86400)
        throw new UiStateError(422, 'ui_state_invalid');
      normalizedLoop = { start: loop.start, end: loop.end };
    }
    return { position, rate: rate as PlayerState['rate'], muted: [...muted] as string[], solo: normalizedSolo, loop: normalizedLoop, guideOpen } satisfies PlayerState;
  }
  if (kind === 'pendingConversation') {
    if (!isPlainObject(value) || !exactKeys(value, ['revision', 'entries']) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
      || !Array.isArray(value.entries) || value.entries.length > 60) throw new UiStateError(422, 'ui_state_invalid');
    const entries = value.entries.map(entry => {
      if (!isPlainObject(entry) || !exactKeys(entry, ['kind', 'text']) || !['you', 'coach', 'action'].includes(String(entry.kind))
        || typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > 3000) throw new UiStateError(422, 'ui_state_invalid');
      return { kind: entry.kind as 'you' | 'coach' | 'action', text: entry.text };
    });
    return { revision: value.revision, entries };
  }
  if (kind === 'pendingChat') {
    if (!isPlainObject(value) || !['messageId', 'messages'].every(key => Object.hasOwn(value, key))
      || Object.keys(value).some(key => !['messageId', 'messages', 'durationSec', 'revision'].includes(key))
      || typeof value.messageId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(value.messageId)
      || !Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 12) throw new UiStateError(422, 'ui_state_invalid');
    const messages = value.messages.map(message => {
      if (!isPlainObject(message) || !exactKeys(message, ['role', 'content']) || !['user', 'assistant'].includes(String(message.role))
        || typeof message.content !== 'string' || !message.content.trim() || message.content.length > 2000) throw new UiStateError(422, 'ui_state_invalid');
      return { role: message.role as 'user' | 'assistant', content: message.content };
    });
    if (messages.at(-1)?.role !== 'user' || !(value.durationSec === undefined || value.durationSec === null || (typeof value.durationSec === 'number' && Number.isFinite(value.durationSec) && value.durationSec > 0 && value.durationSec <= 86400))
      || !(value.revision === undefined || value.revision === null || (Number.isSafeInteger(value.revision) && (value.revision as number) >= 0))) throw new UiStateError(422, 'ui_state_invalid');
    return { messageId: value.messageId, messages, ...(value.durationSec == null ? {} : { durationSec: value.durationSec }), ...(value.revision == null ? {} : { revision: value.revision }) };
  }
  if (kind === 'pendingGuide') {
    if (!isPlainObject(value) || !Object.hasOwn(value, 'messageId') || Object.keys(value).some(key => !['messageId', 'durationSec'].includes(key)) || typeof value.messageId !== 'string'
      || !/^[a-zA-Z0-9_-]{16,80}$/.test(value.messageId)
      || !(value.durationSec === undefined || value.durationSec === null || (typeof value.durationSec === 'number' && Number.isFinite(value.durationSec) && value.durationSec > 0 && value.durationSec <= 86400)))
      throw new UiStateError(422, 'ui_state_invalid');
    return { messageId: value.messageId, ...(value.durationSec == null ? {} : { durationSec: value.durationSec }) };
  }
  throw new UiStateError(422, 'ui_state_invalid');
}

async function jobExpiry(db: DB, jobId: string, now: number, maximumExpiry?: number): Promise<number> {
  const row = await db.prepare(`SELECT CAST(strftime('%s',created_at,'+90 days') AS INTEGER)*1000 AS expiresAt
    FROM jobs WHERE id=? AND created_at>datetime('now','-90 days')`).bind(jobId).first<{ expiresAt: number }>();
  if (!row || !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= now) throw new UiStateError(404, 'job_not_found');
  return Math.min(row.expiresAt, maximumExpiry ?? row.expiresAt);
}

async function liveStems(db: DB, jobId: string): Promise<Set<string>> {
  const row = await db.prepare('SELECT stems FROM jobs WHERE id=?').bind(jobId).first<{ stems: string | null }>();
  if (!row) throw new UiStateError(404, 'job_not_found');
  let values: unknown;
  try { values = JSON.parse(row.stems || '[]'); } catch { throw new UiStateError(503, 'job_state_unavailable'); }
  if (!Array.isArray(values) || !values.every(stem => isPlainObject(stem) && typeof stem.name === 'string')) throw new UiStateError(503, 'job_state_unavailable');
  return new Set(values.map(stem => (stem as { name: string }).name));
}

export async function readJobUiState(db: DB, subject: string, jobId: string, now = Date.now()): Promise<UiStateSnapshot> {
  if (!SUBJECT.test(subject) || !JOB_ID.test(jobId)) throw new UiStateError(404, 'job_not_found');
  await cleanupExpiredForActor(db, subject, now);
  await jobExpiry(db, jobId, now);
  const rows = (await db.prepare(`SELECT kind,payload_json AS payload,revision,digest,updated_at AS updatedAt,expires_at AS expiresAt
    FROM job_ui_state_records WHERE subject=? AND job_id=? AND expires_at>?`).bind(subject, jobId, now).all<any>()).results;
  const records: UiStateSnapshot['records'] = { listeningDraft: null, listeningPlayer: null };
  for (const row of rows) {
    try { records[row.kind as ActiveUiStateKind] = { value: JSON.parse(row.payload), revision: row.revision, digest: row.digest, updatedAt: row.updatedAt, expiresAt: row.expiresAt }; }
    catch { throw new UiStateError(503, 'job_state_unavailable'); }
  }
  const versions = (await db.prepare(`SELECT kind AS recordKind,reason,payload_json AS payload,digest,request_id AS requestId,received_at AS receivedAt
    FROM job_ui_state_versions WHERE subject=? AND job_id=? AND expires_at>? ORDER BY id DESC LIMIT ?`).bind(subject, jobId, now, MAX_VERSION_ROWS + 1).all<any>()).results;
  const out: UiStateVersion[] = [];
  let used = 0;
  for (const version of versions.slice(0, MAX_VERSION_ROWS)) {
    used += byteLength(version.payload);
    if (used > MAX_SNAPSHOT_VERSION_BYTES) break;
    try { out.push({ recordKind: version.recordKind, reason: version.reason, value: JSON.parse(version.payload), digest: version.digest, requestId: version.requestId, receivedAt: version.receivedAt }); }
    catch { throw new UiStateError(503, 'job_state_unavailable'); }
  }
  return { jobId, actor: subject, records, versions: out, incomplete: versions.length > out.length };
}

type ApplyOptions = { now?: number; maximumExpiry?: number; mode: 'cas' | 'seed'; guard?: { sql: string; values: unknown[] } };
async function cleanupExpiredForActor(db: DB, subject: string, now: number) {
  await db.batch([
    db.prepare('DELETE FROM job_ui_state_receipts WHERE subject=? AND expires_at<=?').bind(subject, now),
    db.prepare('DELETE FROM job_ui_state_records WHERE subject=? AND expires_at<=?').bind(subject, now),
    db.prepare('DELETE FROM job_ui_state_versions WHERE subject=? AND expires_at<=?').bind(subject, now),
  ]);
}

async function applyRecord(db: DB, subject: string, jobId: string, input: UiStateWrite, options: ApplyOptions): Promise<SeedItemResult> {
  if (!SUBJECT.test(subject) || !JOB_ID.test(jobId) || !UUID_V4.test(input.requestId)) throw new UiStateError(400, 'ui_state_invalid');
  if (!['listeningDraft','listeningPlayer','pendingConversation','pendingChat','pendingGuide'].includes(input.kind)) throw new UiStateError(400, 'ui_state_invalid');
  if (options.mode === 'cas' && (!['listeningDraft','listeningPlayer'].includes(input.kind) || !Number.isSafeInteger(input.baseRevision) || (input.baseRevision as number) < 0)) throw new UiStateError(400, 'ui_state_invalid');
  const now = options.now ?? Date.now();
  await cleanupExpiredForActor(db, subject, now);
  const expiresAt = await jobExpiry(db, jobId, now, options.maximumExpiry);
  const stems = input.kind === 'listeningPlayer' ? await liveStems(db, jobId) : new Set<string>();
  const normalized = normalizeValue(input.kind, input.value, stems);
  const payload = canonical(normalized);
  const payloadBytes = byteLength(payload);
  if (input.kind.startsWith('pending') ? payloadBytes > MAX_PENDING_BYTES : payloadBytes > MAX_ACTIVE_BYTES) throw new UiStateError(413, 'ui_state_record_too_large');
  const requestDigest = await digest(`${input.kind}\n${options.mode}\n${input.baseRevision ?? ''}\n${payload}`);
  const valueDigest = await digest(`${input.kind}\n${payload}`);
  const guardSql = options.guard?.sql ?? "EXISTS(SELECT 1 FROM jobs j WHERE j.id=? AND j.created_at>datetime('now','-90 days'))";
  const guardValues = options.guard?.values ?? [jobId];
  const existing = await db.prepare(`SELECT request_digest AS requestDigest,outcome,revision FROM job_ui_state_receipts
    WHERE subject=? AND job_id=? AND kind=? AND request_id=? AND expires_at>? AND ${guardSql}`)
    .bind(subject, jobId, input.kind, input.requestId, now, ...guardValues).first<any>();
  if (existing) {
    if (existing.requestDigest !== requestDigest) throw new UiStateError(409, 'ui_state_request_reused');
    return { jobId, kind: input.kind, outcome: existing.outcome, revision: existing.revision };
  }
  const receiptExpiry = Math.min(expiresAt, now + RECEIPT_TTL_MS);
  if (input.kind.startsWith('pending')) {
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO job_ui_state_receipts(subject,job_id,kind,request_id,request_digest,outcome,revision,received_at,expires_at)
        SELECT ?,?,?,?,?, 'inert',NULL,?,? WHERE ${guardSql}`).bind(subject,jobId,input.kind,input.requestId,requestDigest,now,receiptExpiry,...guardValues),
      db.prepare(`INSERT OR IGNORE INTO job_ui_state_versions(subject,job_id,kind,reason,payload_json,digest,request_id,received_at,expires_at)
        SELECT ?,?,?, 'pending',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM job_ui_state_receipts WHERE subject=? AND job_id=? AND kind=? AND request_id=? AND request_digest=? AND outcome='inert') AND ${guardSql}`)
        .bind(subject,jobId,input.kind,payload,await digest(`${input.kind}\n${payload}`),input.requestId,now,expiresAt,subject,jobId,input.kind,input.requestId,requestDigest,...guardValues),
    ]);
  } else {
    const current = options.mode === 'cas' ? db.prepare(`INSERT INTO job_ui_state_records(subject,job_id,kind,revision,payload_json,digest,updated_at,expires_at,last_request_id,last_request_digest)
        SELECT ?,?,?,?,?,?,?,?,?,? WHERE ((?=0 AND NOT EXISTS(SELECT 1 FROM job_ui_state_records WHERE subject=? AND job_id=? AND kind=?))
          OR EXISTS(SELECT 1 FROM job_ui_state_records WHERE subject=? AND job_id=? AND kind=? AND revision=?)) AND ${guardSql}
        ON CONFLICT(subject,job_id,kind) DO UPDATE SET revision=job_ui_state_records.revision+1,payload_json=excluded.payload_json,digest=excluded.digest,
          updated_at=excluded.updated_at,expires_at=MIN(job_ui_state_records.expires_at,excluded.expires_at),last_request_id=excluded.last_request_id,last_request_digest=excluded.last_request_digest
        WHERE job_ui_state_records.revision=? AND NOT EXISTS(SELECT 1 FROM job_ui_state_receipts WHERE subject=? AND job_id=? AND kind=? AND request_id=?)`)
        .bind(subject,jobId,input.kind,(input.baseRevision as number)+1,payload,valueDigest,now,expiresAt,input.requestId,requestDigest,
          input.baseRevision,subject,jobId,input.kind,subject,jobId,input.kind,input.baseRevision,...guardValues,input.baseRevision,subject,jobId,input.kind,input.requestId)
      : db.prepare(`INSERT OR IGNORE INTO job_ui_state_records(subject,job_id,kind,revision,payload_json,digest,updated_at,expires_at,last_request_id,last_request_digest)
        SELECT ?,?,?,1,?,?,?,?,?,? WHERE ${guardSql}`).bind(subject,jobId,input.kind,payload,valueDigest,now,expiresAt,input.requestId,requestDigest,...guardValues);
    await db.batch([
      current,
      db.prepare(`INSERT OR IGNORE INTO job_ui_state_receipts(subject,job_id,kind,request_id,request_digest,outcome,revision,received_at,expires_at)
        SELECT ?,?,?,?,?,CASE WHEN changes()=1 THEN ? WHEN ?='seed' AND EXISTS(SELECT 1 FROM job_ui_state_records WHERE subject=? AND job_id=? AND kind=? AND digest=?) THEN ? ELSE ? END,
          (SELECT revision FROM job_ui_state_records WHERE subject=? AND job_id=? AND kind=?),?,?
        WHERE ${guardSql}`).bind(subject,jobId,input.kind,input.requestId,requestDigest,
          'applied',options.mode,subject,jobId,input.kind,valueDigest,'already-present','conflict',
          subject,jobId,input.kind,now,receiptExpiry,...guardValues),
      db.prepare(`INSERT OR IGNORE INTO job_ui_state_versions(subject,job_id,kind,reason,payload_json,digest,request_id,received_at,expires_at)
        SELECT ?,?,?, 'conflict',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM job_ui_state_receipts r JOIN job_ui_state_records s ON s.subject=r.subject AND s.job_id=r.job_id AND s.kind=r.kind
          WHERE r.subject=? AND r.job_id=? AND r.kind=? AND r.request_id=? AND r.request_digest=? AND r.outcome='conflict' AND s.digest<>?) AND ${guardSql}`)
        .bind(subject,jobId,input.kind,payload,valueDigest,input.requestId,now,expiresAt,subject,jobId,input.kind,input.requestId,requestDigest,valueDigest,...guardValues),
    ]);
  }
  const receipt = await db.prepare(`SELECT request_digest AS requestDigest,outcome,revision FROM job_ui_state_receipts
    WHERE subject=? AND job_id=? AND kind=? AND request_id=? AND ${guardSql}`)
    .bind(subject,jobId,input.kind,input.requestId,...guardValues).first<any>();
  if (!receipt) throw new UiStateError(404, 'job_not_found');
  if (receipt.requestDigest !== requestDigest) throw new UiStateError(409, 'ui_state_request_reused');
  return { jobId, kind: input.kind, outcome: receipt.outcome, revision: receipt.revision };
}

export async function writeJobUiState(db: DB, subject: string, jobId: string, input: UiStateWrite, now = Date.now()) {
  return applyRecord(db, subject, jobId, input, { mode: 'cas', now });
}

export async function seedJobUiState(db: DB, subject: string, seed: SeedInput, now = Date.now()): Promise<SeedResults> {
  if (!SUBJECT.test(subject)) throw new UiStateError(400, 'ui_state_seed_invalid');
  validateSeedRequestShape(seed);
  const results: SeedResults = { accepted: [], denied: [], deferred: [] };
  for (const record of seed.records) {
    try { results.accepted.push(await applyRecord(db, subject, record.jobId, { requestId: seed.requestId, kind: record.kind, value: record.value }, { mode: 'seed', now })); }
    catch (error) {
      if (error instanceof UiStateError && [404, 403].includes(error.status)) results.denied.push(record.jobId);
      // A legacy value can be semantically invalid for the current job (for
      // example, a player preference naming a stem that was removed). Reject
      // only that item so valid records later in the same bounded seed still
      // reach their destination. Structural batch errors remain fatal above.
      else if (error instanceof UiStateError && error.status === 422) results.denied.push(record.jobId);
      else if (error instanceof UiStateError && [400, 409, 413].includes(error.status)) throw error;
      else results.deferred.push(record.jobId);
    }
  }
  return results;
}

export async function seedGuestJobUiState(db: DB, guestSubject: string, record: { jobId: string; kind: UiStateKind; value: UiStateValue }, options: { requestId: string; guestExpiresAt: number; now: number }) {
  const guardSql = `EXISTS(SELECT 1 FROM jobs j WHERE j.id=? AND j.created_at>datetime('now','-90 days')
    AND NOT EXISTS(SELECT 1 FROM job_courses jc WHERE jc.job_id=j.id)
    AND EXISTS(SELECT 1 FROM guest_sessions gs WHERE gs.subject=? AND gs.expires_at=? AND gs.expires_at>? AND gs.revoked_at IS NULL)
    AND (EXISTS(SELECT 1 FROM guest_job_owners go WHERE go.job_id=j.id AND go.subject=?)
      OR EXISTS(SELECT 1 FROM guest_job_claims gc JOIN guest_account_claims gac ON gac.guest_subject=gc.guest_subject
        JOIN app_users u ON u.subject=gac.member_subject JOIN job_owners o ON o.job_id=gc.job_id
        WHERE gc.job_id=j.id AND gc.guest_subject=? AND gc.member_subject=gac.member_subject AND o.subject=gac.member_subject AND u.disabled=0)))`;
  const expiresAt = await jobExpiry(db, record.jobId, options.now, options.guestExpiresAt);
  const values = [record.jobId,guestSubject,options.guestExpiresAt,options.now,guestSubject,guestSubject];
  return applyRecord(db, guestSubject, record.jobId, { requestId: options.requestId, kind: record.kind, value: record.value },
    { mode: 'seed', now: options.now, maximumExpiry: expiresAt, guard: { sql: guardSql, values } });
}

/** Write the guest actor's private listening state with the ordinary revision
 * CAS semantics. Ownership and claim eligibility are repeated inside each
 * mutation statement so a claim/revocation between route authorization and
 * the write cannot redirect or broaden the write. */
export async function writeGuestJobUiState(
  db: DB,
  guestSubject: string,
  jobId: string,
  input: { requestId: string; kind: ActiveUiStateKind; baseRevision: number; value: UiStateValue },
  options: { guestExpiresAt: number; now: number },
) {
  if (!SUBJECT.test(guestSubject) || !guestSubject.startsWith('guest-')) throw new UiStateError(403, 'guest_session_invalid');
  const guardSql = `EXISTS(SELECT 1 FROM jobs j WHERE j.id=? AND j.created_at>datetime('now','-90 days')
    AND NOT EXISTS(SELECT 1 FROM job_courses jc WHERE jc.job_id=j.id)
    AND EXISTS(SELECT 1 FROM guest_sessions gs WHERE gs.subject=? AND gs.expires_at=? AND gs.expires_at>? AND gs.revoked_at IS NULL)
    AND (EXISTS(SELECT 1 FROM guest_job_owners go WHERE go.job_id=j.id AND go.subject=?)
      OR EXISTS(SELECT 1 FROM guest_job_claims gc JOIN guest_account_claims gac ON gac.guest_subject=gc.guest_subject
        JOIN app_users u ON u.subject=gac.member_subject JOIN job_owners o ON o.job_id=gc.job_id
        WHERE gc.job_id=j.id AND gc.guest_subject=? AND gc.member_subject=gac.member_subject AND o.subject=gac.member_subject AND u.disabled=0)))`;
  const expiresAt = await jobExpiry(db, jobId, options.now, options.guestExpiresAt);
  const values = [jobId,guestSubject,options.guestExpiresAt,options.now,guestSubject,guestSubject];
  return applyRecord(db, guestSubject, jobId, input, {
    mode: 'cas', now: options.now, maximumExpiry: expiresAt, guard: { sql: guardSql, values },
  });
}

/** SQL statements to append after the claim's ownership statements in the same
 * D1 batch. Values are copied only through exact claim rows and current owner. */
export function claimedUiStateStatements(db: DB, guestSubject: string, memberSubject: string, options: { now: number; expiresAt: number }) {
  const gate = `EXISTS(SELECT 1 FROM guest_sessions s JOIN guest_account_claims gac ON gac.guest_subject=s.subject
      JOIN guest_job_claims gc ON gc.guest_subject=s.subject AND gc.member_subject=gac.member_subject AND gc.job_id=j.id
      JOIN job_owners o ON o.job_id=j.id AND o.subject=gac.member_subject
      JOIN app_users u ON u.subject=gac.member_subject
    WHERE s.subject=? AND gac.member_subject=? AND s.expires_at=? AND s.expires_at>? AND s.revoked_at IS NULL AND u.disabled=0)`;
  const args = [guestSubject,memberSubject,options.expiresAt,options.now];
  return [
    db.prepare('DELETE FROM job_ui_state_receipts WHERE subject IN (?,?) AND expires_at<=?').bind(guestSubject,memberSubject,options.now),
    db.prepare('DELETE FROM job_ui_state_records WHERE subject IN (?,?) AND expires_at<=?').bind(guestSubject,memberSubject,options.now),
    db.prepare('DELETE FROM job_ui_state_versions WHERE subject IN (?,?) AND expires_at<=?').bind(guestSubject,memberSubject,options.now),
    db.prepare(`INSERT OR IGNORE INTO job_ui_state_records(subject,job_id,kind,revision,payload_json,digest,updated_at,expires_at,last_request_id,last_request_digest)
      SELECT ?,g.job_id,g.kind,1,g.payload_json,g.digest,?,CAST(strftime('%s',j.created_at,'+90 days') AS INTEGER)*1000,
        'claim:'||?||':'||g.job_id||':'||g.kind,g.digest
      FROM job_ui_state_records g JOIN jobs j ON j.id=g.job_id
      WHERE g.subject=? AND g.expires_at>? AND j.created_at>datetime('now','-90 days') AND ${gate}`)
      .bind(memberSubject,options.now,guestSubject,guestSubject,options.now,...args),
    db.prepare(`INSERT OR IGNORE INTO job_ui_state_versions(subject,job_id,kind,reason,payload_json,digest,request_id,received_at,expires_at)
      SELECT ?,g.job_id,g.kind,'conflict',g.payload_json,g.digest,'claim:'||?||':'||g.job_id||':'||g.kind||':'||g.digest,?,CAST(strftime('%s',j.created_at,'+90 days') AS INTEGER)*1000
      FROM job_ui_state_records g JOIN jobs j ON j.id=g.job_id JOIN job_ui_state_records m ON m.subject=? AND m.job_id=g.job_id AND m.kind=g.kind
      WHERE g.subject=? AND g.expires_at>? AND m.digest<>g.digest AND j.created_at>datetime('now','-90 days') AND ${gate}`)
      .bind(memberSubject,guestSubject,options.now,memberSubject,guestSubject,options.now,...args),
    ...(['conflict','pending'] as const).map(reason => db.prepare(`INSERT OR IGNORE INTO job_ui_state_versions(subject,job_id,kind,reason,payload_json,digest,request_id,received_at,expires_at)
      SELECT ?,g.job_id,g.kind,g.reason,g.payload_json,g.digest,'claim-version:'||?||':'||g.job_id||':'||g.kind||':'||g.request_id,?,CAST(strftime('%s',j.created_at,'+90 days') AS INTEGER)*1000
      FROM job_ui_state_versions g JOIN jobs j ON j.id=g.job_id
      WHERE g.subject=? AND g.reason=? AND g.expires_at>? AND j.created_at>datetime('now','-90 days') AND ${gate}`)
      .bind(memberSubject,guestSubject,options.now,guestSubject,reason,options.now,...args)),
  ];
}
