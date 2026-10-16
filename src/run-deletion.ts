import type { Env } from './env.ts';
import type { AppPrincipal } from './identity.ts';
import { ownershipTable } from './guest/access.ts';
import { cancelOperation } from './reliability/queue.ts';

export const runDeletionEnabled=(env:Env)=>env.AUTH_MODE==='cail'&&env.RUN_DELETION_ENABLED==='true';
export async function runWasDeleted(env:Env,id:string) {
 return runDeletionEnabled(env)&&Boolean(await env.DB.prepare('SELECT 1 FROM run_deletions WHERE job_id=?').bind(id).first());
}

/** Only the owner may delete. A tombstone is immediate; accepted work keeps its cancellation/accounting fence. */
export async function deleteOwnedRun(env:Env,principal:AppPrincipal,id:string) {
 if(!runDeletionEnabled(env))return false;
 const previous=await env.DB.prepare('SELECT subject FROM run_deletions WHERE job_id=?').bind(id).first<{subject:string}>();
 if(previous)return previous.subject===principal.subject;
 const owned=await env.DB.prepare(`SELECT j.id FROM jobs j JOIN ${ownershipTable(principal,'job')} o ON o.job_id=j.id WHERE j.id=? AND o.subject=?`).bind(id,principal.subject).first();
 if(!owned)return false;
 const operations=await env.DB.prepare("SELECT id,subject FROM app_operations WHERE job_id=? AND state NOT IN ('succeeded','partial','failed','cancelled')").bind(id).all<{id:string;subject:string}>();
 for(const op of operations.results)await cancelOperation(env.DB,op.id,op.subject);
 await env.DB.batch([
  env.DB.prepare(`INSERT INTO run_deletions(job_id,subject,deleted_at,reason) SELECT j.id,o.subject,?,'user' FROM jobs j JOIN ${ownershipTable(principal,'job')} o ON o.job_id=j.id WHERE j.id=? AND o.subject=? ON CONFLICT(job_id) DO NOTHING`).bind(Date.now(),id,principal.subject),
  env.DB.prepare('DELETE FROM public_split_links WHERE job_id=? AND EXISTS(SELECT 1 FROM run_deletions WHERE job_id=?)').bind(id,id),
  env.DB.prepare('DELETE FROM folder_items WHERE job_id=? AND EXISTS(SELECT 1 FROM run_deletions WHERE job_id=?)').bind(id,id),
  env.DB.prepare('DELETE FROM course_folder_items WHERE job_id=? AND EXISTS(SELECT 1 FROM run_deletions WHERE job_id=?)').bind(id,id),
 ]);
 return Boolean(await runWasDeleted(env,id));
}

/** Keep failures for the current tab/browser session; a new session removes them. Reloads keep the same ID. */
export async function recordFailedRunSession(env:Env,principal:AppPrincipal,session:string|null,id:string|null=null) {
 if(!runDeletionEnabled(env)||!session||!/^[-a-zA-Z0-9_]{16,80}$/.test(session))return;
 await env.DB.batch([
  env.DB.prepare(`INSERT INTO failed_run_sessions(job_id,subject,session_id)
    SELECT j.id,o.subject,? FROM jobs j JOIN ${ownershipTable(principal,'job')} o ON o.job_id=j.id
    WHERE o.subject=? AND j.status='failed' AND (? IS NULL OR j.id=?) AND NOT EXISTS(SELECT 1 FROM run_deletions d WHERE d.job_id=j.id)
    ON CONFLICT(job_id,subject,session_id) DO NOTHING`)
    .bind(session,principal.subject,id,id),
  env.DB.prepare(`INSERT INTO run_deletions(job_id,subject,deleted_at,reason)
    SELECT f.job_id,f.subject,?,'failed_session_expiry' FROM failed_run_sessions f JOIN jobs j ON j.id=f.job_id
    JOIN ${ownershipTable(principal,'job')} o ON o.job_id=j.id AND o.subject=f.subject
    WHERE f.subject=? AND j.status='failed' GROUP BY f.job_id,f.subject HAVING COUNT(*)>1 ON CONFLICT(job_id) DO NOTHING`).bind(Date.now(),principal.subject),
 ]);
}

/** Purge audio and private run content after all accepted work is terminal. Never refund usage. */
export async function purgeDeletedRuns(env:Env) {
 if(!runDeletionEnabled(env))return;
 const {results}=await env.DB.prepare(`SELECT j.id,j.source_key,j.stems FROM run_deletions d JOIN jobs j ON j.id=d.job_id
   WHERE d.content_purged=0 AND NOT EXISTS(SELECT 1 FROM app_operations o WHERE o.job_id=j.id AND o.state NOT IN ('succeeded','partial','failed','cancelled'))
   ORDER BY d.deleted_at LIMIT 8`).all<{id:string;source_key:string;stems:string|null}>();
 for(const job of results) {
  const keys:string[]=[];
  if(job.stems)try {const stems=JSON.parse(job.stems);if(Array.isArray(stems))for(const stem of stems)if(typeof stem.key==='string'&&stem.key.startsWith(`stems/${job.id}/`))keys.push(stem.key);}catch{}
  // Include partial outputs left by interrupted ingestion, without touching another run.
  let cursor:string|undefined;
  do {const page=await env.AUDIO.list({prefix:`stems/${job.id}/`,...(cursor?{cursor}:{})});keys.push(...page.objects.map(o=>o.key));cursor=page.truncated?page.cursor:undefined;}while(cursor);
  if(job.source_key.startsWith('uploads/')&&!await env.DB.prepare('SELECT 1 FROM jobs WHERE source_key=? AND id<>?').bind(job.source_key,job.id).first())keys.push(job.source_key);
  if(keys.length)await env.AUDIO.delete([...new Set(keys)]);
  await env.DB.batch([
   env.DB.prepare('DELETE FROM annotations WHERE job_id=?').bind(job.id),
   env.DB.prepare('DELETE FROM guides WHERE job_id=?').bind(job.id),
   env.DB.prepare('DELETE FROM folder_items WHERE job_id=?').bind(job.id),
   env.DB.prepare('DELETE FROM course_folder_items WHERE job_id=?').bind(job.id),
   env.DB.prepare("UPDATE app_operations SET request_json='{}',result_json=NULL WHERE job_id=? AND state IN ('succeeded','partial','failed','cancelled')").bind(job.id),
   env.DB.prepare('DELETE FROM jobs WHERE id=? AND NOT EXISTS(SELECT 1 FROM app_operations o WHERE o.job_id=? AND o.state NOT IN (\'succeeded\',\'partial\',\'failed\',\'cancelled\'))').bind(job.id,job.id),
   env.DB.prepare('UPDATE run_deletions SET content_purged=1 WHERE job_id=? AND NOT EXISTS(SELECT 1 FROM jobs WHERE id=?)').bind(job.id,job.id),
  ]);
 }
}
