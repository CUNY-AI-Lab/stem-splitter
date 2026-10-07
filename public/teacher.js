// Instructor console: authenticate, inspect the code-owned prompt, and edit
// only the versioned class amendment. The session lives in an HttpOnly cookie;
// no credential or session token is stored in browser storage.

const signinPanel = document.getElementById('signin-panel');
const signinForm = document.getElementById('signin-form');
const signinError = document.getElementById('signin-error');
const consolePanel = document.getElementById('console-panel');
const teacherWho = document.getElementById('teacher-who');
const signoutBtn = document.getElementById('signout');

const promptForm = document.getElementById('prompt-form');
const amendment = document.getElementById('amendment');
const amendmentCount = document.getElementById('amendment-count');
const amendmentMeta = document.getElementById('amendment-meta');
const changeNote = document.getElementById('change-note');
const changeNoteCount = document.getElementById('change-note-count');
const promptStatus = document.getElementById('prompt-status');
const effectivePromptMeta = document.getElementById('effective-prompt-meta');

const fixedPromptMeta = document.getElementById('fixed-prompt-meta');
const fixedPromptDetails = document.getElementById('fixed-prompt-details');
const fixedPromptScroll = document.getElementById('fixed-prompt-scroll');
const fixedPromptBody = document.getElementById('fixed-prompt-body');
const fixedPromptToggle = document.getElementById('fixed-prompt-toggle');
const fixedPromptToggleLabel = document.getElementById('fixed-prompt-toggle-label');

const previewBtn = document.getElementById('preview-btn');
const previewWrap = document.getElementById('preview-wrap');
const previewBody = document.getElementById('preview-body');

const historyList = document.getElementById('prompt-history');
const historyEmpty = document.getElementById('prompt-history-empty');
const historyMoreBtn = document.getElementById('prompt-history-more');

let maxChars = 2000;
let maxChangeNoteChars = 240;
let loadedAmendment = '';
let loadedRevision = 0;
let showingPromptTop = false;
let historyNextBeforeId = null;
let historyLoading = false;
let selectedCourse=null;
let courseMode=false;
let promptGeneration=0, activePrompt=null, loadedPrompt=null, promptSaving=false;
let previewSequence=0, historySequence=0;
const reloadPromptBtn=document.getElementById('prompt-reload');
const currentPrompt=context=>context&&context===activePrompt&&context.course===(courseMode?selectedCourse:null);
const promptPath=(context,suffix='')=>context.course?`/api/classroom/courses/${encodeURIComponent(context.course)}/prompt${suffix}`:`/api/teacher/prompt${suffix}`;
function enablePrompt(enabled){
  for(const control of promptForm.querySelectorAll('input,textarea,button'))control.disabled=!enabled;
  historyMoreBtn.disabled=!enabled||historyLoading;
}
function clearPrompt(){
  loadedPrompt=null;loadedAmendment='';loadedRevision=0;promptSaving=false;historyLoading=false;
  previewSequence++;historySequence++;promptForm.reset();enablePrompt(false);historyMoreBtn.textContent='LOAD EARLIER REVISIONS';
  amendmentMeta.textContent='';fixedPromptMeta.textContent='';effectivePromptMeta.textContent='';
  fixedPromptBody.replaceChildren();previewBody.replaceChildren();previewWrap.hidden=true;previewWrap.open=false;
  renderHistory([]);setHistoryPagination(false,null);paintCounts();reloadPromptBtn.hidden=true;
}


async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  window.StemSessionGuard?.observe(res);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(body.error?.message || body.error || `Request failed (${res.status})`), {
      status: res.status,
    });
  }
  return body;
}

function showPanel(signedIn, teacher) {
  signinPanel.hidden = signedIn;
  consolePanel.hidden = !signedIn;
  if (signedIn) {
    const displayName = String(teacher.displayName || '').trim();
    teacherWho.textContent = /^instructor$/i.test(displayName) ? '' : displayName;
  }
}

function showStatus(message, isError = false) {
  promptStatus.hidden = !message;
  promptStatus.textContent = message;
  promptStatus.classList.toggle('error', isError);
}

function clearTeacherConsole() {
  activePrompt=null;promptGeneration++;clearPrompt();
  signinForm.reset();
  promptForm.reset();
  loadedAmendment = '';
  loadedRevision = 0;
  teacherWho.textContent = '';
  fixedPromptMeta.textContent = '';
  fixedPromptMeta.removeAttribute('title');
  effectivePromptMeta.textContent = '';
  effectivePromptMeta.removeAttribute('title');
  amendmentMeta.textContent = '';
  fixedPromptBody.replaceChildren();
  previewBody.replaceChildren();
  previewWrap.hidden = true;
  previewWrap.open = false;
  renderHistory([]);
  setHistoryPagination(false, null);
  showingPromptTop = false;
  fixedPromptToggle.setAttribute('aria-expanded', 'false');
  fixedPromptToggleLabel.textContent = 'TOP';
  paintCounts();
  showStatus('');
}

