import type { Env } from '../env.ts';
import type { AppPrincipal } from '../identity.ts';
import type { ChatResult } from '../assistant/index.ts';
import type { ChatTurn } from '../assistant/types.ts';
import { CourseError } from './access.ts';

type Turn = { input: string; state: string; reply: string | null; tools: string | null; finish_reason: string | null; revision: number };
/** Longer than the 60-second model deadline. Expiry never retries inference. */
export const COURSE_TURN_LEASE_SECONDS = 120;
export async function recoverExpiredCourseTurn(env: Env, jobId: string, subject: string): Promise<boolean> {
  const expired=await env.DB.prepare("SELECT 1 FROM course_conversations WHERE job_id=? AND subject=? AND pending_turn IS NOT NULL AND (pending_expires_at IS NULL OR pending_expires_at<=datetime('now')) AND expires_at>datetime('now')").bind(jobId,subject).first();
  if(!expired)return false;
  const token=`recover-${crypto.randomUUID()}`;
  const recovered=await env.DB.batch([
    env.DB.prepare(`UPDATE course_conversations SET revision=revision+1,pending_turn=?,pending_expires_at=datetime('now','+5 seconds')
      WHERE job_id=? AND subject=? AND pending_turn IS NOT NULL AND (pending_expires_at IS NULL OR pending_expires_at<=datetime('now'))
      AND expires_at>datetime('now') AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND created_at>datetime('now','-90 days'))`).bind(token,jobId,subject,jobId),
    env.DB.prepare(`INSERT INTO course_messages(id,job_id,subject,turn_id,kind,provenance,text)
      SELECT ?,c.job_id,c.subject,t.turn_id,'status','server-status',? FROM course_conversations c JOIN course_turns t ON t.job_id=c.job_id AND t.subject=c.subject
      WHERE c.job_id=? AND c.subject=? AND c.pending_turn=? AND t.state='pending'`).bind(crypto.randomUUID(),'The previous request ended before its completion could be verified. Earlier messages are preserved. It will not be retried automatically; send a new message to continue.',jobId,subject,token),
    env.DB.prepare(`UPDATE course_turns SET state='failed',reply=NULL,tools='[]',finish_reason='interrupted',revision=(SELECT revision FROM course_conversations WHERE job_id=? AND subject=?)
      WHERE job_id=? AND subject=? AND state='pending' AND EXISTS(SELECT 1 FROM course_conversations WHERE job_id=? AND subject=? AND pending_turn=?)`).bind(jobId,subject,jobId,subject,jobId,subject,token),
    env.DB.prepare('UPDATE course_conversations SET pending_turn=NULL,pending_expires_at=NULL WHERE job_id=? AND subject=? AND pending_turn=?').bind(jobId,subject,token),
  ]);
  return Boolean(recovered[0].meta.changes);
}
export async function conversationPage(env: Env, jobId: string, subject: string, after = 0, expectedRevision?: number) {
  await recoverExpiredCourseTurn(env,jobId,subject);
  const state = await env.DB.prepare(`SELECT revision,expires_at AS expiresAt,pending_turn AS pendingTurn FROM course_conversations
    WHERE job_id=? AND subject=? AND expires_at>datetime('now')`).bind(jobId,subject).first<{ revision: number; expiresAt: string; pendingTurn: string | null }>();
  if (expectedRevision !== undefined && expectedRevision !== (state?.revision ?? 0)) throw new CourseError(409,'conversation_changed');
  const { results } = await env.DB.prepare(`SELECT seq,id,kind,text,provenance,created_at AS createdAt FROM course_messages
    WHERE job_id=? AND subject=? AND seq>? AND EXISTS(SELECT 1 FROM course_conversations c JOIN jobs j ON j.id=c.job_id WHERE c.job_id=course_messages.job_id AND c.subject=course_messages.subject AND c.expires_at>datetime('now') AND j.created_at>datetime('now','-90 days')) ORDER BY seq LIMIT 41`).bind(jobId,subject,after).all<{ seq: number; kind: string; text: string }>();
  const entries = results.slice(0,40);
  return { mode: 'durable', entries, revision: state?.revision ?? 0, expiresAt: state?.expiresAt ?? null,
    pending: Boolean(state?.pendingTurn), nextCursor: results.length>40 ? String(entries.at(-1)!.seq) : null };
}
/** User input is accepted once; assistant/tool messages can only be produced by this server. */
export async function beginCourseTurn(env: Env, jobId: string, principal: AppPrincipal, input: unknown, turnId: unknown, revision: unknown) {
  if (typeof input !== 'string' || !input.trim() || input.length>2000 || typeof turnId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(turnId) || !Number.isSafeInteger(revision) || Number(revision)<0) throw new CourseError(400,'invalid_conversation_turn');
  const subject = principal.subject;
  await recoverExpiredCourseTurn(env,jobId,subject);
  const existing = await env.DB.prepare('SELECT input,state,reply,tools,finish_reason,revision FROM course_turns WHERE job_id=? AND subject=? AND turn_id=?').bind(jobId,subject,turnId).first<Turn>();
  if (existing) {
    if(existing.state==='failed')throw new CourseError(409,'conversation_interrupted');
    if (existing.input !== input || existing.state === 'pending') throw new CourseError(409,'conversation_changed');
    return { turnId, claimId: '', replay: existing, revision: existing.revision, turns: [] as ChatTurn[] };
  }
  const claimId = crypto.randomUUID();
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO course_conversations(job_id,subject,expires_at)
      SELECT j.id,?,datetime(j.created_at,'+90 days') FROM jobs j JOIN job_courses c ON c.job_id=j.id
      JOIN job_owners o ON o.job_id=j.id WHERE j.id=? AND o.subject=? AND j.created_at>datetime('now','-90 days')`).bind(subject,jobId,subject),
    env.DB.prepare(`UPDATE course_conversations SET revision=revision+1,pending_turn=?,pending_expires_at=datetime('now','+${COURSE_TURN_LEASE_SECONDS} seconds') WHERE job_id=? AND subject=? AND revision=? AND pending_turn IS NULL AND expires_at>datetime('now')`).bind(claimId,jobId,subject,revision),
    env.DB.prepare(`INSERT INTO course_turns(job_id,subject,turn_id,input,state,revision)
      SELECT job_id,subject,?,?, 'pending',revision FROM course_conversations WHERE job_id=? AND subject=? AND pending_turn=?`).bind(turnId,input,jobId,subject,claimId),
    env.DB.prepare(`INSERT INTO course_messages(id,job_id,subject,turn_id,kind,provenance,text)
      SELECT ?,job_id,subject,?,'you','student',? FROM course_conversations WHERE job_id=? AND subject=? AND pending_turn=?`).bind(crypto.randomUUID(),turnId,input,jobId,subject,claimId),
  ]);
  if (!result[1].meta.changes) throw new CourseError(409,'conversation_changed');
  const { results } = await env.DB.prepare(`SELECT kind,text FROM course_messages WHERE job_id=? AND subject=? AND kind IN ('you','coach') ORDER BY seq DESC LIMIT 12`).bind(jobId,subject).all<{ kind: string; text: string }>();
  const turns = results.reverse().map(row => ({ role: row.kind === 'you' ? 'user' as const : 'assistant' as const, content: row.text.slice(0,2000) }));
  return { turnId, claimId, replay: null, revision: Number(revision)+1, turns };
}
export async function finishCourseTurn(env: Env, jobId: string, subject: string, turnId: string, claimId: string, result: ChatResult, failed = false, displayName = 'Student', operationId?: string): Promise<number | null> {
  // PR3's reservation may expire before the longer conversation recovery lease.
  // Each effect checks it in the same transaction, so an old runner cannot
  // restore output or notes after allowance recovery has fenced the operation.
  const operationGuard=operationId?` AND EXISTS(SELECT 1 FROM app_operations o
    WHERE o.id=? AND o.subject=? AND o.job_id=? AND o.kind='chat' AND o.state='running' AND o.lease_until>?)`:'';
  const operationArgs=operationId?[operationId,subject,jobId,Date.now()]:[];
  const statements = [];
  for (const call of result.toolCalls) if (!failed && call.name === 'add_note') {
    statements.push(env.DB.prepare(`INSERT INTO annotations(id,job_id,at_seconds,text,author_subject,author_name,provenance)
      SELECT ?,job_id,?,?,subject,?,'server-assistant' FROM course_conversations WHERE job_id=? AND subject=? AND pending_turn=? AND pending_expires_at>datetime('now') AND expires_at>datetime('now')${operationGuard}`)
      .bind(crypto.randomUUID(),Number(call.args.seconds),String(call.args.text).slice(0,200),displayName,jobId,subject,claimId,...operationArgs));
  }

  if (result.reply) statements.push(env.DB.prepare(`INSERT INTO course_messages(id,job_id,subject,turn_id,kind,provenance,text)
    SELECT ?,job_id,subject,?,'coach','server-assistant',? FROM course_conversations WHERE job_id=? AND subject=? AND pending_turn=? AND pending_expires_at>datetime('now') AND expires_at>datetime('now')${operationGuard}`).bind(crypto.randomUUID(),turnId,result.reply,jobId,subject,claimId,...operationArgs));
  if (result.toolCalls.length) statements.push(env.DB.prepare(`INSERT INTO course_messages(id,job_id,subject,turn_id,kind,provenance,text)
    SELECT ?,job_id,subject,?,'action','server-tool',? FROM course_conversations WHERE job_id=? AND subject=? AND pending_turn=? AND pending_expires_at>datetime('now') AND expires_at>datetime('now')${operationGuard}`).bind(crypto.randomUUID(),turnId,JSON.stringify(result.toolCalls),jobId,subject,claimId,...operationArgs));
  statements.push(env.DB.prepare(`UPDATE course_turns SET state=?,reply=?,tools=?,finish_reason=?,revision=revision+1
    WHERE job_id=? AND subject=? AND turn_id=? AND state='pending' AND EXISTS(SELECT 1 FROM course_conversations WHERE job_id=? AND subject=? AND pending_turn=? AND pending_expires_at>datetime('now') AND expires_at>datetime('now'))${operationGuard}`)
    .bind(failed?'failed':'complete',result.reply,JSON.stringify(result.toolCalls),result.finishReason,jobId,subject,turnId,jobId,subject,claimId,...operationArgs));
  statements.push(env.DB.prepare(`UPDATE course_conversations SET revision=revision+1,pending_turn=NULL,pending_expires_at=NULL WHERE job_id=? AND subject=? AND pending_turn=? AND pending_expires_at>datetime('now') AND expires_at>datetime('now')${operationGuard} RETURNING revision`).bind(jobId,subject,claimId,...operationArgs));
  const saved = await env.DB.batch<{ revision: number }>(statements);
  if(!saved.at(-1)?.meta.changes)return null;
  const completed=await env.DB.prepare('SELECT revision FROM course_turns WHERE job_id=? AND subject=? AND turn_id=?').bind(jobId,subject,turnId).first<{revision:number}>();
  return completed?.revision??null;
}
export async function resetCourseConversation(env: Env, jobId: string, subject: string, revision: unknown) {
  if (!Number.isSafeInteger(revision) || Number(revision)<0) throw new CourseError(400,'invalid_revision');
  const token = `reset-${crypto.randomUUID()}`;
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE course_conversations SET revision=revision+1,pending_turn=? WHERE job_id=? AND subject=? AND revision=? AND expires_at>datetime('now') RETURNING revision`).bind(token,jobId,subject,revision),
    env.DB.prepare(`DELETE FROM course_messages WHERE job_id=? AND subject=? AND EXISTS(SELECT 1 FROM course_conversations WHERE job_id=? AND subject=? AND pending_turn=?)`).bind(jobId,subject,jobId,subject,token),
    env.DB.prepare(`DELETE FROM course_turns WHERE job_id=? AND subject=? AND EXISTS(SELECT 1 FROM course_conversations WHERE job_id=? AND subject=? AND pending_turn=?)`).bind(jobId,subject,jobId,subject,token),
    env.DB.prepare('UPDATE course_conversations SET pending_turn=NULL,pending_expires_at=NULL WHERE job_id=? AND subject=? AND pending_turn=?').bind(jobId,subject,token),
  ]);
  if (!result[0].meta.changes) {
    if (revision===0 && !(await env.DB.prepare('SELECT 1 FROM course_conversations WHERE job_id=? AND subject=?').bind(jobId,subject).first())) return { ok:true,revision:0 };
    throw new CourseError(409,'conversation_changed');
  }
  return { ok:true, revision:Number(revision)+1 };
}
