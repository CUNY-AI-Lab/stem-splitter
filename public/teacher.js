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
const fixedPromptScroll = document.getElementById('fixed-prompt-scroll');
const fixedPromptBody = document.getElementById('fixed-prompt-body');
const fixedPromptToggle = document.getElementById('fixed-prompt-toggle');
const fixedPromptToggleLabel = document.getElementById('fixed-prompt-toggle-label');

const previewBtn = document.getElementById('preview-btn');
const previewWrap = document.getElementById('preview-wrap');
const previewBody = document.getElementById('preview-body');

const historyList = document.getElementById('prompt-history');
const historyEmpty = document.getElementById('prompt-history-empty');

let maxChars = 2000;
let maxChangeNoteChars = 240;
let loadedAmendment = '';
let loadedRevision = 0;
let showingPromptTop = false;

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(body.error || `Request failed (${res.status})`), {
      status: res.status,
    });
  }
  return body;
}

function showPanel(signedIn, teacher) {
  signinPanel.hidden = signedIn;
  consolePanel.hidden = !signedIn;
  if (signedIn) teacherWho.textContent = `SIGNED IN AS ${teacher.displayName.toUpperCase()}`;
}

function showStatus(message, isError = false) {
  promptStatus.hidden = !message;
  promptStatus.textContent = message;
  promptStatus.classList.toggle('error', isError);
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
  amendmentCount.textContent = `${used} / ${maxChars} APPENDED`;
  amendmentCount.classList.toggle('error', used > maxChars);

  const noteUsed = changeNote.value.trim().length;
  changeNoteCount.textContent = `${noteUsed} / ${maxChangeNoteChars} NOTE`;
  changeNoteCount.classList.toggle('error', noteUsed > maxChangeNoteChars);
}

function paintMeta(record) {
  amendmentMeta.textContent = record.updatedBy
    ? `LAST EDITED BY ${record.updatedBy.toUpperCase()} · ${formatUtc(record.updatedAt)}`
    : 'NO RUNTIME EDITS YET';
  fixedPromptMeta.textContent =
    `${record.basePromptVersion} · ${shortHash(record.basePromptHash)}`;
  fixedPromptMeta.title = `Base prompt SHA-256: ${record.basePromptHash || 'unavailable'}`;
  effectivePromptMeta.textContent = `EFFECTIVE · ${shortHash(record.effectivePromptHash)}`;
  effectivePromptMeta.title =
    `Effective prompt SHA-256: ${record.effectivePromptHash || 'unavailable'}`;
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
  fixedPromptToggleLabel.textContent = 'SEE THE TOP OF THE FIXED PROMPT';
  fixedPromptScroll.scrollTo({ top: fixedPromptScroll.scrollHeight, behavior: 'smooth' });
}

function showPromptTop() {
  showingPromptTop = true;
  fixedPromptToggle.setAttribute('aria-expanded', 'true');
  fixedPromptToggleLabel.textContent = 'RETURN TO THE END OF THE FIXED PROMPT';
  fixedPromptScroll.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderHistory(history) {
  historyList.replaceChildren();
  historyEmpty.hidden = history.length > 0;

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
      `Base SHA-256: ${revision.basePromptHash}\nEffective SHA-256: ${revision.effectivePromptHash}`;

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
}

async function loadPrompt() {
  const record = await api('/api/teacher/prompt');
  maxChars = record.maxChars ?? maxChars;
  maxChangeNoteChars = record.maxChangeNoteChars ?? maxChangeNoteChars;
  amendment.maxLength = maxChars;
  changeNote.maxLength = maxChangeNoteChars;
  amendment.value = record.amendment || '';
  loadedAmendment = amendment.value.trim();
  loadedRevision = record.revision ?? 0;
  renderPromptMarkdown(record.basePrompt || '', fixedPromptBody);
  paintCounts();
  paintMeta(record);
  renderHistory(record.history || []);
  requestAnimationFrame(() => {
    fixedPromptScroll.scrollTop = fixedPromptScroll.scrollHeight;
  });
}

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
  await api('/api/teacher/logout', { method: 'POST' }).catch(() => {});
  showPanel(false);
});

amendment.addEventListener('input', paintCounts);
changeNote.addEventListener('input', paintCounts);

fixedPromptToggle.addEventListener('click', () => {
  if (showingPromptTop) showPromptEnd();
  else showPromptTop();
});

promptForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const nextAmendment = amendment.value.trim();
  const changed = nextAmendment !== loadedAmendment;
  if (changed && !changeNote.value.trim()) {
    showStatus('ADD A CHANGELOG NOTE BEFORE SAVING THIS REVISION.', true);
    changeNote.focus();
    return;
  }

  showStatus('SAVING…');
  try {
    const record = await api('/api/teacher/prompt', {
      method: 'PUT',
      body: JSON.stringify({
        amendment: amendment.value,
        changeNote: changeNote.value,
        expectedRevision: loadedRevision,
      }),
    });

    if (!record.changed) {
      showStatus('NO CONTENT CHANGE — NO REVISION CREATED.');
      return;
    }

    changeNote.value = '';
    await loadPrompt();
    showStatus(
      record.guidesCleared
        ? `REVISION ${record.revision.settingsRevision} SAVED — ${record.guidesCleared} CACHED GUIDE(S) CLEARED.`
        : `REVISION ${record.revision.settingsRevision} SAVED.`
    );
    if (!previewWrap.hidden) await loadPreview();
  } catch (error) {
    showStatus(error.message, true);
  }
});

async function loadPreview() {
  const { prompt } = await api('/api/teacher/prompt/preview');
  renderPromptMarkdown(prompt, previewBody);
}

previewBtn.addEventListener('click', async () => {
  try {
    await loadPreview();
    previewWrap.hidden = false;
    previewWrap.open = true;
    previewWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    showStatus(error.message, true);
  }
});

(async function init() {
  try {
    const teacher = await api('/api/teacher/me');
    await loadPrompt();
    showPanel(true, teacher);
  } catch {
    showPanel(false);
  }
})();
