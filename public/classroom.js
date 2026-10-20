// Course views use the existing current-authority APIs. No identity, grant,
// conversation, or roster is stored in browser storage.
(() => {
  const el = id => document.getElementById(`classroom-${id}`);
  const panel = document.getElementById('console-panel');
  const status = document.getElementById('account-status');
  let courses = [], selected = null, generation = 0, controllers = new Set();
  let pendingRequests = 0;
  let roster = [], rosterCursor = null, folders = [], currentFolder = null;
  let student = null, jobsCursor = null, studentGeneration = 0;
  let conversationJob = null, conversationCursor = null, conversationRevision = null, conversationGeneration = 0;
  let folderGeneration = 0;
  let annotationJob = null, annotationGeneration = 0, refreshTimer = null, refreshing = false;
  let rosterPages = 1, jobsPages = 1, conversationPages = 1;
  const coursePath = suffix => `/api/classroom/courses/${encodeURIComponent(selected.classId)}${suffix}`;
  const link = (text, href) => { const node = document.createElement('a'); node.textContent = text; node.href = href; return node; };
  const button = (text, action) => { const node = document.createElement('button'); node.type = 'button'; node.className = 'page-btn'; node.textContent = text; node.addEventListener('click', action); return node; };
  const row = text => { const node = document.createElement('li'); node.className = 'teacher-history-item'; if (text) node.textContent = text; return node; };
  function clearCourse() {
    generation++; studentGeneration++; conversationGeneration++; folderGeneration++; annotationGeneration++;
    clearTimeout(refreshTimer); refreshing = false;
    for (const controller of controllers) controller.abort(); controllers.clear();
    pendingRequests = 0; delete panel.dataset.checking;
    panel.hidden = true; selected = null; roster = []; folders = []; currentFolder = null; student = null; conversationJob = null; annotationJob = null;
    rosterPages = jobsPages = conversationPages = 1;
    rosterCursor = jobsCursor = conversationCursor = conversationRevision = null;
    for (const id of ['roster', 'jobs', 'messages', 'folders', 'folder-items', 'notes']) el(id).replaceChildren();
    for (const id of ['student', 'conversation', 'folder-detail', 'notes-section']) el(id).hidden = true;
    for (const id of ['roster-more', 'jobs-more', 'conversation-more']) el(id).hidden = true;
    for (const id of ['roster-status', 'jobs-status', 'conversation-status', 'folders-status', 'folder-status', 'usage', 'notes-status']) el(id).textContent = '';
    el('folder-create').reset(); el('folder-sharing').reset(); el('folder-link').value = '';
  }
  async function request(path, options = {}, expectedGeneration = generation) {
    const controller = new AbortController(); controllers.add(controller);
    const scoped = path.startsWith('/api/classroom/courses/') || path.startsWith('/api/jobs/');
    const timer = setTimeout(() => controller.abort(), 8000);
    if (scoped) { pendingRequests++; panel.dataset.checking = 'true'; }
    try {
      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers }, signal: controller.signal });
      const body = await response.json();
      if (expectedGeneration !== generation) throw new DOMException('Previous class request', 'AbortError');
      if (!response.ok) {
        throw Object.assign(new Error(body.error?.message || (typeof body.error === 'string' ? body.error : 'Could not load class work. Please refresh and try again.')), { status: response.status });
      }
      return body;
    } catch (error) {
      if (scoped && expectedGeneration === generation && (!error.status || error.status >= 500 || [401, 403, 429].includes(error.status))) {
        clearCourse();
        status.textContent = [401, 403].includes(error.status)
          ? 'Class access changed. Retry to check your current access.'
          : 'Class access could not be confirmed. Retry to load your class work.';
        el('retry').hidden = false;
      }
      throw error;
    } finally {
      clearTimeout(timer); controllers.delete(controller);
      if (scoped && expectedGeneration === generation) {
        pendingRequests--;
        if (!pendingRequests) delete panel.dataset.checking;
      }
    }
  }
  const report = (id, error) => { if (error.name !== 'AbortError' && selected) el(id).textContent = error.message; };
  function resetConversation() {
    conversationGeneration++; conversationJob = null; conversationCursor = conversationRevision = null;
    el('messages').replaceChildren(); el('conversation').hidden = true; el('conversation-more').hidden = true;
  }
  async function loadRoster(append = false) {
    const current = generation; el('roster-more').disabled = true; el('roster-status').textContent = 'Loading roster…';
    try {
      const data = await request(coursePath(`/roster${append && rosterCursor ? `?cursor=${encodeURIComponent(rosterCursor)}` : ''}`));
      if (!append) { roster = []; el('roster').replaceChildren(); }
      rosterPages = append ? rosterPages + 1 : 1;
      roster.push(...data.participants);
      for (const person of data.participants) {
        const item = row(); item.append(button(`${person.displayName || 'Student'} · ${person.splitCount} ${person.splitCount === 1 ? 'split' : 'splits'}`, () => void loadStudent(person)));
        el('roster').append(item);
      }
      if (!append) for (const sample of data.demonstrationParticipants || []) el('roster').append(row(`DEMO DATA · ${sample.displayName} · ${sample.splitCount} sample splits`));
      rosterCursor = data.nextCursor; el('roster-more').hidden = !rosterCursor;
      const splits = roster.reduce((total, person) => total + person.splitCount, 0);
      const retained = roster.reduce((total, person) => total + person.retainedCount, 0);
      el('usage').textContent = `${roster.length} enrolled students shown · ${splits} assigned ${splits === 1 ? 'split' : 'splits'} · ${retained} within the 90-day retention period${rosterCursor ? ' · Load more students for the remaining totals.' : '.'}`;
      el('roster-status').textContent = roster.length ? '' : 'No enrolled students are listed yet.';
    } catch (error) { if (current === generation) report('roster-status', error); }
    finally { if (current === generation) el('roster-more').disabled = false; }
  }
  async function loadStudent(person, append = false, preserveReview = false, savedFolderChoices = null) {
    const current = generation;
    const folderChoices = savedFolderChoices || (preserveReview ? new Map([...el('jobs').querySelectorAll('select')].map(select => [select.dataset.jobId, select.value])) : new Map());
    if (!append) { studentGeneration++; student = person; jobsCursor = null; if (!preserveReview) el('jobs').replaceChildren();
      if (!preserveReview) { resetConversation(); annotationGeneration++; annotationJob = null; el('notes').replaceChildren(); el('notes-section').hidden = true; }
    }
    const view = studentGeneration;
    el('student').hidden = false; el('student-name').textContent = person.own ? 'My course splits' : `${person.displayName || 'Student'} · Course splits`;
    el('jobs-status').textContent = 'Loading splits…'; el('jobs-more').disabled = true;
    try {
      const data = await request(coursePath(`/participants/${encodeURIComponent(person.memberId)}/jobs${append && jobsCursor ? `?cursor=${encodeURIComponent(jobsCursor)}` : ''}`));
      if (view !== studentGeneration) return;
      jobsPages = append ? jobsPages + 1 : 1;
      if (!append) el('jobs').replaceChildren();
      for (const job of data.jobs) {
        const item = row(); const title = document.createElement('strong'); title.textContent = job.filename; item.append(title);
        const state = document.createElement('p'); state.className = 'account-help'; state.textContent = job.retained ? job.status : 'Audio expired'; item.append(state);
        if (job.retained && job.status === 'done') {
          const actions = document.createElement('div'); actions.className = 'classroom-actions';
          actions.append(link('Open split and notes', `/?job=${encodeURIComponent(job.id)}`), button('Review annotations', () => void loadAnnotations(job)), button('Review Listening Guy session', () => void loadConversation(job)));
          const select = document.createElement('select'); select.setAttribute('aria-label', `Folder for ${job.filename}`);
          select.dataset.jobId = job.id;
          select.append(new Option('Choose a class folder', ''), ...folders.map(folder => new Option(folder.name, folder.id)));
          if (folders.some(folder => folder.id === folderChoices.get(job.id))) select.value = folderChoices.get(job.id);
          const add = button('Add to folder', async () => {
            const folderId = select.value; if (!folderId) { state.textContent = 'Choose a class folder first.'; return; }
            add.disabled = true;
            try { await request(coursePath(`/folders/${encodeURIComponent(folderId)}/items`), { method: 'POST', body: JSON.stringify({ jobId: job.id }) });
              if (view !== studentGeneration) return; state.textContent = 'Added to class folder.'; if (currentFolder?.id === folderId) await loadFolder(folderId);
            } catch (error) { if (view === studentGeneration && error.name !== 'AbortError') state.textContent = error.message; }
            finally { if (view === studentGeneration) add.disabled = false; }
          });
          actions.append(select, add); item.append(actions);
        }
        el('jobs').append(item);
      }
      jobsCursor = data.nextCursor; el('jobs-more').hidden = !jobsCursor;
      el('jobs-status').textContent = el('jobs').children.length ? '' : 'No course-assigned splits yet. Personal splits are not included.';
    } catch (error) { if (current === generation && view === studentGeneration) report('jobs-status', error); }
    finally { if (current === generation && view === studentGeneration) el('jobs-more').disabled = false; }
  }
  async function loadAnnotations(job) {
    const current = generation, view = ++annotationGeneration, courseId = selected.classId;
    annotationJob = job; el('notes-section').hidden = false;
    el('notes-title').textContent = `Course annotations · ${job.filename}`;
    el('notes-status').textContent = 'Loading saved notes…';
    try {
      const data = await request(`/api/jobs/${encodeURIComponent(job.id)}`);
      if (view !== annotationGeneration) return;
      if (data.courseId !== courseId || !Array.isArray(data.annotations)) {
        clearCourse(); status.textContent = 'Class access could not be confirmed. Retry to load your class work.'; el('retry').hidden = false; return;
      }
      el('notes').replaceChildren();
      for (const note of data.annotations) {
        const seconds = Math.max(0, Number(note.atSeconds) || 0), stamp = `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
        el('notes').append(row(`${stamp} · ${note.authorName || 'Author unavailable'}: ${note.text}`));
      }
      el('notes-status').textContent = data.annotations.length ? `${data.annotations.length} saved ${data.annotations.length === 1 ? 'note' : 'notes'}.` : 'No saved course notes yet.';
    } catch (error) { if (current === generation && view === annotationGeneration) { el('notes').replaceChildren(); report('notes-status', error); } }
  }
  async function loadConversation(job, append = false, preserveDisplay = false) {
    const current = generation;
    if (!append) {
      if (preserveDisplay) { conversationGeneration++; conversationCursor = conversationRevision = null; }
      else resetConversation();
      conversationJob = job;
    }
    const view = conversationGeneration;
    el('conversation').hidden = false; el('conversation-title').textContent = `Listening Guy session · ${job.filename}`;
    el('conversation-status').textContent = 'Loading saved messages…'; el('conversation-more').disabled = true;
    try {
      const query = append && conversationCursor !== null ? `?cursor=${encodeURIComponent(conversationCursor)}&revision=${conversationRevision}` : '';
      const data = await request(coursePath(`/jobs/${encodeURIComponent(job.id)}/conversation${query}`));
      if (view !== conversationGeneration) return;
      conversationPages = append ? conversationPages + 1 : 1;
      if (!append) el('messages').replaceChildren();
      for (const entry of data.entries) el('messages').append(row(`${entry.kind === 'you' ? 'Student' : entry.kind === 'coach' ? 'Listening Guy' : 'Session status'}: ${entry.text}`));
      conversationCursor = data.nextCursor; conversationRevision = data.revision;
      el('conversation-more').hidden = conversationCursor === null || conversationCursor === undefined;
      el('conversation-status').textContent = el('messages').children.length ? '' : 'No saved course messages.';
    } catch (error) { if (current === generation && view === conversationGeneration) { el('messages').replaceChildren(); el('conversation-more').hidden = true; report('conversation-status', error); } }
    finally { if (current === generation && view === conversationGeneration) el('conversation-more').disabled = false; }
  }
  async function loadFolders() {
    const current = generation; el('folders-status').textContent = 'Loading folders…';
    try {
      const data = await request(coursePath('/folders')); folders = data.folders;
      el('folders').replaceChildren(...folders.map(folder => { const item = row(); item.append(button(folder.name, () => void loadFolder(folder.id))); return item; }));
      for (const select of el('jobs').querySelectorAll('select')) {
        const previous = select.value;
        select.replaceChildren(new Option('Choose a class folder', ''), ...folders.map(folder => new Option(folder.name, folder.id)));
        if (folders.some(folder => folder.id === previous)) select.value = previous;
      }
      el('folders-status').textContent = folders.length ? '' : 'No shared class folders yet.';
    } catch (error) { if (current === generation) report('folders-status', error); }
  }
  async function loadFolder(id, preserveDisplay = false) {
    const current = generation, view = ++folderGeneration;
    currentFolder = null;
    if (!preserveDisplay) { el('folder-detail').hidden = true; el('folder-items').replaceChildren(); }
    try {
      const data = await request(coursePath(`/folders/${encodeURIComponent(id)}`));
      if (view !== folderGeneration) return;
      currentFolder = data.folder; el('folder-title').textContent = currentFolder.name;
      el('folder-items').replaceChildren();
      el('folder-status').textContent = currentFolder.permission === 'comment' ? 'Class members can add their own notes.' : currentFolder.permission === 'read' ? 'Class members can listen and read notes. Annotation is not enabled for this folder.' : 'Only current course instructors can open this folder.';
      el('folder-sharing').hidden = !selected.capabilities.instructorPanel;
      el('folder-permission').value = currentFolder.permission;
      const url = new URL('/classroom.html', location.origin); url.searchParams.set('course', selected.classId); url.searchParams.set('folder', id);
      el('folder-link').value = url.href;
      for (const job of data.items) { const item = row(); if (job.available) item.append(link(job.filename, `/?job=${encodeURIComponent(job.jobId)}`)); else item.textContent = `${job.filename} · Audio expired or unavailable`; el('folder-items').append(item); }
      if (!data.items.length) el('folder-items').append(row('No splits in this folder yet.'));
      el('folder-detail').hidden = false;
    } catch (error) { if (current === generation && view === folderGeneration) { el('folder-detail').hidden = true; el('folder-items').replaceChildren(); report('folders-status', error); } }
  }
  async function selectCourse(id) {
    clearCourse(); const course = courses.find(course => course.classId === id); if (!course) return;
    el('retry').hidden = true;
    selected = course; status.textContent = course.className; panel.hidden = false;
    el('guidance').hidden = !course.capabilities.instructorPanel;
    el('own-splits').hidden = !course.capabilities.instructorPanel;
    el('guidance').href = `/teacher.html?course=${encodeURIComponent(id)}`;
    el('create').href = `/?course=${encodeURIComponent(id)}`;
    el('roster-section').hidden = !course.capabilities.rosterRead;
    el('folder-create').hidden = !course.capabilities.instructorPanel;
    const current = generation;
    await Promise.all([loadFolders(), course.capabilities.rosterRead ? loadRoster() : Promise.resolve()]);
    if (current !== generation) return;
    const query = new URLSearchParams(location.search);
    if (query.get('course') === id && query.get('folder')) await loadFolder(query.get('folder'));
    if (current === generation) scheduleRefresh();
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (!selected || document.visibilityState !== 'visible') return;
    // Keep loaded pagination while remaining below the 30-read/minute budget.
    const reads = 1 + (selected.capabilities.rosterRead ? rosterPages : 0) + (student ? jobsPages : 0)
      + (currentFolder ? 1 : 0) + (annotationJob ? 1 : 0) + (conversationJob ? conversationPages : 0);
    refreshTimer = setTimeout(() => void refreshCourse(), Math.max(15000, reads * 2500));
  }
  async function refreshCourse() {
    if (!selected || refreshing || pendingRequests) { scheduleRefresh(); return; }
    clearTimeout(refreshTimer); refreshing = true;
    const current = generation, person = student, folder = currentFolder, notes = annotationJob, conversation = conversationJob;
    const pageCounts = { roster: rosterPages, jobs: jobsPages, conversation: conversationPages };
    const folderChoices = new Map([...el('jobs').querySelectorAll('select')].map(select => [select.dataset.jobId, select.value]));
    const folderDraft = el('folder-permission').value;
    pendingRequests++; panel.dataset.checking = 'true';
    try {
      await loadFolders();
      if (current !== generation) return;
      if (selected.capabilities.rosterRead) {
        await loadRoster();
        for (let i = 1; current === generation && i < pageCounts.roster && rosterCursor; i++) await loadRoster(true);
      }
      if (current !== generation) return;
      if (person) {
        await loadStudent(person, false, true, folderChoices);
        for (let i = 1; current === generation && i < pageCounts.jobs && jobsCursor; i++) await loadStudent(person, true, true, folderChoices);
      }
      if (current !== generation) return;
      if (folder) {
        await loadFolder(folder.id, true);
        if (current === generation && currentFolder?.id === folder.id && folderDraft !== folder.permission) {
          el('folder-permission').value = folderDraft;
          // A pending edit keeps its original revision, so another instructor's
          // intervening change still produces a conflict instead of a silent overwrite.
          currentFolder = { ...currentFolder, permission: folder.permission, revision: folder.revision };
        }
      }
      if (current !== generation) return;
      if (notes) await loadAnnotations(notes);
      if (current !== generation) return;
      if (conversation) {
        await loadConversation(conversation, false, true);
        for (let i = 1; current === generation && i < pageCounts.conversation && conversationCursor; i++) await loadConversation(conversation, true);
      }
      if (current === generation) el('refresh-status').textContent = `Updated ${new Date().toLocaleTimeString()}. Course work refreshes automatically while this page is visible.`;
    } finally {
      if (current === generation) { refreshing = false; pendingRequests--; if (!pendingRequests) delete panel.dataset.checking; scheduleRefresh(); }
    }
  }
  // App membership alone does not prove that a course grant is still current.
  // Returning to this page conceals old class data while its scoped APIs recheck it.
  const recheckCourse = () => { if (selected) void refreshCourse(); };
  window.addEventListener('focus', recheckCourse);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') recheckCourse(); else clearTimeout(refreshTimer); });
  el('course').addEventListener('change', () => void selectCourse(el('course').value));
  el('refresh').addEventListener('click', () => void refreshCourse());
  el('retry').addEventListener('click', () => void selectCourse(el('course').value));
  el('own-splits').addEventListener('click', () => selected && void loadStudent({ memberId: selected.memberId, displayName: selected.displayName, own: true }));
  el('roster-more').addEventListener('click', () => void loadRoster(true));
  el('jobs-more').addEventListener('click', () => student && void loadStudent(student, true));
  el('conversation-more').addEventListener('click', () => conversationJob && void loadConversation(conversationJob, true));
  el('folder-create').addEventListener('submit', async event => {
    event.preventDefault(); const current = generation; const name = el('folder-name').value.trim(); if (!selected || !name) return;
    const submit = event.currentTarget.querySelector('button'); submit.disabled = true;
    try { const data = await request(coursePath('/folders'), { method: 'POST', body: JSON.stringify({ name }) }); el('folder-name').value = ''; await loadFolders(); if (current === generation) await loadFolder(data.folder.id); }
    catch (error) { if (current === generation) report('folders-status', error); }
    finally { submit.disabled = false; }
  });
  el('folder-sharing').addEventListener('submit', async event => {
    event.preventDefault(); if (!selected || !currentFolder) return;
    const current = generation, view = folderGeneration, folder = currentFolder;
    const submit = event.currentTarget.querySelector('button'); submit.disabled = true;
    try { await request(coursePath(`/folders/${encodeURIComponent(folder.id)}`), { method: 'PUT', body: JSON.stringify({ permission: el('folder-permission').value, revision: folder.revision }) });
      if (current === generation && view === folderGeneration) {
        await loadFolders();
        if (current === generation && view === folderGeneration) await loadFolder(folder.id);
      }
    } catch (error) { if (current === generation && view === folderGeneration) report('folder-status', error); }
    finally { submit.disabled = false; }
  });
  (async () => {
    try {
      const { account } = await request('/api/account');
      if (account.quotaClass === 'guest') { status.textContent = 'Sign in with your CUNY account to open your classes.'; el('login').hidden = false; return; }
      window.StemSessionGuard?.start(account.subject, clearCourse);
      let cursor = null;
      do { const data = await request(`/api/classroom/courses${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`); courses.push(...data.courses); cursor = data.nextCursor; } while (cursor && courses.length < 1000);
      el('course').append(...courses.map(course => new Option(`${course.className} · ${course.term} · ${course.section}`, course.classId)));
      document.getElementById('course-discovery').hidden = !courses.length;
      status.textContent = courses.length ? 'Choose a class to view its shared work.' : 'No current classes are available to this account.';
      const requested = new URLSearchParams(location.search).get('course');
      if (requested && courses.some(course => course.classId === requested)) { el('course').value = requested; await selectCourse(requested); }
    } catch (error) { clearCourse(); status.textContent = error.message; el('login').hidden = false; }
  })();
})();
