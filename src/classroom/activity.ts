import type { Env } from '../env.ts';
import { CourseError, courseIds, resolveCourse } from './access.ts';
import { fingerprint } from '../reliability/ledger.ts';

export interface StudentUsage {
  runs: number;
  completed: number;
  guideTurns: number;
  recordedVisits: number;
  recordedPlays: number;
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
    env.DB.prepare(`SELECT actor_key,SUM(event_type='session_start') AS visits,SUM(event_type='playback_start') AS plays,MAX(at) AS last_at FROM usage_events
      WHERE event_type IN ('session_start','page_view','playback_start','playback_stop') AND source='client' AND actor_class='member' AND at>=? GROUP BY actor_key`)
      .bind(now - 30 * 86400000).all<{actor_key:string;visits:number;plays:number;last_at:number}>(),
  ]);
  const splitCounts = new Map(splits.results.filter(row => wanted.has(row.subject)).map(row => [row.subject,row]));
  const guideCounts = new Map(guides.results.filter(row => wanted.has(row.subject)).map(row => [row.subject,row]));
  const visitCounts = new Map(visits.results.map(row => [row.actor_key,row]));
  return new Map(await Promise.all(subjects.map(async subject => {
    const split = splitCounts.get(subject), guide = guideCounts.get(subject);
    let recordedVisits = 0, recordedPlays = 0, lastAt = Math.max(Number(split?.last_at) || 0, Number(guide?.last_at) || 0);
    for (let day=0;day<=30;day++) {
      const visit = visitCounts.get(await fingerprint(['usage-actor-v1',new Date(now-day*86400000).toISOString().slice(0,10),subject]));
      recordedVisits += visit?.visits ?? 0;
      recordedPlays += visit?.plays ?? 0;
      lastAt = Math.max(lastAt, visit?.last_at ?? 0);
    }
    return [subject,{runs:split?.runs??0,completed:split?.completed??0,guideTurns:guide?.turns??0,recordedVisits,recordedPlays,
      lastActiveAt:lastAt ? new Date(lastAt).toISOString() : null}] as const;
  })));
}

/** Join only this fresh roster page against previously verified identities.
 * Roster requests never resolve unrelated accounts through Admission. */
export async function rosterAppUsage(env: Env, courseId: string, memberIds: string[]) {
  if (!memberIds.length) return new Map<string,StudentUsage>();
  const rows=(await env.DB.prepare(`SELECT member_id,subject FROM course_usage_accounts
    WHERE course_id=? AND member_id IN (${memberIds.map(()=>'?').join(',')}) LIMIT 100`)
    .bind(courseId,...memberIds).all<{member_id:string;subject:string}>()).results;
  const byMember=new Map(rows.map(row=>[row.member_id,row.subject]));
  const usage = await usageBySubject(env,[...byMember.values()]);
  return new Map([...byMember].map(([memberId,subject]) => [memberId,usage.get(subject)!]));
}

/** Gradually match historical accounts outside the roster request. Six bounded
 * lookups per scheduled invocation keep growth and individual outages isolated. */
export async function refreshCourseUsageAccounts(env: Env, now=Date.now()) {
  if(env.CAIL_CLASSROOM_ENABLED==='false'||!env.ADMISSION_RESOLVER?.resolveCourseAccessV2)return;
  const classes=courseIds(env);
  const rows=(await env.DB.prepare(`WITH classes(course_id) AS (${classes.map(()=> 'SELECT ?').join(' UNION ALL ')})
    SELECT c.course_id,u.subject FROM app_users u CROSS JOIN classes c
    LEFT JOIN course_usage_accounts m ON m.course_id=c.course_id AND m.subject=u.subject
    WHERE m.next_lookup_at IS NULL OR m.next_lookup_at<=?
    ORDER BY COALESCE(m.next_lookup_at,0),u.created_at,u.subject,c.course_id LIMIT 6`)
    .bind(...classes,now).all<{course_id:string;subject:string}>()).results;
  await Promise.allSettled(rows.map(async row=>{
    try { await resolveCourse(env,row.subject,row.course_id); }
    catch(error) {
      const denied=error instanceof CourseError&&error.status===403;
      await env.DB.prepare(`INSERT INTO course_usage_accounts(course_id,subject,member_id,next_lookup_at) VALUES(?,?,NULL,?)
        ON CONFLICT(course_id,subject) DO UPDATE SET next_lookup_at=excluded.next_lookup_at,
          member_id=CASE WHEN ? THEN NULL ELSE member_id END`)
        .bind(row.course_id,row.subject,now+(denied?86400000:300000),denied?1:0).run();
    }
  }));
}