function shortHash(value) {
  return typeof value === 'string' && value ? value.slice(0, 12) : '—';
}

function formatUtc(value) {
  if (!value) return '—';
  const normalized = /(?:Z|[+-]\d\d:?\d\d)$/.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }) + ' UTC';
}

function paintCounts() {
  const used = amendment.value.trim().length;
  amendmentCount.textContent = `${used} / ${maxChars}`;
  amendmentCount.classList.toggle('error', used > maxChars);

  const noteUsed = changeNote.value.trim().length;
  changeNoteCount.textContent = `${noteUsed} / ${maxChangeNoteChars}`;
  changeNoteCount.classList.toggle('error', noteUsed > maxChangeNoteChars);
}

function paintMeta(record) {
  amendmentMeta.textContent = record.updatedBy
    ? `Saved by ${record.updatedBy} · ${formatUtc(record.updatedAt)}`
    : '';
  fixedPromptMeta.textContent = record.basePromptVersion;
  effectivePromptMeta.textContent = record.revision ? `Revision ${record.revision}` : '';
}

function appendWords(element, text) {
  if (element.textContent) element.append(document.createTextNode(' '));
  element.append(document.createTextNode(text));
}

/**
 * Render the prompt as readable Markdown-like structure without using
 * innerHTML. The production prompt remains plain text; this is a safe,
 * presentation-only view of headings, numbered rules, bullets, and paragraphs.
 */
function renderPromptMarkdown(text, target) {
  target.replaceChildren();
  let list = null;
  let listType = '';
  let item = null;
  let paragraph = null;

  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      list = null;
      listType = '';
      item = null;
      paragraph = null;
      continue;
    }

    const heading =
      trimmed.length < 100 &&
      (/^[A-Z][A-Z0-9 ’'"():,\/—-]+$/.test(trimmed) ||
        /^[A-Z][A-Z ]{4,}(?:\(|—)/.test(trimmed)) &&
      !/[.!?]$/.test(trimmed);
    if (heading) {
      list = null;
      listType = '';
      item = null;
      paragraph = null;
      const h = document.createElement('h4');
      h.textContent = trimmed;
      target.appendChild(h);
      continue;
    }

    const bullet = /^-\s+(.+)$/.exec(trimmed);
    const numbered = /^(\d+)\.\s+(.+)$/.exec(trimmed);
    if (bullet || numbered) {
      const nextType = bullet ? 'ul' : 'ol';
      if (!list || listType !== nextType) {
        list = document.createElement(nextType);
        target.appendChild(list);
        listType = nextType;
      }
      item = document.createElement('li');
      item.textContent = bullet ? bullet[1] : numbered[2];
      list.appendChild(item);
      paragraph = null;
      continue;
    }

    if (item && /^\s+/.test(raw)) {
      appendWords(item, trimmed);
      continue;
    }

    list = null;
    listType = '';
    item = null;
    if (!paragraph) {
      paragraph = document.createElement('p');
      target.appendChild(paragraph);
    }
    appendWords(paragraph, trimmed);
  }
}

function showPromptEnd() {
  showingPromptTop = false;
  fixedPromptToggle.setAttribute('aria-expanded', 'false');
  fixedPromptToggleLabel.textContent = 'TOP';
  fixedPromptScroll.scrollTo({ top: fixedPromptScroll.scrollHeight, behavior: 'smooth' });
}

