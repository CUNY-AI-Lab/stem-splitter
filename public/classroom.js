// Course views use the existing current-authority APIs. No identity, grant,
// conversation, or roster is stored in browser storage; only the selected class ID is remembered.
(() => {
  const el = id => document.getElementById(`classroom-${id}`);
  window.StemSelect?.enhance(el('course'), 'Class');
  const panel = document.getElementById('console-panel');
  const status = document.getElementById('account-status');
  let courses = [], selected = null, generation = 0, controllers = new Set(), choiceKey = null;
  let pendingRequests = 0, renameFolder = null;
  let roster = [], rosterCursor = null, folders = [], currentFolder = null;
  let student = null, jobsCursor = null, studentGeneration = 0;
  let conversationJob = null, conversationCursor = null, conversationRevision = null, conversationGeneration = 0;
  let folderGeneration = 0;
  let annotationJob = null, annotationGeneration = 0, refreshTimer = null, refreshing = false;
  let rosterPages = 1, jobsPages = 1, conversationPages = 1;
  let view = 'folders', rosterPerson = null, folderItems = [], deleteTimer = null;
  let pickerJobs = [], pickerCursor = null, pickerGeneration = 0;
  const coursePath = suffix => `/api/classroom/courses/${encodeURIComponent(selected.classId)}${suffix}`;
  const link = (text, href) => { const node = document.createElement('a'); node.textContent = text; node.href = StemPath(href); return node; };
  const button = (text, action) => { const node = document.createElement('button'); node.type = 'button'; node.className = 'page-btn'; node.textContent = text; node.addEventListener('click', action); return node; };
  const row = text => { const node = document.createElement('li'); node.className = 'teacher-history-item'; if (text) node.textContent = text; return node; };
  const canManage = () => Boolean(selected?.capabilities.instructorPanel);
  const canCreateFolder = () => Boolean(selected && (selected.participant || canManage()));
  const canEditFolder = (folder = currentFolder) => folder?.canManage === true;
  const canAddToFolder = (folder = currentFolder) => canEditFolder(folder) || folder?.canContribute === true;
  const assignableFolders = () => folders.filter(canAddToFolder);
  const ownRecord = () => ({ memberId: selected.memberId, displayName: selected.displayName, own: true });
  // Everything for one class stays on this page, in one place per section.
  function applyView() {
    const roster = Boolean(selected?.capabilities.rosterRead);
    if (view === 'students' && !roster) view = 'folders';
    el('views').hidden = !selected;
    el('view-students').hidden = !roster;
    for (const [id, name] of [['view-folders', 'folders'], ['own-splits', 'splits'], ['view-students', 'students']]) {
      if (view === name) el(id).setAttribute('aria-current', 'true'); else el(id).removeAttribute('aria-current');
    }
    el('folders-section').hidden = view !== 'folders';
    el('people').hidden = view === 'folders';
    el('roster-section').hidden = view !== 'students';
    el('create').hidden = false;
    el('make-folder').hidden = !canCreateFolder();
  }
  function syncAddress() {
    if (!selected) return;
    const url = new URL(location.href);
    url.searchParams.set('course', selected.classId);
    if (view === 'folders') url.searchParams.delete('view'); else url.searchParams.set('view', view);
    if (view === 'folders' && currentFolder && !el('folder-detail').hidden) url.searchParams.set('folder', currentFolder.id); else url.searchParams.delete('folder');
    history.replaceState(null, '', url);
  }
  function setView(next) {
    view = next; applyView(); syncAddress();
    if (view === 'splits' && !student?.own) void loadStudent(ownRecord());
    if (view === 'students' && student?.own) {
      if (rosterPerson) void loadStudent(rosterPerson);
      else { studentGeneration++; student = null; resetReview(); }
    }
  }
  function resetReview() {
    el('jobs').replaceChildren(); el('student').hidden = true; el('jobs-more').hidden = true; el('jobs-status').textContent = '';
    resetConversation(); annotationGeneration++; annotationJob = null; el('notes').replaceChildren(); el('notes-section').hidden = true;
  }
  const reveal = (section, heading) => { section.scrollIntoView({ block: 'nearest' }); heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); };
  // A folder opens under its own row, so nothing appears somewhere else on the page.
  function placeFolderDetail() {
    const detail = el('folder-detail');
    const open = currentFolder && !detail.hidden ? currentFolder.id : null;
    const target = open && [...el('folders').children].find(item => item.dataset.folderId === open);
    (target || el('folders-section')).append(detail);
    for (const item of el('folders').children) item.querySelector(':scope > button')?.setAttribute('aria-expanded', String(item.dataset.folderId === open));
  }
  function closePicker() {
    pickerGeneration++; pickerJobs = []; pickerCursor = null;
    el('add-panel').hidden = true; el('add-list').replaceChildren(); el('add-more').hidden = true; el('add-status').textContent = '';
    el('add-toggle').setAttribute('aria-expanded', 'false');
  }
  function disarmDelete() { clearTimeout(deleteTimer); deleteTimer = null; el('delete-folder').textContent = 'Delete'; el('delete-folder').classList.remove('armed'); }
  function closeFolder() {
    folderGeneration++; currentFolder = null; folderItems = []; renameFolder = null; closePicker(); disarmDelete();
    el('rename-form').hidden = true; el('folder-detail').hidden = true; el('folder-items').replaceChildren(); placeFolderDetail(); syncAddress();
  }
  function clearCourse() {
    renameFolder = null;
    generation++; studentGeneration++; conversationGeneration++; folderGeneration++; annotationGeneration++;
    clearTimeout(refreshTimer); refreshing = false;
    for (const controller of controllers) controller.abort(); controllers.clear();
    pendingRequests = 0; panel.inert = false; delete panel.dataset.checking; delete panel.dataset.backgroundRefresh;
    panel.hidden = true; selected = null; roster = []; folders = []; currentFolder = null; student = null; conversationJob = null; annotationJob = null;
    view = 'folders'; rosterPerson = null; folderItems = []; pickerJobs = []; pickerCursor = null; pickerGeneration++; clearTimeout(deleteTimer); deleteTimer = null;
    rosterPages = jobsPages = conversationPages = 1;
    rosterCursor = jobsCursor = conversationCursor = conversationRevision = null;
    // The session guard may already have removed these private descendants.
    if (!el('rename-form')) return;
    el('folders-section').append(el('folder-detail'));
    el('rename-form').hidden = true; el('rename-toggle').hidden = true; el('delete-folder').hidden = true; el('add-toggle').hidden = true;
    disarmDelete(); el('add-panel').hidden = true; el('add-list').replaceChildren(); el('add-more').hidden = true; el('add-status').textContent = ''; el('add-toggle').setAttribute('aria-expanded', 'false');
    for (const id of ['roster', 'jobs', 'messages', 'folders', 'folder-items', 'notes']) el(id).replaceChildren();
    if (el('demo')) { el('demo').hidden = true; el('demo').open = false; el('demo-roster').replaceChildren(); }
    if (el('copy-status')) el('copy-status').textContent = '';
    for (const id of ['student', 'conversation', 'folder-detail', 'notes-section']) el(id).hidden = true;
    for (const id of ['roster-more', 'jobs-more', 'conversation-more']) el(id).hidden = true;
    for (const id of ['roster-status', 'jobs-status', 'conversation-status', 'folders-status', 'folder-status', 'usage', 'notes-status']) el(id).textContent = '';
    el('folder-create').reset(); el('folder-sharing').reset(); el('folder-link').value = '';
  }
  // A read that reveals more class work stays concealed until access is rechecked.
  // quiet: an edit to what is already on screen keeps the page visible.
  async function request(path, { quiet = false, ...options } = {}, expectedGeneration = generation) {
    const controller = new AbortController(); controllers.add(controller);
    const scoped = path.startsWith('/api/classroom/courses/') || path.startsWith('/api/jobs/');
    const timer = setTimeout(() => controller.abort(), 8000);
    if (scoped) { pendingRequests++; panel.dataset.checking = 'true'; if (quiet && !refreshing) panel.dataset.backgroundRefresh = 'true'; }
    try {
      const response = await window.StemFetch(path, { credentials: 'same-origin', cache: 'no-store', ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers }, signal: controller.signal });
      const body = await response.json();
      if (expectedGeneration !== generation) throw new DOMException('Previous class request', 'AbortError');
      if (!response.ok) {
        throw Object.assign(new Error(body.error?.message || (typeof body.error === 'string' ? body.error : 'Could not load class work. Please refresh and try again.')), { status: response.status });
      }
      return body;
    } catch (error) {
      if (expectedGeneration === generation && error.status === 404 && selected
          && path.split('?')[0].startsWith(coursePath('/folders/'))) {
        // Hidden and missing folders both return 404. Drop the old detail before
        // reloading the list; a failed edit must not keep withdrawn work visible.
        const deniedId = path.slice(coursePath('/folders/').length).split(/[/?]/)[0];
        if (currentFolder && encodeURIComponent(currentFolder.id) === deniedId) closeFolder();
        void loadFolders();
      }
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
        if (!pendingRequests) { delete panel.dataset.checking; if (!refreshing) delete panel.dataset.backgroundRefresh; }
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
        const item = row(), name = button(person.displayName || 'Student', () => { rosterPerson = person; void loadStudent(person).then(() => { if (student === person) reveal(el('student'), el('student-name')); }); });
        name.classList.add('classroom-roster-person');
        const course = document.createElement('span'); course.className = 'classroom-roster-metrics';
        course.textContent = `${person.splitCount} ${person.splitCount === 1 ? 'split' : 'splits'} for this class · ${person.completedCount ?? 0} completed`;
        const activity = document.createElement('span'); activity.className = 'classroom-roster-app-usage';
        const use = person.appUsage;
        activity.textContent = use
          ? `App use: ${use.runs} split ${use.runs === 1 ? 'attempt' : 'attempts'} · ${use.completed} completed · ${use.guideTurns} Guide ${use.guideTurns === 1 ? 'turn' : 'turns'} · ${use.recordedVisits} recorded ${use.recordedVisits === 1 ? 'visit' : 'visits'} in 30 days`
          : data.appUsageStatus === 'unavailable' ? 'App usage temporarily unavailable' : 'App usage pending';
        if (use?.lastActiveAt) activity.title = `Last recorded activity: ${new Date(use.lastActiveAt).toLocaleString()}`;
        item.append(name,course,activity); el('roster').append(item);
      }
      if (!append && el('demo')) {
        const samples = data.demonstrationParticipants || [];
        el('demo').hidden = !samples.length;
        el('demo-roster').replaceChildren(...samples.map(sample => row(`${sample.displayName} · ${sample.splitCount} sample splits`)));
      }
      rosterCursor = data.nextCursor; el('roster-more').hidden = !rosterCursor;
      const splits = roster.reduce((total, person) => total + person.splitCount, 0);
      const retained = roster.reduce((total, person) => total + person.retainedCount, 0);
      el('usage').textContent = `${roster.length} enrolled students shown · ${splits} assigned ${splits === 1 ? 'split' : 'splits'} · ${retained} within the 90-day retention period${rosterCursor ? ' · Load more students for the remaining totals.' : '.'}`;
      const active = roster.filter(person => person.appUsage).length;
      if (roster.length) el('usage').textContent += ` ${active} with recorded app access.`;
      el('roster-status').textContent = roster.length ? '' : `${selected.className} has 0 enrolled students.`;
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
    el('student').hidden = false; el('student-name').textContent = person.own ? 'My splits in this class' : `${person.displayName || 'Student'} · Course splits`;
    el('jobs-status').textContent = 'Loading splits…'; el('jobs-more').disabled = true;
    try {
      const data = await request(coursePath(`/participants/${encodeURIComponent(person.memberId)}/jobs${append && jobsCursor ? `?cursor=${encodeURIComponent(jobsCursor)}` : ''}`));
      if (view !== studentGeneration) return;
      jobsPages = append ? jobsPages + 1 : 1;
      if (!append) el('jobs').replaceChildren();
      for (const job of data.jobs) {
        const item = row(); const title = document.createElement('strong'); title.textContent = job.filename; item.append(title);
        const state = document.createElement('p'); state.className = 'account-help'; state.textContent = job.retained ? (job.status === 'done' ? 'Ready' : job.status) : 'Audio expired'; item.append(state);
        if (job.retained && job.status === 'done') {
          const actions = document.createElement('div'); actions.className = 'classroom-actions classroom-job-actions';
          actions.append(link('Open split', `/?job=${encodeURIComponent(job.id)}`), button('Annotations', () => void loadAnnotations(job)));
          if (canManage()) actions.append(button('Listening Guy messages', () => void loadConversation(job)));
          const select = document.createElement('select'); select.setAttribute('aria-label', `Folder for ${job.filename}`);
          select.dataset.jobId = job.id;
          select.append(new Option('Choose a class folder', ''), ...assignableFolders().map(folder => new Option(folder.name, folder.id)));
          if (assignableFolders().some(folder => folder.id === folderChoices.get(job.id))) select.value = folderChoices.get(job.id);
          const add = button('Add to folder', async () => {
            const folderId = select.value; if (!folderId) { state.textContent = assignableFolders().length ? 'Choose a class folder first.' : 'Create a folder under Folders first.'; return; }
            add.disabled = true;
            try { await request(coursePath(`/folders/${encodeURIComponent(folderId)}/items`), { quiet: true, method: 'POST', body: JSON.stringify({ jobId: job.id }) });
              if (view !== studentGeneration) return; state.textContent = 'Added to class folder.'; if (currentFolder?.id === folderId) await loadFolder(folderId);
            } catch (error) { if (view === studentGeneration && error.name !== 'AbortError') state.textContent = error.message; }
            finally { if (view === studentGeneration) add.disabled = false; }
          });
          const assignment = document.createElement('div'); assignment.className = 'classroom-folder-assignment';
          assignment.append(select, add); item.append(actions, assignment);
        }
        el('jobs').append(item);
      }
      jobsCursor = data.nextCursor; el('jobs-more').hidden = !jobsCursor;
      el('jobs-status').textContent = el('jobs').children.length ? '' : person.own ? 'You have no splits in this class yet. Choose Create shared split to start one.' : 'This student has no splits for this class yet.';
    } catch (error) { if (current === generation && view === studentGeneration) report('jobs-status', error); }
    finally { if (current === generation && view === studentGeneration) el('jobs-more').disabled = false; }
  }
  async function loadAnnotations(job, preserveDisplay = false) {
    const current = generation, view = ++annotationGeneration, courseId = selected.classId;
    annotationJob = job; el('notes-section').hidden = false;
    if (!preserveDisplay) reveal(el('notes-section'), el('notes-title'));
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
        const item = row(), meta = document.createElement('span'); meta.className = 'classroom-entry-meta';
        meta.textContent = `${stamp} · ${note.authorName || 'Author unavailable'}: `;
        item.append(meta, document.createTextNode(note.text)); el('notes').append(item);
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
    if (!append && !preserveDisplay) reveal(el('conversation'), el('conversation-title'));
    el('conversation-status').textContent = 'Loading saved messages…'; el('conversation-more').disabled = true;
    try {
      const query = append && conversationCursor !== null ? `?cursor=${encodeURIComponent(conversationCursor)}&revision=${conversationRevision}` : '';
      const data = await request(coursePath(`/jobs/${encodeURIComponent(job.id)}/conversation${query}`));
      if (view !== conversationGeneration) return;
      conversationPages = append ? conversationPages + 1 : 1;
      if (!append) el('messages').replaceChildren();
      for (const entry of data.entries) {
        const item = row(), meta = document.createElement('span'); meta.className = 'classroom-entry-meta';
        meta.textContent = `${entry.kind === 'you' ? 'Student' : entry.kind === 'coach' ? 'Listening Guy' : 'Session status'}: `;
        item.append(meta, document.createTextNode(entry.text)); el('messages').append(item);
      }
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
      el('folders-section').append(el('folder-detail'));
      el('folders').replaceChildren(...folders.map(folder => { const item = row(), scope = document.createElement('span'); item.dataset.folderId = folder.id; scope.className = 'classroom-entry-meta'; scope.textContent = folder.permission === 'private' ? 'Private · creator and instructors' : folder.permission === 'comment' ? 'Class · can add notes' : 'Class · can listen'; item.append(button(folder.name, () => { if (currentFolder?.id === folder.id && !el('folder-detail').hidden) closeFolder(); else void loadFolder(folder.id); }),scope); return item; }));
      placeFolderDetail();
      for (const select of el('jobs').querySelectorAll('select')) {
        const previous = select.value;
        select.replaceChildren(new Option('Choose a class folder', ''), ...assignableFolders().map(folder => new Option(folder.name, folder.id)));
        if (assignableFolders().some(folder => folder.id === previous)) select.value = previous;
      }
      el('folders-status').textContent = folders.length ? '' : 'No folders yet. Create one, add splits, then choose who can open it.';
    } catch (error) { if (current === generation) report('folders-status', error); }
  }
  async function loadFolder(id, preserveDisplay = false) {
    const current = generation, view = ++folderGeneration;
    currentFolder = null;
    if (!preserveDisplay) { renameFolder = null; closePicker(); disarmDelete(); folderItems = []; el('rename-form').hidden = true; el('folder-detail').hidden = true; el('folder-items').replaceChildren(); placeFolderDetail(); }
    try {
      const data = await request(coursePath(`/folders/${encodeURIComponent(id)}`), { quiet: preserveDisplay });
      if (view !== folderGeneration) return;
      currentFolder = data.folder; el('folder-title').textContent = currentFolder.name;
      el('folder-items').replaceChildren();
      el('folder-status').textContent = currentFolder.permission === 'comment' ? 'Class members can contribute splits, listen and add notes.' : currentFolder.permission === 'read' ? 'Class members can contribute splits, listen and read notes.' : 'Only the creator and instructors can see this folder until it is shared with the class.';
      if (el('copy-status')) el('copy-status').textContent = '';
      if (!canEditFolder()) { renameFolder = null; el('rename-form').hidden = true; disarmDelete(); }
      if (!canAddToFolder()) closePicker();
      el('folder-sharing').hidden = !canEditFolder();
      el('rename-toggle').hidden = !canEditFolder() || !el('rename-form').hidden;
      el('delete-folder').hidden = !canEditFolder();
      el('add-toggle').hidden = !canAddToFolder();
      el('add-help').textContent = canManage() ? 'Your finished splits in this class. To add a student’s split, open the student under Students.' : 'Add your finished splits in this class. Your private listening conversations stay separate.';
      el('folder-share').hidden = currentFolder.permission === 'private';
      el('folder-permission').value = currentFolder.permission;
      const url = new URL(StemPath('/classroom.html'), location.origin); url.searchParams.set('course', selected.classId); url.searchParams.set('folder', id);
      el('folder-link').value = url.href;
      folderItems = data.items;
      for (const job of data.items) {
        const item = row(); if (job.available) item.append(link(job.filename, `/?job=${encodeURIComponent(job.jobId)}`)); else item.append(document.createTextNode(`${job.filename} · Audio expired or unavailable`));
        if (job.canRemove === true) {
          const remove = button('Remove', () => void removeFromFolder(job, remove)); remove.setAttribute('aria-label', `Remove ${job.filename} from this folder`); item.append(remove);
        }
        el('folder-items').append(item);
      }
      if (!data.items.length) el('folder-items').append(row(canAddToFolder() ? 'No splits in this folder yet. Use Add splits below.' : 'No splits in this folder yet.'));
      el('folder-detail').hidden = false; placeFolderDetail(); renderPicker();
      if (!preserveDisplay) syncAddress();
    } catch (error) { if (current === generation && view === folderGeneration) { el('folder-detail').hidden = true; el('folder-items').replaceChildren(); report('folders-status', error); } }
  }
  async function removeFromFolder(job, control) {
    const current = generation, folder = currentFolder; if (!folder) return;
    control.disabled = true;
    try { await request(coursePath(`/folders/${encodeURIComponent(folder.id)}/items/${encodeURIComponent(job.jobId)}`), { quiet: true, method: 'DELETE' }); if (current === generation && currentFolder?.id === folder.id) await loadFolder(folder.id, true); }
    catch (error) { control.disabled = false; if (current === generation) report('folder-status', error); }
  }
  function renderPicker() {
    if (el('add-panel').hidden) return;
    const held = new Set(folderItems.map(item => item.jobId));
    el('add-list').replaceChildren(...pickerJobs.map(job => {
      const item = row(), title = document.createElement('span'), present = held.has(job.id);
      title.textContent = job.filename;
      const add = button(present ? 'In this folder' : 'Add', () => void addToFolder(job, add));
      add.disabled = present; add.setAttribute('aria-label', present ? `${job.filename} is in this folder` : `Add ${job.filename} to this folder`);
      item.append(title, add); return item;
    }));
  }
  async function loadPicker(append = false) {
    const current = generation, viewing = ++pickerGeneration;
    el('add-status').textContent = 'Loading your class splits…'; el('add-more').disabled = true;
    try {
      const data = await request(coursePath(`/participants/${encodeURIComponent(selected.memberId)}/jobs${append && pickerCursor ? `?cursor=${encodeURIComponent(pickerCursor)}` : ''}`), { quiet: true });
      if (viewing !== pickerGeneration) return;
      const usable = data.jobs.filter(job => job.retained && job.status === 'done');
      pickerJobs = append ? [...pickerJobs, ...usable] : usable;
      pickerCursor = data.nextCursor; el('add-more').hidden = !pickerCursor;
      renderPicker();
      el('add-status').textContent = pickerJobs.length ? '' : 'You have no finished splits in this class yet. Choose Create shared split to start one.';
    } catch (error) { if (current === generation && viewing === pickerGeneration) report('add-status', error); }
    finally { if (viewing === pickerGeneration) el('add-more').disabled = false; }
  }
  async function addToFolder(job, control) {
    const current = generation, folder = currentFolder; if (!folder) return;
    control.disabled = true;
    try {
      await request(coursePath(`/folders/${encodeURIComponent(folder.id)}/items`), { quiet: true, method: 'POST', body: JSON.stringify({ jobId: job.id }) });
      if (current === generation && currentFolder?.id === folder.id) await loadFolder(folder.id, true);
    } catch (error) { control.disabled = false; if (current === generation) report('add-status', error); }
  }
  async function selectCourse(id) {
    clearCourse(); if (!courses.some(course => course.classId === id)) return;
    el('retry').hidden = true;
    let course;
    try {
      ({ course } = await request(`/api/classroom/courses/${encodeURIComponent(id)}`));
      if (course?.classId !== id || !course.capabilities) throw new Error('Class access could not be confirmed.');
    } catch (error) {
      if (error.name !== 'AbortError') { status.textContent = error.message; el('retry').hidden = false; }
      return;
    }
    courses = courses.map(row => row.classId === id ? course : row);
    selected = course; status.textContent = ''; panel.hidden = false;
    try { if (choiceKey) localStorage.setItem(choiceKey,id); } catch {}
    const url = new URL(location.href); url.searchParams.set('course',id);
    const requested = new URLSearchParams(location.search);
    if (requested.get('course') !== id) { url.searchParams.delete('folder'); url.searchParams.delete('view'); }
    view = requested.get('course') === id && !requested.get('folder') && ['splits', 'students'].includes(requested.get('view')) ? requested.get('view') : 'folders';
    history.replaceState(null,'',url);
    el('guidance').hidden = !course.capabilities.instructorPanel;
    el('guidance').href = StemPath(`/teacher.html?course=${encodeURIComponent(id)}`);
    el('create').href = StemPath(`/?course=${encodeURIComponent(id)}`);
    el('folder-create').hidden = !canCreateFolder();
    applyView(); if (requested.get('view') && !requested.get('folder') && view === 'folders') syncAddress();
    const current = generation;
    await Promise.all([loadFolders(), course.capabilities.rosterRead ? loadRoster() : Promise.resolve()]);
    if (current !== generation) return;
    const query = new URLSearchParams(location.search);
    if (query.get('course') === id && query.get('folder')) await loadFolder(query.get('folder'));
    if (current === generation && view === 'splits') await loadStudent(ownRecord());
    if (current === generation) { el('refresh-status').textContent = `Updated ${new Date().toLocaleTimeString()}`; scheduleRefresh(); }
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (!selected || document.visibilityState !== 'visible') return;
    // Keep loaded pagination while remaining below the 30-read/minute budget.
    const reads = 2 + (selected.capabilities.rosterRead ? rosterPages : 0) + (student ? jobsPages : 0)
      + (currentFolder ? 1 : 0) + (annotationJob ? 1 : 0) + (conversationJob ? conversationPages : 0);
    refreshTimer = setTimeout(() => void refreshCourse(true), Math.max(15000, reads * 2500));
  }
  async function refreshCourse(background = false) {
    if (!selected || refreshing || pendingRequests) { scheduleRefresh(); return; }
    clearTimeout(refreshTimer); refreshing = true;
    const focusedControl = panel.contains(document.activeElement) ? document.activeElement : null;
    panel.inert = true;
    const current = generation, person = student, folder = currentFolder, notes = annotationJob, conversation = conversationJob;
    const pageCounts = { roster: rosterPages, jobs: jobsPages, conversation: conversationPages };
    const folderChoices = new Map([...el('jobs').querySelectorAll('select')].map(select => [select.dataset.jobId, select.value]));
    const folderDraft = el('folder-permission').value;
    pendingRequests++; panel.dataset.checking = 'true';
    if (background) panel.dataset.backgroundRefresh = 'true';
    try {
      const { course } = await request(coursePath(''));
      if (current !== generation) return;
      if (course?.classId !== selected.classId || !course.capabilities) throw new Error('Class access could not be confirmed.');
      const authority = value => JSON.stringify([value.memberId, value.owner, value.participant,
        value.capabilities.instructorPanel, value.capabilities.rosterRead, value.capabilities.promptRead, value.capabilities.promptWrite]);
      if (authority(course) !== authority(selected)) {
        // Clear the old role's roster, conversations and pending edits before
        // loading the same person's newly authorized view. Keep the document.
        await selectCourse(course.classId);
        return;
      }
      selected = course;
      status.textContent = '';
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
        if (current === generation && currentFolder?.id === folder.id && canEditFolder() && folderDraft !== folder.permission) {
          el('folder-permission').value = folderDraft;
          // A pending edit keeps its original revision, so another instructor's
          // intervening change still produces a conflict instead of a silent overwrite.
          currentFolder = { ...currentFolder, permission: folder.permission, revision: folder.revision };
        }
      }
      if (current !== generation) return;
      if (notes) await loadAnnotations(notes, true);
      if (current !== generation) return;
      if (conversation) {
        await loadConversation(conversation, false, true);
        for (let i = 1; current === generation && i < pageCounts.conversation && conversationCursor; i++) await loadConversation(conversation, true);
      }
      if (current === generation) el('refresh-status').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      if (current === generation) {
        clearCourse(); status.textContent = 'Class access could not be confirmed. Retry to load your class work.';
        el('retry').hidden = false;
      }
    } finally {
      if (current === generation) { refreshing = false; panel.inert = false;
        if (focusedControl?.isConnected && document.activeElement === document.body) focusedControl.focus({preventScroll:true});
        pendingRequests--; if (!pendingRequests) delete panel.dataset.checking; delete panel.dataset.backgroundRefresh; scheduleRefresh(); }
    }
  }
  // App membership alone does not prove that a course grant is still current.
  // Returning to this page conceals old class data while its scoped APIs recheck it.
  const recheckCourse = () => { delete panel.dataset.backgroundRefresh; if (selected) void refreshCourse(); };
  window.addEventListener('focus', recheckCourse);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') recheckCourse(); else clearTimeout(refreshTimer); });
  el('course').addEventListener('change', () => void selectCourse(el('course').value));
  el('refresh').addEventListener('click', () => void refreshCourse());
  el('make-folder').addEventListener('click', () => {
    if (!canCreateFolder()) return;
    setView('folders');
    el('folder-name').scrollIntoView({ block: 'nearest' }); el('folder-name').focus();
  });
  el('retry').addEventListener('click', () => void selectCourse(el('course').value));
  el('view-folders').addEventListener('click', () => selected && setView('folders'));
  el('own-splits').addEventListener('click', () => selected && setView('splits'));
  el('view-students').addEventListener('click', () => selected && setView('students'));
  el('add-toggle').addEventListener('click', () => {
    if (!selected || !canAddToFolder()) return;
    if (!el('add-panel').hidden) { closePicker(); return; }
    el('add-panel').hidden = false; el('add-toggle').setAttribute('aria-expanded', 'true'); void loadPicker();
  });
  el('add-more').addEventListener('click', () => void loadPicker(true));
  el('delete-folder').addEventListener('click', async () => {
    if (!selected || !canEditFolder()) return;
    const control = el('delete-folder');
    if (!deleteTimer) {
      control.textContent = 'Confirm delete'; control.classList.add('armed');
      el('folder-status').textContent = 'Deleting removes this folder. Its splits stay in the class.';
      deleteTimer = setTimeout(() => { disarmDelete(); if (currentFolder) void loadFolder(currentFolder.id, true); }, 6000);
      return;
    }
    const current = generation, folder = currentFolder; disarmDelete(); control.disabled = true;
    try {
      await request(coursePath(`/folders/${encodeURIComponent(folder.id)}`), { quiet: true, method: 'DELETE' });
      if (current === generation) { closeFolder(); await loadFolders(); }
    } catch (error) { if (current === generation) report('folder-status', error); }
    finally { control.disabled = false; }
  });
  el('roster-more').addEventListener('click', () => void loadRoster(true));
  el('jobs-more').addEventListener('click', () => student && void loadStudent(student, true));
  el('conversation-more').addEventListener('click', () => conversationJob && void loadConversation(conversationJob, true));
  el('folder-create').addEventListener('submit', async event => {
    event.preventDefault(); const current = generation; const name = el('folder-name').value.trim(); if (!canCreateFolder() || !name) return;
    const submit = event.currentTarget.querySelector('button'); submit.disabled = true;
    try { const data = await request(coursePath('/folders'), { quiet: true, method: 'POST', body: JSON.stringify({ name }) }); el('folder-name').value = ''; await loadFolders(); if (current === generation) await loadFolder(data.folder.id); }
    catch (error) { if (current === generation) report('folders-status', error); }
    finally { submit.disabled = false; }
  });
  el('folder-sharing').addEventListener('submit', async event => {
    event.preventDefault(); if (!selected || !canEditFolder()) return;
    const current = generation, view = folderGeneration, folder = currentFolder;
    const submit = event.currentTarget.querySelector('button'); submit.disabled = true;
    try { await request(coursePath(`/folders/${encodeURIComponent(folder.id)}`), { quiet: true, method: 'PUT', body: JSON.stringify({ permission: el('folder-permission').value, revision: folder.revision }) });
      if (current === generation && view === folderGeneration) {
        await loadFolders();
        if (current === generation && view === folderGeneration) await loadFolder(folder.id);
      }
    } catch (error) { if (current === generation && view === folderGeneration) report('folder-status', error); }
    finally { submit.disabled = false; }
  });
  const cancelRename = () => { renameFolder = null; el('rename-form').hidden = true; el('rename-toggle').hidden = !canEditFolder(); if (canEditFolder()) el('rename-toggle').focus(); };
  el('rename-toggle').addEventListener('click', () => {
    if (!canEditFolder()) return;
    el('rename-reload').hidden = true;
    renameFolder = {...currentFolder}; el('rename-name').value = currentFolder.name; el('rename-status').textContent = '';
    el('rename-form').hidden = false; el('rename-toggle').hidden = true; el('rename-name').focus(); el('rename-name').select();
  });
  el('rename-cancel').addEventListener('click', cancelRename);
  el('rename-reload').addEventListener('click', async () => {
    if (!renameFolder) return;
    const folder = renameFolder, current = generation;
    el('rename-reload').disabled = true;
    await loadFolder(folder.id, true);
    if (current === generation && renameFolder === folder && currentFolder?.id === folder.id) {
      renameFolder = {...currentFolder};
      el('rename-reload').hidden = true;
      el('rename-status').textContent = 'Folder reloaded. Review your name, then save.';
      el('rename-name').focus();
    }
    el('rename-reload').disabled = false;
  });
  el('rename-form').addEventListener('keydown', event => { if (event.key === 'Escape' && !el('rename-cancel').disabled) { event.preventDefault(); cancelRename(); } });
  el('rename-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!renameFolder || !canEditFolder() || currentFolder.id !== renameFolder.id) return;
    const name = el('rename-name').value.trim(), folder = renameFolder, current = generation;
    if (!name) { el('rename-status').textContent = 'Enter a folder name.'; return; }
    if (name === folder.name) { cancelRename(); return; }
    const submit = event.currentTarget.querySelector('[type="submit"]'); submit.disabled = el('rename-cancel').disabled = true;
    el('rename-status').textContent = 'Saving…';
    try {
      await request(coursePath(`/folders/${encodeURIComponent(folder.id)}`), {quiet:true,method:'PUT',body:JSON.stringify({name,revision:folder.revision})});
      if (current !== generation || renameFolder !== folder) return;
      cancelRename(); await loadFolders(); if (current === generation) await loadFolder(folder.id);
    } catch (error) {
      if (current === generation) {
        report('rename-status', error);
        if (error.status === 409) {
          el('rename-reload').hidden = false;
          el('rename-status').textContent = 'This folder changed. Reload it to review and save your name.';
        }
      }
    }
    finally { submit.disabled = el('rename-cancel').disabled = false; }
  });
  el('copy-link')?.addEventListener('click', async () => {
    if (!selected || !currentFolder) return;
    try { await navigator.clipboard.writeText(el('folder-link').value); el('copy-status').textContent = 'Link copied'; }
    catch { el('folder-link').focus(); el('folder-link').select(); el('copy-status').textContent = 'Select and copy this link'; }
  });
  (async () => {
    const initialGeneration = generation;
    try {
      const { account } = await request('/api/account');
      if (account.quotaClass === 'guest') { status.textContent = 'Sign in with your CUNY account to open your classes.'; el('login').hidden = false; return; }
      window.StemSessionGuard?.start(account.subject, clearCourse);
      choiceKey = `stem-workspace-choice:v1:${account.subject}`;
      let cursor = null; const seen = new Set();
      do {
        const data = await request(`/api/classroom/courses${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
        courses.push(...data.courses); cursor = data.nextCursor;
        if (cursor && (seen.has(cursor) || seen.size >= 9)) throw new Error('Class access could not be fully checked. Reload to try again.');
        if (cursor) seen.add(cursor);
      } while (cursor);
      courses.sort((a,b) => Number(a.classId === 'cail-teaching-tools-demo') - Number(b.classId === 'cail-teaching-tools-demo') || a.className.localeCompare(b.className));
      el('course').append(...courses.map(course => new Option(`${course.className} · ${course.term} · ${course.section}`, course.classId)));
      document.getElementById('course-discovery').hidden = !courses.length;
      status.textContent = courses.length ? 'Choose a class to view its shared work.' : 'No current classes are available to this account.';
      const requested = new URLSearchParams(location.search).get('course');
      let prior = null; try { prior = localStorage.getItem(choiceKey); } catch {}
      const choice = courses.find(course => course.classId === requested) || courses.find(course => course.classId === prior) || (courses.length === 1 ? courses[0] : null);
      if (choice) { el('course').value = choice.classId; await selectCourse(choice.classId); }
    } catch (error) {
      if (initialGeneration !== generation) return;
      clearCourse(); status.textContent = error.message; el('login').hidden = Boolean(choiceKey);
    }
  })();
})();
