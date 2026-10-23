import type { Env } from '../env.ts';
import type { AppPrincipal } from '../identity.ts';
import { OperationError, type Operation } from '../reliability/ledger.ts';
import { activeGuest } from './access.ts';

/** Called only after full member authorization, with adapter-verified cookie proof.
 * The request body and browser job list never supply ownership authority. */
export async function claimGuestWork(env: Env, principal: AppPrincipal) {
  if (principal.quotaClass !== 'member' || principal.courseId !== null) throw new OperationError('guest_claim_forbidden',403,'Sign in to your personal account to save guest splits.');
  const proof = env.guestClaimSession;
  if (!proof) return { claimedJobIds: [] as string[], guestStorageKey: null };
  const now = Date.now(), session = await activeGuest(env.DB, proof.subject, now);
  if (!session || session.expiresAt !== proof.expiresAt) throw new OperationError('guest_claim_expired',403,'The guest session has expired. Saved account splits have not changed.');
  const guest = session.subject, member = principal.subject;
  const gate = `EXISTS(SELECT 1 FROM guest_account_claims c JOIN guest_sessions s ON s.subject=c.guest_subject
    JOIN app_users u ON u.subject=c.member_subject WHERE c.guest_subject=? AND c.member_subject=?
    AND s.expires_at=? AND s.expires_at>? AND s.revoked_at IS NULL AND u.disabled=0)`;
  const args = [guest,member,session.expiresAt,now];
  const jobs = `SELECT job_id FROM guest_job_claims WHERE guest_subject=? AND member_subject=?`;
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO guest_account_claims(guest_subject,member_subject)
      SELECT s.subject,u.subject FROM guest_sessions s,app_users u WHERE s.subject=? AND u.subject=?
      AND s.expires_at=? AND s.expires_at>? AND s.revoked_at IS NULL AND u.disabled=0`).bind(...args),
    env.DB.prepare(`INSERT OR IGNORE INTO guest_job_claims(job_id,guest_subject,member_subject)
      SELECT g.job_id,g.subject,? FROM guest_job_owners g JOIN jobs j ON j.id=g.job_id
      WHERE g.subject=? AND j.created_at>datetime('now','-90 days') AND ${gate}
      AND NOT EXISTS(SELECT 1 FROM job_courses WHERE job_id=g.job_id)
      AND NOT EXISTS(SELECT 1 FROM job_owners WHERE job_id=g.job_id)`).bind(member,guest,...args),
    // Preserve both the guest original and any already-existing member transcript.
    env.DB.prepare(`INSERT OR IGNORE INTO listening_conversations(job_id,subject,entries,revision,created_at,updated_at,expires_at)
      SELECT job_id,?,entries,revision,created_at,updated_at,expires_at FROM guest_listening_conversations
      WHERE subject=? AND job_id IN (${jobs}) AND expires_at>datetime('now') AND ${gate}`).bind(member,guest,guest,member,...args),
    env.DB.prepare(`INSERT OR IGNORE INTO listening_reply_receipts(operation_id,job_id,subject,response_json,expires_at)
      SELECT r.operation_id,r.job_id,?,r.response_json,
        MIN(o.updated_at+86400000,CAST(strftime('%s',j.created_at,'+90 days') AS INTEGER)*1000)
      FROM guest_listening_reply_receipts r JOIN app_operations o ON o.id=r.operation_id JOIN jobs j ON j.id=r.job_id
      WHERE r.subject=? AND r.job_id IN (${jobs}) AND r.expires_at>? AND ${gate}`).bind(member,guest,guest,member,now,...args),
    // Move ephemeral receipts so a later claim cannot restore a reset conversation.
    env.DB.prepare(`DELETE FROM guest_listening_reply_receipts WHERE subject=? AND job_id IN (${jobs}) AND ${gate}`)
      .bind(guest,guest,member,...args),
    env.DB.prepare(`UPDATE annotations SET author_subject=? WHERE author_subject=? AND job_id IN (${jobs}) AND ${gate}`)
      .bind(member,guest,guest,member,...args),
    // D1 batch is atomic: originals remain if any subsequent ownership write fails.
    env.DB.prepare(`DELETE FROM guest_job_owners WHERE subject=? AND job_id IN (${jobs}) AND ${gate}`)
      .bind(guest,guest,member,...args),
    env.DB.prepare(`INSERT OR IGNORE INTO job_owners(job_id,subject)
      SELECT job_id,member_subject FROM guest_job_claims WHERE guest_subject=? AND member_subject=? AND ${gate}
      AND NOT EXISTS(SELECT 1 FROM guest_job_owners g WHERE g.job_id=guest_job_claims.job_id)`)
      .bind(guest,member,...args),
  ]);
  const owner = await env.DB.prepare('SELECT member_subject FROM guest_account_claims WHERE guest_subject=?').bind(guest).first<{member_subject:string}>();
  if (owner?.member_subject !== member) throw new OperationError('guest_claim_conflict',409,'This guest session could not be saved to this account.');
  const rows = await env.DB.prepare(`SELECT c.job_id FROM guest_job_claims c JOIN job_owners o ON o.job_id=c.job_id
    WHERE c.guest_subject=? AND c.member_subject=? AND o.subject=? ORDER BY c.job_id`).bind(guest,member,member).all<{job_id:string}>();
  return { claimedJobIds: rows.results.map(row=>row.job_id), guestStorageKey: `jobs:${guest}` };
}

/** Access changes; the immutable original guest operation and its quota do not. */
export async function ownsClaimedOperation(env: Env, principal: AppPrincipal, operation: Operation) {
  if (principal.quotaClass !== 'member' || operation.quota_class !== 'guest' || operation.course_id !== null) return false;
  return Boolean(await env.DB.prepare(`SELECT 1 FROM guest_job_claims c JOIN job_owners o ON o.job_id=c.job_id
    WHERE c.job_id=? AND c.guest_subject=? AND c.member_subject=? AND o.subject=?`)
    .bind(operation.job_id,operation.subject,principal.subject,principal.subject).first());
}

/** Pending claimed work follows its current member owner, not the retired guest cookie. */
export async function claimedOperationOwner(env: Env, operation: Operation): Promise<string | null> {
  if (operation.quota_class !== 'guest' || operation.course_id !== null) return null;
  const claim = await env.DB.prepare(`SELECT c.member_subject, j.member_subject AS journal_member, o.subject AS current_owner
    FROM guest_account_claims c LEFT JOIN guest_job_claims j ON j.guest_subject=c.guest_subject AND j.job_id=?
    LEFT JOIN job_owners o ON o.job_id=j.job_id WHERE c.guest_subject=?`)
    .bind(operation.job_id,operation.subject).first<{member_subject:string;journal_member:string|null;current_owner:string|null}>();
  if (!claim) return null;
  if (claim.journal_member !== claim.member_subject || claim.current_owner !== claim.member_subject)
    throw new OperationError('guest_claim_conflict',403,'Saved split ownership could not be confirmed.');
  return claim.member_subject;
}
