import type { Env } from '../env.ts';
import type { CourseAssignmentV2 } from './contract.ts';

/** Identity matching only. Fresh Admission roster membership still governs every
 * aggregate read; this table grants no course or recording access. */
export async function rememberCourseUsageAccount(env: Env, subject: string, course: CourseAssignmentV2, now=Date.now()) {
  await env.DB.prepare(`INSERT INTO course_usage_accounts(course_id,subject,member_id,next_lookup_at) VALUES(?,?,?,?)
    ON CONFLICT(course_id,subject) DO UPDATE SET member_id=excluded.member_id,next_lookup_at=excluded.next_lookup_at
    WHERE member_id IS NOT excluded.member_id OR next_lookup_at<?`)
    .bind(course.classId,subject,course.memberId,now+86400000,now+43200000).run();
}
