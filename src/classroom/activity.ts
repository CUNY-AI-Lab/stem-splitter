import type { Env } from '../env.ts';
import { CourseError, resolveCourse } from './access.ts';
import { fingerprint } from '../reliability/ledger.ts';

export interface StudentUsage {
  runs: number;
  completed: number;
  guideTurns: number;
  recordedVisits: number;
  lastActiveAt: string | null;
}

/** Aggregate counters only. Personal recordings and conversations stay in their
 * existing access paths; a current roster supplies the identity boundary. */
export async function usageBySubject(env: Env, subjects: string[], now = Date.now()): Promise<Map<string, StudentUsage>> {
  const wanted = new Set(subjects);
  if (!wanted.size) return new Map();
  const [splits, guides, visits] = await Promise.all([
    env.DB.prepare(`SELECT subject,COUNT(*) AS runs,SUM(completed) AS completed,MAX(at) AS last_at FROM (
      SELECT o.subject,j.status='done' AS completed,CAST(strftime('%s',j.created_at) AS INTEGER)*1000 AS at
        FROM job_owners o JOIN jobs j ON j.id=o.job_id
        WHERE NOT EXISTS(SELECT 1 FROM app_operations op WHERE op.job_id=j.id AND op.kind='split')
      UNION ALL SELECT CASE WHEN op.quota_class='member' THEN op.subject ELSE c.member_subject END,op.state='succeeded',op.created_at
        FROM app_operations op LEFT JOIN guest_job_claims c ON c.job_id=op.job_id AND c.guest_subject=op.subject
        WHERE op.kind='split' AND (op.quota_class='member' OR c.member_subject IS NOT NULL)
    ) GROUP BY subject`).all<{subject:string;runs:number;completed:number;last_at:number|null}>(),
    env.DB.prepare(`SELECT CASE WHEN op.quota_class='member' THEN op.subject ELSE c.member_subject END AS subject,COUNT(*) AS turns,MAX(op.created_at) AS last_at
      FROM app_operations op LEFT JOIN guest_job_claims c ON c.job_id=op.job_id AND c.guest_subject=op.subject
      WHERE op.kind IN ('chat','guide') AND op.state='succeeded' AND (op.quota_class='member' OR c.member_subject IS NOT NULL) GROUP BY 1`)
      .all<{subject:string;turns:number;last_at:number|null}>(),
    env.DB.prepare(`SELECT actor_key,COUNT(*) AS visits,MAX(at) AS last_at FROM usage_events
      WHERE event_type='session_start' AND source='client' AND actor_class='member' AND at>=? GROUP BY actor_key`)
      .bind(now - 30 * 86400000).all<{actor_key:string;visits:number;last_at:number}>(),
  ]);
  const splitCounts = new Map(splits.results.filter(row => wanted.has(row.subject)).map(row => [row.subject,row]));
  const guideCounts = new Map(guides.results.filter(row => wanted.has(row.subject)).map(row => [row.subject,row]));
  const visitCounts = new Map(visits.results.map(row => [row.actor_key,row]));
  return new Map(await Promise.all(subjects.map(async subject => {
    const split = splitCounts.get(subject), guide = guideCounts.get(subject);
    let recordedVisits = 0, lastAt = Math.max(Number(split?.last_at) || 0, Number(guide?.last_at) || 0);
    for (let day=0;day<=30;day++) {
      const visit = visitCounts.get(await fingerprint(['usage-actor-v1',new Date(now-day*86400000).toISOString().slice(0,10),subject]));
      recordedVisits += visit?.visits ?? 0;
      lastAt = Math.max(lastAt, visit?.last_at ?? 0);
    }
    return [subject,{runs:split?.runs??0,completed:split?.completed??0,guideTurns:guide?.turns??0,recordedVisits,
      lastActiveAt:lastAt ? new Date(lastAt).toISOString() : null}] as const;
  })));
}

/** Admission roster identifiers deliberately omit the account subject. Resolve
 * known local accounts against the same current course before attaching totals. */
export async function rosterAppUsage(env: Env, courseId: string, memberIds: string[]) {
  const wanted = new Set(memberIds), byMember = new Map<string,string>();
  if (!wanted.size) return new Map<string,StudentUsage>();
  const users = (await env.DB.prepare('SELECT subject FROM app_users ORDER BY subject').all<{subject:string}>()).results;
  let next = 0;
  await Promise.all(Array.from({length:Math.min(6,users.length)},async () => {
    while (next < users.length) {
      const {subject} = users[next++];
      try {
        const course = await resolveCourse(env,subject,courseId);
        if (wanted.has(course.memberId)) byMember.set(course.memberId,subject);
      } catch (error) {
        if (!(error instanceof CourseError) || error.status === 503) throw error;
      }
    }
  }));
  const usage = await usageBySubject(env,[...byMember.values()]);
  return new Map([...byMember].map(([memberId,subject]) => [memberId,usage.get(subject)!]));
}
