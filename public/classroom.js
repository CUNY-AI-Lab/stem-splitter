const el = id => document.getElementById(id);
let courses = [], course = null, ready = false, generation = 0;
let rosterCursor = null, jobsCursor = null, student = null, conversation = null, folder = null;
let jobsRequest = 0, conversationRequest = 0, folderRequest = 0;
const status = message => { el('classroom-status').textContent = message; };
const context = () => ({ courseId: course?.classId, generation });
const current = scope => scope && scope.generation === generation && scope.courseId === course?.classId && scope.courseId === el('classroom-course').value;
async function request(path, options = {}) {
  const response = await fetch(path, { ...options, cache: 'no-store', headers: { 'Content-Type': 'application/json', ...options.headers } });
  window.StemSessionGuard?.observe(response);
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error?.message || result.error || 'Please try again.'), { status: response.status });
  return result;
}
const courseRequest = (scope, suffix, options = {}) => request(`/api/classroom/courses/${encodeURIComponent(scope.courseId)}${suffix}`, { ...options, headers: { 'x-stem-course': scope.courseId, ...options.headers } });
function item(list, text) { const row = document.createElement('li'), span = document.createElement('span'); span.textContent = text; row.append(span); list.append(row); return row; }
function button(row, label, action, scope = context()) {
  const control = document.createElement('button'); control.className = 'account-button'; control.textContent = label; control.type = 'button';
  control.addEventListener('click', () => run(control, action, scope)); row.append(control); return control;
}
function link(row, label, href) { const a = document.createElement('a'); a.textContent = label; a.href = href; a.className = 'account-button'; row.append(a); }
async function run(control, action, scope = context()) {
  if (!control || control.disabled || !ready || !current(scope)) return;
  control.disabled = true;
  try { await action(scope); }
  catch (error) {
    if (!current(scope)) return;
    status(error.message);
    if ([401, 403].includes(error.status)) { generation++; clearCourseView(); ready = false; el('classroom-refresh').disabled = false; }
  } finally { if (current(scope)) control.disabled = !ready || (control.id === 'folder-add-button' && !el('folder-job').value); }
}
function chooseSplit(job, scope = context()) {
  if (!ready || !current(scope)) return;
  el('folder-job').value = job.id; el('folder-selected').textContent = job.filename; el('folder-add-button').disabled = false;
}
function clearCourseView() {
  jobsRequest++; conversationRequest++; folderRequest++;
  student = null; conversation = null; folder = null; rosterCursor = null; jobsCursor = null;
  for (const id of ['roster-list', 'student-jobs', 'conversation-messages', 'course-folders', 'folder-items']) el(id).replaceChildren();
  for (const id of ['classroom-roster', 'classroom-jobs', 'classroom-conversation', 'folder-detail', 'folder-create', 'classroom-prompt', 'roster-more', 'jobs-more', 'conversation-more']) el(id).hidden = true;
  el('course-folders').hidden = true; el('classroom-prompt').removeAttribute('href');
  el('classroom-student').textContent = ''; el('folder-title').textContent = ''; el('folder-status').textContent = '';
  el('folder-name').value = ''; el('folder-job').value = ''; el('folder-selected').textContent = 'Choose a split from course work above.'; el('folder-add-button').disabled = true;
}
async function roster(more = false, scope = context()) {
  if (!current(scope)) return;
  const page = await courseRequest(scope, '/roster' + (more && rosterCursor ? `?cursor=${encodeURIComponent(rosterCursor)}` : ''));
  if (!current(scope)) return;
  if (!more) el('roster-list').replaceChildren();
  for (const member of page.participants) {
    const row = item(el('roster-list'), `${member.displayName || 'Student'} · ${member.splitCount} split${member.splitCount === 1 ? '' : 's'} · ${member.retainedCount} retained`);
    button(row, 'View course work', scope => loadJobs(member, false, scope), scope);
  }
  if (!page.participants.length && !more) item(el('roster-list'), 'No currently enrolled students.');
  rosterCursor = page.nextCursor; el('roster-more').hidden = !rosterCursor;
}
async function loadJobs(member, more = false, scope = context()) {
  if (!current(scope) || !member) return;
  const sequence = ++jobsRequest;
  if (!more) { el('classroom-jobs').hidden = true; el('classroom-conversation').hidden = true; conversationRequest++; conversation = null; }
  const page = await courseRequest(scope, `/participants/${encodeURIComponent(member.memberId)}/jobs` + (more && jobsCursor ? `?cursor=${encodeURIComponent(jobsCursor)}` : ''));
  if (!current(scope) || sequence !== jobsRequest) return;
  student = member; el('classroom-student').textContent = `${member.displayName || 'Student'} · course work`; el('classroom-jobs').hidden = false;
  if (!more) el('student-jobs').replaceChildren();
  for (const job of page.jobs) {
    const row = item(el('student-jobs'), `${job.filename} · ${job.retained ? job.status : 'Expired'} · ${job.createdAt}`);
    if (job.retained) { link(row, 'Open split', `/?job=${encodeURIComponent(job.id)}`); button(row, 'Read conversation', scope => loadConversation(job, false, scope), scope); }
    if (job.retained && job.status === 'done') button(row, 'Use in folder', scope => { chooseSplit(job, scope); el('course-folders').scrollIntoView({ block: 'nearest' }); }, scope);
  }
  if (!page.jobs.length && !more) item(el('student-jobs'), 'No course splits yet.');
  jobsCursor = page.nextCursor; el('jobs-more').hidden = !jobsCursor;
}
async function loadConversation(job, more = false, scope = context()) {
  if (!current(scope) || !job) return;
  const sequence = ++conversationRequest, previous = conversation;
  if (!more) el('classroom-conversation').hidden = true;
  const page = await courseRequest(scope, `/jobs/${encodeURIComponent(job.id)}/conversation` + (more && previous?.cursor ? `?cursor=${encodeURIComponent(previous.cursor)}&revision=${previous.revision}` : ''));
  if (!current(scope) || sequence !== conversationRequest) return;
  if (!more) el('conversation-messages').replaceChildren();
  for (const message of page.entries) item(el('conversation-messages'), `${message.kind === 'you' ? 'Student' : message.kind === 'coach' ? 'Listening Guy' : message.kind === 'status' ? 'System' : 'Mixer action'} · ${message.text} (${message.provenance})`);
  if (!page.entries.length && !more) item(el('conversation-messages'), 'No retained conversation. Only new server-saved course conversations appear here.');
  conversation = { job, cursor: page.nextCursor, revision: page.revision }; el('classroom-conversation').hidden = false; el('conversation-more').hidden = !page.nextCursor;
}
async function folders(scope = context()) {
  if (!current(scope)) return;
  const page = await courseRequest(scope, '/folders'); if (!current(scope)) return;
  el('course-folders').replaceChildren();
  for (const entry of page.folders) {
    const row = item(el('course-folders'), `${entry.name} · ${entry.permission === 'private' ? 'Private' : entry.permission === 'comment' ? 'Course comments' : 'Course listening'}`);
    button(row, 'Open folder', scope => openFolder(entry.id, scope), scope);
  }
  if (!page.folders.length) item(el('course-folders'), 'No course folders yet.');
}
async function openFolder(id, scope = context()) {
  if (!current(scope)) return;
  const sequence = ++folderRequest; el('folder-detail').hidden = true; folder = null;
  const page = await courseRequest(scope, `/folders/${encodeURIComponent(id)}`);
  if (!current(scope) || sequence !== folderRequest) return;
  folder = page.folder; el('folder-detail').hidden = false; el('folder-title').textContent = folder.name; el('folder-permission').value = folder.permission;
  el('folder-controls').hidden = !course.owner; el('folder-add').hidden = !course.owner; el('folder-items').replaceChildren();
  for (const job of page.items) {
    const row = item(el('folder-items'), `${job.filename}${job.available ? '' : ' · Expired or unavailable'}`);
    if (job.available) link(row, 'Open split', `/?job=${encodeURIComponent(job.jobId)}`);
    if (course.owner) button(row, 'Remove from folder', async scope => {
      await courseRequest(scope, `/folders/${encodeURIComponent(id)}/items/${encodeURIComponent(job.jobId)}`, { method: 'DELETE' });
      if (current(scope) && folder?.id === id) await openFolder(id, scope);
    }, scope);
  }
  if (!page.items.length) item(el('folder-items'), 'This folder is empty.');
}
async function selectCourse() {
  generation++; ready = false; course = courses.find(entry => entry.classId === el('classroom-course').value); clearCourseView();
  if (!course) return null;
  const scope = context(); el('classroom-refresh').disabled = true; status('Loading…');
  try {
    await Promise.all([folders(scope), course.owner ? roster(false, scope) : Promise.resolve()]);
    if (!current(scope)) return null;
    ready = true; el('classroom-roster').hidden = !course.owner; el('folder-create').hidden = !course.owner; el('classroom-prompt').hidden = !course.owner;
    el('course-folders').hidden = false; el('classroom-prompt').href = `/teacher.html?course=${encodeURIComponent(scope.courseId)}`;
    status('Course access checked.'); return scope;
  } catch (error) {
    if (current(scope)) { generation++; clearCourseView(); status(error.message); el('classroom-refresh').disabled = false; }
    return null;
  } finally { if (current(scope)) el('classroom-refresh').disabled = false; }
}
el('classroom-course').addEventListener('change', () => void selectCourse());
el('classroom-refresh').addEventListener('click', () => void selectCourse());
el('roster-more').addEventListener('click', () => run(el('roster-more'), scope => roster(true, scope)));
el('jobs-more').addEventListener('click', () => run(el('jobs-more'), scope => loadJobs(student, true, scope)));
el('conversation-more').addEventListener('click', () => run(el('conversation-more'), scope => loadConversation(conversation?.job, true, scope)));
el('folder-create').addEventListener('submit', event => {
  event.preventDefault(); run(event.submitter, async scope => {
    const result = await courseRequest(scope, '/folders', { method: 'POST', body: JSON.stringify({ name: el('folder-name').value }) });
    if (!current(scope)) return;
    el('folder-name').value = ''; await folders(scope); await openFolder(result.folder.id, scope);
  });
});
el('folder-add').addEventListener('submit', event => {
  event.preventDefault(); const target = folder; if (!target) return;
  run(event.submitter, async scope => {
    await courseRequest(scope, `/folders/${encodeURIComponent(target.id)}/items`, { method: 'POST', body: JSON.stringify({ jobId: el('folder-job').value.trim() }) });
    if (!current(scope) || folder?.id !== target.id) return;
    el('folder-job').value = ''; el('folder-selected').textContent = 'Choose a split from course work above.'; el('folder-add-button').disabled = true; await openFolder(target.id, scope);
  });
});
el('folder-grant').addEventListener('click', () => {
  const target = folder; if (!target) return;
  run(el('folder-grant'), async scope => {
    await courseRequest(scope, `/folders/${encodeURIComponent(target.id)}`, { method: 'PUT', body: JSON.stringify({ permission: el('folder-permission').value, revision: target.revision }) });
    if (!current(scope) || folder?.id !== target.id) return;
    el('folder-status').textContent = 'Sharing updated. Only current course members can open a course link.'; await openFolder(target.id, scope); await folders(scope);
  });
});
el('folder-link').addEventListener('click', () => {
  const target = folder; if (!target) return;
  run(el('folder-link'), async scope => {
    await navigator.clipboard.writeText(`${location.origin}/classroom.html?course=${encodeURIComponent(scope.courseId)}&folder=${encodeURIComponent(target.id)}`);
    if (current(scope) && folder?.id === target.id) el('folder-status').textContent = 'Course link copied. Sign-in and current enrollment are required.';
  });
});
(async () => {
  try {
    const { account } = await request('/api/account');
    window.StemSessionGuard?.start(account.subject, () => { generation++; ready = false; courses = []; course = null; clearCourseView(); });
    let cursor = null;
    do { const page = await request('/api/classroom/courses' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '')); courses.push(...page.courses); cursor = page.nextCursor; } while (cursor);
    if (!courses.length) { status('No current courses are available for Stem Splitter.'); return; }
    for (const entry of courses) el('classroom-course').add(new Option(`${entry.className} · ${entry.term} · ${entry.section}`, entry.classId));
    const query = new URLSearchParams(location.search);
    if (courses.some(entry => entry.classId === query.get('course'))) el('classroom-course').value = query.get('course');
    el('classroom-content').hidden = false; const scope = await selectCourse(); if (!scope) return;
    if (query.get('folder')) await openFolder(query.get('folder'), scope);
    if (query.get('job')) { const job = await request(`/api/jobs/${encodeURIComponent(query.get('job'))}`); if (job.courseId === scope.courseId) chooseSplit(job, scope); }
  } catch (error) {
    status(error.message);
    if (error.status === 401) link(el('classroom-status'), 'CUNY Login', '/auth/login?next=' + encodeURIComponent(location.pathname + location.search));
  }
})();
