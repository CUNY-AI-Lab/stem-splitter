// Synthetic local authority only. Never imported by the production entrypoint.
import { STEM_COURSE_ID, type CourseAssignment } from '../src/classroom/contract.ts';
export async function courseFixture(subject: string, classId=STEM_COURSE_ID, owner=false): Promise<CourseAssignment & {ok:true}> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`fixture:${classId}:${subject}`));
  return {ok:true,classId,className:'The American Musical Experience',term:'Fall 2026',section:'01',
    memberId:`stem-member-v1-${Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')}`,
    displayName:'Fixture Student',displayNameSource:'verified_profile',participant:!owner,owner,
    checkedAt:new Date().toISOString(),startsAt:new Date(Date.now()-86400000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),revision:1};
}
