// Synthetic local authority only. Never imported by the production entrypoint.
import { DEMO_COURSE_ID, STEM_COURSE_ID, type CourseAssignmentV2 } from '../src/classroom/contract.ts';
export async function courseFixture(subject: string, classId=STEM_COURSE_ID, owner=false, guestInstructor=false): Promise<CourseAssignmentV2 & {ok:true}> {
  if(guestInstructor&&classId!==DEMO_COURSE_ID)throw new Error('Guest instructor fixtures are limited to the demo class.');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`fixture:${classId}:${subject}`));
  const checkedAt=new Date().toISOString();
  return {ok:true,classId,className:'The American Musical Experience',term:'Fall 2026',section:'01',
    memberId:`stem-member-v1-${Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')}`,
    displayName:'Fixture Student',displayNameSource:'verified_profile',participant:!owner&&!guestInstructor,owner,guestInstructor,
    capabilities:{instructorPanel:owner||guestInstructor,rosterRead:owner||guestInstructor,promptRead:owner||guestInstructor,promptWrite:owner||guestInstructor},
    checkedAt,startsAt:new Date(Date.now()-86400000).toISOString(),expiresAt:new Date(Date.parse(checkedAt)+(guestInstructor?300000:60000)).toISOString(),revision:1};
}
