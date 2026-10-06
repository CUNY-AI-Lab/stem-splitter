import type { Env } from '../env.ts';
import { buildSystemPromptPreview, hashSystemPromptFingerprint, SYSTEM_PROMPT_VERSION } from '../assistant/prompt.ts';

export async function coursePrompt(env: Env, courseId: string | null) {
  if (!courseId) return { amendment: '', revision: 0, updatedAt: null, updatedBy: null };
  const row = await env.DB.prepare('SELECT amendment,revision,updated_at AS updatedAt,updated_by AS updatedBy FROM course_settings WHERE course_id=?')
    .bind(courseId).first<{ amendment: string; revision: number; updatedAt: string; updatedBy: string }>();
  return row ?? { amendment: '', revision: 0, updatedAt: null, updatedBy: null };
}
export async function promptView(env: Env, courseId: string, before = Number.MAX_SAFE_INTEGER) {
  const state = await coursePrompt(env, courseId);
  const { results } = await env.DB.prepare(`SELECT id,revision,amendment,change_note AS changeNote,base_version AS basePromptVersion,
    base_hash AS basePromptHash,effective_hash AS effectivePromptHash,created_at AS createdAt
    FROM course_prompt_revisions WHERE course_id=? AND id<? ORDER BY id DESC LIMIT 41`).bind(courseId, before).all<{ id: number }>();
  return { ...state, basePrompt: buildSystemPromptPreview(), basePromptVersion: SYSTEM_PROMPT_VERSION,
    effectivePromptHash: await hashSystemPromptFingerprint(state.amendment), basePromptHash: await hashSystemPromptFingerprint(),
    maxChars: 2000, maxChangeNoteChars: 240, history: results.slice(0, 40), historyHasMore: results.length > 40,
    historyNextBeforeId: results.length > 40 ? results[39].id : null };
}
export async function saveCoursePrompt(env: Env, courseId: string, actor: string, body: Record<string, unknown>) {
  if (typeof body.amendment !== 'string' || body.amendment.length > 2000 || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision)<0) return { status: 400 as const, error: 'Enter instructions up to 2000 characters and a current revision.' };
  const amendment = body.amendment.trim();
  const current = await coursePrompt(env, courseId);
  if (body.expectedRevision !== current.revision) return { status: 409 as const, error: 'These instructions changed. Refresh before saving.' };
  if (amendment === current.amendment) return { status: 200 as const, changed: false, ...await promptView(env, courseId) };
  const note = typeof body.changeNote === 'string' ? body.changeNote.trim() : '';
  if (!note || note.length>240) return { status: 400 as const, error: 'Describe this change in 1–240 characters.' };
  const base = await hashSystemPromptFingerprint();
  const effective = await hashSystemPromptFingerprint(amendment);
  const token = crypto.randomUUID();
  // The writer token fences all statements in the atomic D1 batch, including first insert races.
  const statements = [
    env.DB.prepare('INSERT OR IGNORE INTO course_settings(course_id) VALUES(?)').bind(courseId),
    env.DB.prepare(`UPDATE course_settings SET amendment=?,revision=revision+1,updated_by=?,updated_at=? WHERE course_id=? AND revision=?`).bind(amendment, actor, token, courseId, current.revision),
    env.DB.prepare(`INSERT INTO course_prompt_revisions(course_id,revision,amendment,change_note,base_version,base_hash,effective_hash,actor)
      SELECT course_id,revision,amendment,?,?,?,?,? FROM course_settings WHERE course_id=? AND updated_at=?`).bind(note,SYSTEM_PROMPT_VERSION,base,effective,actor,courseId,token),
    env.DB.prepare(`DELETE FROM course_guides WHERE course_id=? AND EXISTS(SELECT 1 FROM course_settings WHERE course_id=? AND updated_at=?)`).bind(courseId,courseId,token),
    env.DB.prepare("UPDATE course_settings SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE course_id=? AND updated_at=?").bind(courseId,token),
  ];
  const result = await env.DB.batch(statements);
  if (!result[1].meta.changes) return { status: 409 as const, error: 'These instructions changed. Refresh before saving.' };
  return { status: 200 as const, changed: true, ...await promptView(env, courseId) };
}
