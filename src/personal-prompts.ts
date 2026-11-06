import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Env } from './env.ts';
import type { AppPrincipal } from './identity.ts';
import { readBoundedJsonRequest } from './http/bounded-request.ts';
import { buildSystemPromptPreview, hashSystemPromptFingerprint, SYSTEM_PROMPT_VERSION } from './assistant/prompt.ts';

export async function personalPrompt(env: Env, subject: string) {
  const row = await env.DB.prepare('SELECT amendment,revision,updated_at AS updatedAt FROM personal_prompt_settings WHERE subject=?')
    .bind(subject).first<{ amendment: string; revision: number; updatedAt: string }>();
  return row ?? { amendment: '', revision: 0, updatedAt: null };
}

export async function personalPromptView(env: Env, subject: string, before = Number.MAX_SAFE_INTEGER) {
  const state = await personalPrompt(env, subject);
  const { results } = await env.DB.prepare(`SELECT id,revision,revision AS settingsRevision,'You' AS updatedBy,amendment,change_note AS changeNote,
    base_version AS basePromptVersion,base_hash AS basePromptHash,effective_hash AS effectivePromptHash,created_at AS createdAt
    FROM personal_prompt_revisions WHERE subject=? AND id<? ORDER BY id DESC LIMIT 41`).bind(subject,before).all<{ id: number }>();
  return { ...state, scope: 'personal', updatedBy: state.revision ? 'You' : null,
    basePrompt: buildSystemPromptPreview(), basePromptVersion: SYSTEM_PROMPT_VERSION,
    effectivePromptHash: await hashSystemPromptFingerprint(state.amendment), basePromptHash: await hashSystemPromptFingerprint(),
    maxChars: 2000, maxChangeNoteChars: 240, history: results.slice(0,40), historyHasMore: results.length>40,
    historyNextBeforeId: results.length>40 ? results[39].id : null };
}

export async function savePersonalPrompt(env: Env, subject: string, body: Record<string, unknown>) {
  if (Object.keys(body).some(key=>!['amendment','expectedRevision','changeNote'].includes(key)) ||
      typeof body.amendment!=='string' || body.amendment.length>2000 || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision)<0)
    return { status: 400 as const, error: 'Enter instructions up to 2000 characters and a current revision.' };
  const amendment=body.amendment.trim(), current=await personalPrompt(env,subject);
  if(body.expectedRevision!==current.revision)return {status:409 as const,error:'These instructions changed. Reload the saved version before saving.'};
  if(amendment===current.amendment)return {status:200 as const,changed:false,...await personalPromptView(env,subject)};
  const note=typeof body.changeNote==='string'?body.changeNote.trim():'';
  if(!note||note.length>240)return {status:400 as const,error:'Describe this change in 1–240 characters.'};
  const token=crypto.randomUUID(),base=await hashSystemPromptFingerprint(),effective=await hashSystemPromptFingerprint(amendment);
  const result=await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO personal_prompt_settings(subject) VALUES(?)').bind(subject),
    env.DB.prepare('UPDATE personal_prompt_settings SET amendment=?,revision=revision+1,updated_at=? WHERE subject=? AND revision=?')
      .bind(amendment,token,subject,current.revision),
    env.DB.prepare(`INSERT INTO personal_prompt_revisions(subject,revision,amendment,change_note,base_version,base_hash,effective_hash,actor)
      SELECT subject,revision,amendment,?,?,?,?,subject FROM personal_prompt_settings WHERE subject=? AND updated_at=?`)
      .bind(note,SYSTEM_PROMPT_VERSION,base,effective,subject,token),
    env.DB.prepare('DELETE FROM personal_guides WHERE subject=? AND EXISTS(SELECT 1 FROM personal_prompt_settings WHERE subject=? AND updated_at=?)')
      .bind(subject,subject,token),
    env.DB.prepare("UPDATE personal_prompt_settings SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE subject=? AND updated_at=?")
      .bind(subject,token),
  ]);
  if(!result[1].meta.changes)return {status:409 as const,error:'These instructions changed. Reload the saved version before saving.'};
  return {status:200 as const,changed:true,guidesCleared:result[3].meta.changes??0,...await personalPromptView(env,subject)};
}

type State={Bindings:Env;Variables:{principal?:AppPrincipal}};
const routes=new Hono<State>();
const requirePersonal=createMiddleware<State>(async(c,next)=>{
  const p=c.get('principal');
  if(c.env.AUTH_MODE!=='cail'||!p||p.quotaClass==='guest'||!/^cail-[0-9a-f]{32}$/.test(p.subject))return c.json({error:'CUNY Login is required.'},403);
  c.header('Cache-Control','private, no-store');
  await next();
});
routes.use('/prompt',requirePersonal);
routes.use('/prompt/*',requirePersonal);
routes.get('/prompt',async c=>c.json(await personalPromptView(c.env,c.get('principal')!.subject)));
routes.get('/prompt/history',async c=>{
  const before=Number(c.req.query('before'));
  if(!Number.isSafeInteger(before)||before<1)return c.json({error:'Invalid history page.'},400);
  return c.json(await personalPromptView(c.env,c.get('principal')!.subject,before));
});
routes.get('/prompt/preview',async c=>c.json({prompt:buildSystemPromptPreview((await personalPrompt(c.env,c.get('principal')!.subject)).amendment)}));
routes.put('/prompt',async c=>{
  const p=c.get('principal')!;
  // An expectation, never authority: a draft from an old browser identity must
  // not be saved to the replacement account when both have the same revision.
  if(c.req.header('X-Stem-Prompt-Actor')!==p.subject)return c.json({error:'Your account changed. Reload before saving instructions.'},409);
  let body:unknown;
  try {body=await readBoundedJsonRequest(c.req.raw,16*1024);} catch {return c.json({error:'Invalid instructions request.'},400);}
  if(!body||typeof body!=='object'||Array.isArray(body))return c.json({error:'Invalid instructions request.'},400);
  const result=await savePersonalPrompt(c.env,p.subject,body as Record<string,unknown>);
  return c.json(result,result.status);
});
export default routes;
