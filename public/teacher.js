// Instructor console: sign in, edit the Listening Guy prompt amendment.
// The session is an HttpOnly cookie, so nothing here touches localStorage —
// there is no token for a shared classroom browser to leak.

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
const promptStatus = document.getElementById('prompt-status');
const previewBtn = document.getElementById('preview-btn');
const previewWrap = document.getElementById('preview-wrap');
const previewBody = document.getElementById('preview-body');

let maxChars = 2000;

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status });
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

function paintCount() {
  const used = amendment.value.trim().length;
  amendmentCount.textContent = `${used} / ${maxChars}`;
  amendmentCount.classList.toggle('error', used > maxChars);
}

function paintMeta(record) {
  amendmentMeta.textContent = record.updatedBy
    ? `LAST EDITED BY ${record.updatedBy.toUpperCase()} · ${record.updatedAt} UTC`
    : 'NEVER EDITED';
}

async function loadPrompt() {
  const record = await api('/api/teacher/prompt');
  maxChars = record.maxChars ?? maxChars;
  amendment.value = record.amendment || '';
  paintCount();
  paintMeta(record);
}

signinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
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
    // Load before revealing: showing the panel first lets a fast typist start
    // editing, and the in-flight fetch would then overwrite what they typed.
    await loadPrompt();
    showPanel(true, teacher);
  } catch (err) {
    signinError.hidden = false;
    signinError.textContent = err.message;
  }
});

signoutBtn.addEventListener('click', async () => {
  await api('/api/teacher/logout', { method: 'POST' }).catch(() => {});
  showPanel(false);
});

amendment.addEventListener('input', paintCount);

promptForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showStatus('SAVING…');
  try {
    const record = await api('/api/teacher/prompt', {
      method: 'PUT',
      body: JSON.stringify({ amendment: amendment.value }),
    });
    paintMeta(record);
    // Cached guides were written under the old prompt, so the save clears them.
    showStatus(
      record.guidesCleared
        ? `SAVED — ${record.guidesCleared} cached guide(s) cleared; they regenerate on next open.`
        : 'SAVED.'
    );
    if (!previewWrap.hidden) await loadPreview();
  } catch (err) {
    showStatus(err.message, true);
  }
});

async function loadPreview() {
  const { prompt } = await api('/api/teacher/prompt/preview');
  previewBody.textContent = prompt;
}

previewBtn.addEventListener('click', async () => {
  try {
    await loadPreview();
    previewWrap.hidden = false;
    previewWrap.open = true;
    previewWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    showStatus(err.message, true);
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