function showPromptTop() {
  showingPromptTop = true;
  fixedPromptToggle.setAttribute('aria-expanded', 'true');
  fixedPromptToggleLabel.textContent = 'END';
  fixedPromptScroll.focus({ preventScroll: true });
  fixedPromptScroll.scrollTo({ top: 0, behavior: 'smooth' });
  requestAnimationFrame(() => {
    fixedPromptScroll.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function renderHistory(history, append = false) {
  if (!append) historyList.replaceChildren();

  for (const revision of history) {
    const item = document.createElement('li');
    item.className = 'teacher-history-item';

    const head = document.createElement('div');
    head.className = 'teacher-history-head';

    const title = document.createElement('strong');
    title.textContent = `REVISION ${revision.settingsRevision} · ${revision.changeNote}`;
    const time = document.createElement('span');
    time.className = 'mono';
    time.textContent = formatUtc(revision.createdAt);
    head.append(title, time);

    const trace = document.createElement('p');
    trace.className = 'teacher-history-trace mono';
    trace.textContent =
      `${revision.updatedBy.toUpperCase()} · BASE ${revision.basePromptVersion} ` +
      `${shortHash(revision.basePromptHash)} · EFFECTIVE ${shortHash(revision.effectivePromptHash)}`;
    trace.title =
      `Base policy SHA-256: ${revision.basePromptHash}\n` +
      `Effective policy SHA-256: ${revision.effectivePromptHash}`;

    const details = document.createElement('details');
    details.className = 'teacher-history-details';
    const summary = document.createElement('summary');
    summary.className = 'mono';
    summary.textContent = revision.amendment
      ? 'VIEW APPENDED SNAPSHOT'
      : 'VIEW EMPTY APPENDIX SNAPSHOT';
    const body = document.createElement('div');
    body.className = 'teacher-markdown teacher-history-snapshot';
    if (revision.amendment) {
      renderPromptMarkdown(revision.amendment, body);
    } else {
      const empty = document.createElement('p');
      empty.textContent = 'No appended class instructions.';
      body.appendChild(empty);
    }
    details.append(summary, body);
    item.append(head, trace, details);
    historyList.appendChild(item);
  }
  historyEmpty.hidden = historyList.children.length > 0;
}

function setHistoryPagination(hasMore, nextBeforeId) {
  historyNextBeforeId = hasMore && Number.isSafeInteger(nextBeforeId)
    ? nextBeforeId
    : null;
  historyMoreBtn.hidden = historyNextBeforeId === null;
}

async function loadPrompt() {
  const context={course:courseMode?selectedCourse:null,generation:++promptGeneration};
  activePrompt=context;clearPrompt();showStatus('Loading course instructions…');
  try {
    const record=await api(promptPath(context));
    if(!currentPrompt(context))return null;
    maxChars=record.maxChars??maxChars;maxChangeNoteChars=record.maxChangeNoteChars??maxChangeNoteChars;
    amendment.maxLength=maxChars;changeNote.maxLength=maxChangeNoteChars;
    amendment.value=record.amendment||'';loadedAmendment=amendment.value.trim();loadedRevision=record.revision??0;
    renderPromptMarkdown(record.basePrompt||'',fixedPromptBody);paintCounts();paintMeta(record);
    renderHistory(record.history||[]);setHistoryPagination(record.historyHasMore,record.historyNextBeforeId);
    loadedPrompt=context;enablePrompt(true);showStatus('');
    requestAnimationFrame(()=>{if(currentPrompt(context))fixedPromptScroll.scrollTop=fixedPromptScroll.scrollHeight;});
    return context;
  } catch(error) {
    if(currentPrompt(context)){enablePrompt(false);reloadPromptBtn.hidden=false;showStatus(error.message,true);}
    throw error;
  }
}
reloadPromptBtn.addEventListener('click',()=>{void loadPrompt().catch(()=>{});});

signinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  signinError.hidden = true;
  try {
    const teacher = await api('/api/teacher/login', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('signin-username').value,
        password: document.getElementById('signin-password').value,
      }),
    });
    document.getElementById('signin-password').value = '';
    await loadPrompt();
    showPanel(true, teacher);
  } catch (error) {
    signinError.hidden = false;
    signinError.textContent = error.message;
  }
});

signoutBtn.addEventListener('click', async () => {
  signoutBtn.disabled = true;
  try {
    await api('/api/teacher/logout', { method: 'POST' });
    clearTeacherConsole();
    showPanel(false);
  } catch {
    showStatus('Sign out failed. Your session may still be active. Try again.', true);
  } finally {
    signoutBtn.disabled = false;
  }
});


amendment.addEventListener('input', paintCounts);
changeNote.addEventListener('input', paintCounts);

fixedPromptToggle.addEventListener('click', () => {
  if (showingPromptTop) showPromptEnd();
  else showPromptTop();
});

fixedPromptDetails.addEventListener('toggle', () => {
  if (!fixedPromptDetails.open) return;
  requestAnimationFrame(showPromptEnd);
});

promptForm.addEventListener('submit', async event => {
  event.preventDefault();
  let context=loadedPrompt;
  if(!currentPrompt(context)||promptSaving)return;
  const changed=amendment.value.trim()!==loadedAmendment;
  if(changed&&!changeNote.value.trim()){showStatus('Add a change note before saving.',true);changeNote.focus();return;}
  const payload={amendment:amendment.value,changeNote:changeNote.value,expectedRevision:loadedRevision};
  promptSaving=true;enablePrompt(false);previewSequence++;historySequence++;showStatus('SAVING…');
  try {
    const record=await api(promptPath(context),{method:'PUT',body:JSON.stringify(payload)});
    if(!currentPrompt(context))return;
    if(!record.changed){showStatus('Nothing changed.');return;}
    context=await loadPrompt();
    if(currentPrompt(context))showStatus(record.guidesCleared?'Saved. Applies when a guide is generated.':'Saved.');
  } catch(error) {
    if(currentPrompt(context))showStatus(error.message,true);
  } finally {
    if(currentPrompt(context)){promptSaving=false;enablePrompt(loadedPrompt===context);}
  }
});

