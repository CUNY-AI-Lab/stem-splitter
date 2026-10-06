const el=id=>document.getElementById(id);
let courses=[],course=null,rosterCursor=null,jobsCursor=null,student=null,conversation=null,folder=null,generation=0;
const status=message=>{el('classroom-status').textContent=message;};
async function request(path,options={}){
  const response=await fetch(path,{...options,cache:'no-store',headers:{'Content-Type':'application/json',...(course?{'x-stem-course':course.classId}:{}),...options.headers}});
  window.StemSessionGuard?.observe(response);
  const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error?.message||result.error||'Please try again.'),{status:response.status});return result;
}
function chooseSplit(job){el('folder-job').value=job.id;el('folder-selected').textContent=job.filename;el('folder-add-button').disabled=false;}
const path=suffix=>`/api/classroom/courses/${encodeURIComponent(course.classId)}${suffix}`;
function item(list,text){const row=document.createElement('li');const span=document.createElement('span');span.textContent=text;row.append(span);list.append(row);return row;}
function button(row,label,action){const b=document.createElement('button');b.className='account-button';b.textContent=label;b.type='button';b.addEventListener('click',()=>run(b,action));row.append(b);return b;}
function link(row,label,href){const a=document.createElement('a');a.textContent=label;a.href=href;a.className='account-button';row.append(a);}
async function run(button,action){if(button.disabled)return;button.disabled=true;try{await action();}catch(error){status(error.message);if([401,403].includes(error.status)){el('classroom-content').hidden=true;courses=[];course=null;}}finally{button.disabled=button.id==='folder-add-button'&&!el('folder-job').value;}}
async function roster(more=false){
  const epoch=generation;const page=await request(path('/roster')+(more&&rosterCursor?`?cursor=${encodeURIComponent(rosterCursor)}`:''));if(epoch!==generation)return;
  if(!more)el('roster-list').replaceChildren();for(const member of page.participants){const row=item(el('roster-list'),`${member.displayName||'Student'} · ${member.splitCount} split${member.splitCount===1?'':'s'} · ${member.retainedCount} retained`);button(row,'View course work',()=>loadJobs(member));}
  if(!page.participants.length&&!more)item(el('roster-list'),'No currently enrolled students.');rosterCursor=page.nextCursor;el('roster-more').hidden=!rosterCursor;
}
async function loadJobs(member,more=false){
  const epoch=generation;const page=await request(path(`/participants/${encodeURIComponent(member.memberId)}/jobs`)+(more&&jobsCursor?`?cursor=${encodeURIComponent(jobsCursor)}`:''));if(epoch!==generation)return;
  student=member;el('classroom-student').textContent=`${member.displayName||'Student'} · course work`;el('classroom-jobs').hidden=false;if(!more)el('student-jobs').replaceChildren();
  for(const job of page.jobs){const row=item(el('student-jobs'),`${job.filename} · ${job.retained?job.status:'Expired'} · ${job.createdAt}`);if(job.retained){link(row,'Open split',`/?job=${encodeURIComponent(job.id)}`);button(row,'Read conversation',()=>loadConversation(job));}if(job.retained&&job.status==='done')button(row,'Use in folder',()=>{chooseSplit(job);el('course-folders').scrollIntoView({block:'nearest'});});}
  if(!page.jobs.length&&!more)item(el('student-jobs'),'No course splits yet.');jobsCursor=page.nextCursor;el('jobs-more').hidden=!jobsCursor;
}
async function loadConversation(job,more=false){
  const epoch=generation;const page=await request(path(`/jobs/${encodeURIComponent(job.id)}/conversation`)+(more&&conversation?.cursor?`?cursor=${encodeURIComponent(conversation.cursor)}&revision=${conversation.revision}`:''));if(epoch!==generation)return;
  if(!more)el('conversation-messages').replaceChildren();for(const message of page.entries)item(el('conversation-messages'),`${message.kind==='you'?'Student':message.kind==='coach'?'Listening Guy':message.kind==='status'?'System':'Mixer action'} · ${message.text} (${message.provenance})`);
  if(!page.entries.length&&!more)item(el('conversation-messages'),'No retained conversation. Only new server-saved course conversations appear here.');conversation={job,cursor:page.nextCursor,revision:page.revision};el('classroom-conversation').hidden=false;el('conversation-more').hidden=!page.nextCursor;
}
async function folders(){const epoch=generation;const page=await request(path('/folders'));if(epoch!==generation)return;el('course-folders').replaceChildren();for(const f of page.folders){const row=item(el('course-folders'),`${f.name} · ${f.permission==='private'?'Private':f.permission==='comment'?'Course comments':'Course listening'}`);button(row,'Open folder',()=>openFolder(f.id));}if(!page.folders.length)item(el('course-folders'),'No course folders yet.');}
async function openFolder(id){
  const epoch=generation;const page=await request(path(`/folders/${encodeURIComponent(id)}`));if(epoch!==generation)return;folder=page.folder;el('folder-detail').hidden=false;el('folder-title').textContent=folder.name;el('folder-permission').value=folder.permission;el('folder-controls').hidden=!course.owner;el('folder-add').hidden=!course.owner;el('folder-items').replaceChildren();
  for(const job of page.items){const row=item(el('folder-items'),`${job.filename}${job.available?'':' · Expired or unavailable'}`);if(job.available)link(row,'Open split',`/?job=${encodeURIComponent(job.jobId)}`);if(course.owner)button(row,'Remove from folder',async()=>{await request(path(`/folders/${folder.id}/items/${job.jobId}`),{method:'DELETE'});await openFolder(folder.id);});}
  if(!page.items.length)item(el('folder-items'),'This folder is empty.');
}
async function selectCourse(){
  generation++;course=courses.find(c=>c.classId===el('classroom-course').value);if(!course)return;
  for(const id of ['classroom-jobs','classroom-conversation','folder-detail'])el(id).hidden=true;student=null;conversation=null;folder=null;el('folder-job').value='';el('folder-selected').textContent='Choose a split from course work above.';el('folder-add-button').disabled=true;
  el('classroom-roster').hidden=!course.owner;el('folder-create').hidden=!course.owner;el('classroom-prompt').hidden=!course.owner;el('classroom-prompt').href=`/teacher.html?course=${encodeURIComponent(course.classId)}`;
  status('Loading…');await Promise.all([folders(),course.owner?roster():Promise.resolve()]);status('Course access checked.');
}
el('classroom-course').addEventListener('change',()=>run(el('classroom-refresh'),selectCourse));
el('classroom-refresh').addEventListener('click',()=>run(el('classroom-refresh'),selectCourse));
el('roster-more').addEventListener('click',()=>run(el('roster-more'),()=>roster(true)));
el('jobs-more').addEventListener('click',()=>run(el('jobs-more'),()=>loadJobs(student,true)));
el('conversation-more').addEventListener('click',()=>run(el('conversation-more'),()=>loadConversation(conversation.job,true)));
el('folder-create').addEventListener('submit',event=>{event.preventDefault();run(event.submitter,async()=>{const result=await request(path('/folders'),{method:'POST',body:JSON.stringify({name:el('folder-name').value})});el('folder-name').value='';await folders();await openFolder(result.folder.id);});});
el('folder-add').addEventListener('submit',event=>{event.preventDefault();run(event.submitter,async()=>{await request(path(`/folders/${folder.id}/items`),{method:'POST',body:JSON.stringify({jobId:el('folder-job').value.trim()})});el('folder-job').value='';el('folder-selected').textContent='Choose a split from course work above.';el('folder-add-button').disabled=true;await openFolder(folder.id);});});
el('folder-grant').addEventListener('click',()=>run(el('folder-grant'),async()=>{await request(path(`/folders/${folder.id}`),{method:'PUT',body:JSON.stringify({permission:el('folder-permission').value,revision:folder.revision})});el('folder-status').textContent='Sharing updated. Only current course members can open a course link.';await openFolder(folder.id);await folders();}));
el('folder-link').addEventListener('click',()=>run(el('folder-link'),async()=>{await navigator.clipboard.writeText(`${location.origin}/classroom.html?course=${encodeURIComponent(course.classId)}&folder=${encodeURIComponent(folder.id)}`);el('folder-status').textContent='Course link copied. Sign-in and current enrollment are required.';}));
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
(async()=>{try{const {account}=await request('/api/account');window.StemSessionGuard?.start(account.subject,()=>{generation++;courses=[];course=null;student=null;conversation=null;folder=null;});let cursor=null;do{const page=await request('/api/classroom/courses'+(cursor?`?cursor=${encodeURIComponent(cursor)}`:''));courses.push(...page.courses);cursor=page.nextCursor;}while(cursor);if(!courses.length){status('No current courses are available for Stem Splitter.');return;}for(const c of courses)el('classroom-course').add(new Option(`${c.className} · ${c.term} · ${c.section}`,c.classId));const query=new URLSearchParams(location.search);if(courses.some(c=>c.classId===query.get('course')))el('classroom-course').value=query.get('course');el('classroom-content').hidden=false;await selectCourse();if(query.get('folder'))await openFolder(query.get('folder'));if(query.get('job')){const job=await request(`/api/jobs/${encodeURIComponent(query.get('job'))}`);if(job.courseId===course.classId)chooseSplit(job);}}catch(error){status(error.message);if(error.status===401)link(el('classroom-status'),'CUNY Login','/auth/login?next='+encodeURIComponent(location.pathname+location.search));}})();