previewBtn.addEventListener('click', async () => {
  const context=loadedPrompt,sequence=++previewSequence;
  if(!currentPrompt(context)||promptSaving)return;
  previewBtn.disabled=true;
  try {
    const {prompt}=await api(promptPath(context,'/preview'));
    if(!currentPrompt(context)||sequence!==previewSequence)return;
    renderPromptMarkdown(prompt,previewBody);previewWrap.hidden=false;previewWrap.open=true;
    previewWrap.scrollIntoView({behavior:'smooth',block:'nearest'});
  } catch(error) {
    if(currentPrompt(context)&&sequence===previewSequence)showStatus(error.message,true);
  } finally {
    if(currentPrompt(context)&&sequence===previewSequence)previewBtn.disabled=false;
  }
});

historyMoreBtn.addEventListener('click', async () => {
  const context=loadedPrompt,sequence=++historySequence;
  if(!currentPrompt(context)||promptSaving||historyLoading||historyNextBeforeId===null)return;
  historyLoading=true;historyMoreBtn.disabled=true;historyMoreBtn.textContent='LOADING EARLIER REVISIONS…';
  try {
    const page=await api(promptPath(context,`/history?before=${encodeURIComponent(historyNextBeforeId)}`));
    if(!currentPrompt(context)||sequence!==historySequence)return;
    renderHistory(page.history||[],true);setHistoryPagination(page.historyHasMore,page.historyNextBeforeId);
  } catch(error) {
    if(currentPrompt(context)&&sequence===historySequence)showStatus(error.message,true);
  } finally {
    if(currentPrompt(context)&&sequence===historySequence){historyLoading=false;historyMoreBtn.disabled=false;historyMoreBtn.textContent='LOAD EARLIER REVISIONS';}
  }
});

(async function init() {
  let cail = false;
  try {
    const runtime = await api('/api/runtime');
    cail = runtime.authMode === 'cail';
    if (cail) {
      signinForm.hidden = true;
      signoutBtn.hidden = true;
      const message = document.createElement('p');
      message.textContent = 'Sign in with your CUNY account to open guide instructions.';
      signinPanel.append(message);
      if (runtime.loginUrl) {
        const link = document.createElement('a');
        link.className = 'account-button';
        link.href = `${runtime.loginUrl}?next=/teacher.html`;
        link.textContent = 'CUNY Login';
        signinPanel.append(link);
      }
    }
    if(cail){
      const {account}=await api('/api/account');window.StemSessionGuard?.start(account.subject,()=>{selectedCourse=null;courseMode=false;activePrompt=null;promptGeneration++;clearTeacherConsole();});
      const courses=[];let cursor=null;
      do{const page=await api('/api/classroom/courses'+(cursor?`?cursor=${encodeURIComponent(cursor)}`:''));courses.push(...page.courses.filter(course=>course.owner));cursor=page.nextCursor;}while(cursor);
      if(!courses.length){showPanel(false);signinPanel.querySelector('p').textContent='Current course ownership is required to review students or edit course instructions.';return;}
      courseMode=true;const select=document.getElementById('teacher-course');
      for(const course of courses)select.add(new Option(`${course.className} · ${course.term} · ${course.section}`,course.classId));
      const requested=new URLSearchParams(location.search).get('course');selectedCourse=courses.some(c=>c.classId===requested)?requested:courses[0].classId;select.value=selectedCourse;
      document.getElementById('teacher-courses').hidden=false;
      const setRoster=()=>{window.StemUsage?.setCourse(selectedCourse);document.getElementById('teacher-roster').href=`/classroom.html?course=${encodeURIComponent(selectedCourse)}`;};setRoster();
      select.addEventListener('change',async()=>{
        if(amendment.value.trim()!==loadedAmendment&&!confirm('Discard unsaved course instructions?')){select.value=selectedCourse;return;}
        selectedCourse=select.value;setRoster();try{await loadPrompt();}catch{/* The current load owns its error state. */}
      });
      showPanel(true,{displayName:courses.find(c=>c.classId===selectedCourse).displayName||'Instructor'});await loadPrompt().catch(()=>{});return;
    }
    const { teacher } = await api('/api/teacher/me');
    if (!teacher) {
      showPanel(false);
      if (cail) signinPanel.querySelector('p').textContent = 'Instructor access is required to edit guide instructions.';
      return;
    }
    await loadPrompt();
    showPanel(true, teacher);
  } catch {
    showPanel(false);
  }
})();
