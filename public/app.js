// Stem Splitter frontend: presigned upload to R2 → create job → poll status →
// synchronized stem mixer (all stems play together; per-stem mute).

const POLL_INTERVAL_MS = 5000;
const STEM_ORDER = ['vocals', 'instrumental', 'drums', 'bass', 'other', 'guitar', 'piano'];

// --- class code ---------------------------------------------------------

function getClassCode() {
  return localStorage.getItem('classCode') || '';
}

const classCodeDialog = document.getElementById('class-code-dialog');
const classCodeForm = document.getElementById('class-code-form');
const classCodeInput = document.getElementById('class-code-input');
const classCodeMessage = document.getElementById('class-code-message');
const classCodeCancel = document.getElementById('class-code-cancel');
let pendingClassCodeRequest = null;

function requestClassCode(message) {
  if (pendingClassCodeRequest) return pendingClassCodeRequest;

  pendingClassCodeRequest = new Promise((resolve) => {
    classCodeMessage.textContent = message;
    classCodeInput.value = '';

    const finish = (code) => {
      classCodeForm.removeEventListener('submit', submit);
      classCodeCancel.removeEventListener('click', cancel);
      classCodeDialog.removeEventListener('cancel', cancel);
      classCodeDialog.close();
      pendingClassCodeRequest = null;
      resolve(code);
    };
    const submit = (event) => {
      event.preventDefault();
      finish(classCodeInput.value.trim());
    };
    const cancel = (event) => {
      event.preventDefault();
      finish('');
    };

    classCodeForm.addEventListener('submit', submit);
    classCodeCancel.addEventListener('click', cancel);
    classCodeDialog.addEventListener('cancel', cancel);
    classCodeDialog.showModal();
    classCodeInput.focus();
  });

  return pendingClassCodeRequest;
}

// In-page verify loop at page load: keeps asking until the server accepts
// the code, so a typo fails here instead of on the student's first upload.
async function ensureClassCode() {
  let message = 'Enter your class code to upload and split tracks.';
  for (;;) {
    let code = getClassCode();
    if (!code) {
      code = await requestClassCode(message);
      if (!code) return; // cancelled — playback of shared links still works; writes will 401
      localStorage.setItem('classCode', code);
    }
    try {
      const res = await fetch('/api/auth-check', { headers: { 'x-class-code': code } });
      if (res.status !== 401) return;
    } catch {
      return; // network hiccup — don't lock anyone out; the first write re-checks anyway
    }
    localStorage.removeItem('classCode');
    message = 'That class code was not accepted. Try again.';
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-class-code': getClassCode(),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    localStorage.removeItem('classCode');
    void ensureClassCode();
    throw new Error('Invalid class code — enter it and retry.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// --- local job list -------------------------------------------------------

function getJobs() {
  try {
    return JSON.parse(localStorage.getItem('jobs') || '[]');
  } catch {
    return [];
  }
}

function saveJobs(jobs) {
  localStorage.setItem('jobs', JSON.stringify(jobs));
}

function addJob(job) {
  const jobs = getJobs();
  jobs.unshift({
    id: job.id,
    filename: job.filename,
    model: job.model,
    expectedStems: job.expectedStems || [],
  });
  saveJobs(jobs.slice(0, 50));
}

// --- upload flow ----------------------------------------------------------

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const uploadStatus = document.getElementById('upload-status');
const progressBar = document.getElementById('progress-bar');
const uploadMessage = document.getElementById('upload-message');

const ytForm = document.getElementById('yt-form');
const ytUrlInput = document.getElementById('yt-url');
const ytFetchButton = ytForm.querySelector('button[type="submit"]');
const stemChoice = document.getElementById('stem-choice');
const splitSummary = document.getElementById('split-summary');
const engineSummary = document.getElementById('engine-summary');
let separationOptionsReady;
let youtubeFetchInProgress = false;

function selectedModel() {
  return document.querySelector('input[name="stem-model"]:checked')?.value || '';
}

async function requireSelectedModel() {
  await separationOptionsReady;
  const model = selectedModel();
  if (!model) throw new Error('Split choices are unavailable. Reload the page and try again.');
  return model;
}

async function loadSeparationOptions() {
  try {
    const res = await fetch('/api/separation-options');
    if (!res.ok) throw new Error('Split choices request failed');
    const options = await res.json();
    if (
      !Array.isArray(options.models) ||
      !options.models.length ||
      options.models.some(
        (model) =>
          !model ||
          typeof model.id !== 'string' ||
          typeof model.label !== 'string' ||
          typeof model.engine !== 'string' ||
          !model.engine.trim() ||
          !Array.isArray(model.stems) ||
          !model.stems.length ||
          !model.stems.every((stem) => typeof stem === 'string')
      )
    ) {
      throw new Error('Split choices response was invalid');
    }

    stemChoice.replaceChildren();
    for (const model of options.models) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'stem-model';
      input.value = model.id;
      input.checked = model.id === options.defaultModel;
      const text = document.createElement('span');
      text.textContent = model.label;
      label.append(input, text);
      stemChoice.appendChild(label);
    }
    if (!selectedModel()) stemChoice.querySelector('input').checked = true;
    renderSeparationSummary(options.models);
    return true;
  } catch {
    stemChoice.innerHTML =
      '<span class="stem-choice-status mono">Split choices unavailable. Reload to try again.</span>';
    splitSummary.textContent = '// split choices unavailable';
    engineSummary.textContent = 'SEPARATION MODELS: UNAVAILABLE';
    return false;
  }
}

function renderSeparationSummary(models) {
  const trackCounts = [...new Set(models.map((model) => model.stems.length))].sort(
    (a, b) => a - b
  );
  const engines = [...new Set(models.map((model) => model.engine.trim()))];
  splitSummary.textContent = `// produces ${formatList(trackCounts)} tracks per split`;
  engineSummary.textContent = `SEPARATION MODEL${engines.length === 1 ? '' : 'S'}: ${engines.join(
    ' / '
  )}`;
}

function formatList(values) {
  if (values.length < 2) return String(values[0] ?? '');
  if (values.length === 2) return `${values[0]} or ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, or ${values.at(-1)}`;
}

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') fileInput.click();
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
  fileInput.value = '';
});
['dragover', 'dragenter'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  })
);
dropzone.addEventListener('drop', (e) => {
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});

ytForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = ytUrlInput.value.trim();
  if (!url || youtubeFetchInProgress) return;

  youtubeFetchInProgress = true;
  ytForm.setAttribute('aria-busy', 'true');
  ytUrlInput.disabled = true;
  ytFetchButton.disabled = true;
  uploadStatus.hidden = false;
  progressBar.style.width = '0%';
  showUploadMessage('IMPORTING AUDIO FROM YOUTUBE…');

  try {
    const model = await requireSelectedModel();
    const job = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ youtubeUrl: url, model }),
    });
    ytUrlInput.value = '';
    addJob(job);
    showUploadMessage('PROCESSING — stems will appear in the rack below. First track after a quiet spell can take a couple of minutes while the model warms up.');
    renderJobs();
    pollSoon();
  } catch (err) {
    showUploadMessage(err.message, true);
  } finally {
    youtubeFetchInProgress = false;
    ytForm.removeAttribute('aria-busy');
    ytUrlInput.disabled = false;
    ytFetchButton.disabled = false;
  }
});

// --- internet archive crate ----------------------------------------------

const crateToggle = document.getElementById('crate-toggle');
const crateBody = document.getElementById('crate-body');
const crateForm = document.getElementById('crate-form');
const crateQuery = document.getElementById('crate-query');
const crateScope = document.getElementById('crate-scope');
const crateStatus = document.getElementById('crate-status');
const crateResults = document.getElementById('crate-results');
const cratePager = document.getElementById('crate-pager');
const cratePrev = document.getElementById('crate-prev');
const crateNext = document.getElementById('crate-next');
const cratePageLabel = document.getElementById('crate-page-label');

const CRATE_PAGE_SIZE = 24;
const crateState = { term: '', scope: 'music', page: 1, total: 0, busy: false };
// Monotonic request id: a slower earlier search must not clobber a newer one's
// results (which also silently collapsed any item the student had expanded).
let crateSeq = 0;
// Track lists are fetched once per item and reused when the row is re-opened.
const crateItems = new Map();

crateToggle.addEventListener('click', () => {
  const open = crateBody.hidden;
  crateBody.hidden = !open;
  crateToggle.setAttribute('aria-expanded', String(open));
  crateToggle.classList.toggle('open', open);
  if (open && crateResults.childElementCount === 0) void runCrateSearch(1);
});

crateForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void runCrateSearch(1);
});

cratePrev.addEventListener('click', () => void runCrateSearch(crateState.page - 1));
crateNext.addEventListener('click', () => void runCrateSearch(crateState.page + 1));

function showCrateStatus(message, isError = false) {
  crateStatus.hidden = !message;
  crateStatus.textContent = message;
  crateStatus.classList.toggle('error', isError);
}

async function runCrateSearch(page) {
  if (page < 1) return;
  // Deliberately not guarded on `busy`: dropping the request meant a student
  // who typed and hit SEARCH while the opening auto-search was still running
  // silently got the default results instead of theirs.
  const seq = ++crateSeq;

  crateState.busy = true;
  crateState.term = crateQuery.value.trim();
  crateState.scope = crateScope.value;
  crateForm.setAttribute('aria-busy', 'true');
  showCrateStatus('SEARCHING THE ARCHIVE…');

  try {
    const params = new URLSearchParams({
      q: crateState.term,
      scope: crateState.scope,
      page: String(page),
    });
    const data = await api(`/api/archive/search?${params}`);
    if (seq !== crateSeq) return; // superseded — leave the newer results alone

    crateState.page = data.page;
    crateState.total = data.total;
    crateItems.clear();
    renderCrateResults(data.results);

    if (data.results.length === 0) {
      showCrateStatus('No open-licensed audio matched that search.');
    } else {
      showCrateStatus(`${data.total.toLocaleString()} OPEN-LICENSED ITEMS MATCH`);
    }
  } catch (err) {
    if (seq !== crateSeq) return;
    crateResults.replaceChildren();
    cratePager.hidden = true;
    showCrateStatus(err.message, true);
  } finally {
    if (seq === crateSeq) {
      crateState.busy = false;
      crateForm.removeAttribute('aria-busy');
    }
  }
}

function renderCrateResults(results) {
  crateResults.replaceChildren();

  for (const result of results) {
    const li = document.createElement('li');
    li.className = 'crate-item';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'crate-item-head';
    head.setAttribute('aria-expanded', 'false');

    const title = document.createElement('span');
    title.className = 'crate-item-title';
    title.textContent = result.title;

    const meta = document.createElement('span');
    meta.className = 'crate-item-meta mono';
    meta.textContent = [result.creator, result.year].filter(Boolean).join(' · ');

    const license = document.createElement('span');
    license.className = 'crate-license';
    license.textContent = result.license;

    head.append(title, meta, license);

    const tracks = document.createElement('div');
    tracks.className = 'crate-tracks';
    tracks.hidden = true;

    head.addEventListener('click', () => {
      const open = tracks.hidden;
      tracks.hidden = !open;
      head.setAttribute('aria-expanded', String(open));
      head.classList.toggle('open', open);
      if (open) void loadCrateTracks(result, tracks);
    });

    li.append(head, tracks);
    crateResults.append(li);
  }

  const pages = Math.max(1, Math.ceil(Math.min(crateState.total, CRATE_PAGE_SIZE * 20) / CRATE_PAGE_SIZE));
  cratePager.hidden = results.length === 0;
  cratePageLabel.textContent = `PAGE ${crateState.page} / ${pages}`;
  cratePrev.disabled = crateState.page <= 1;
  crateNext.disabled = crateState.page >= pages;
}

async function loadCrateTracks(result, container) {
  if (crateItems.has(result.identifier)) {
    renderCrateTracks(crateItems.get(result.identifier), container);
    return;
  }

  container.replaceChildren(Object.assign(document.createElement('p'), {
    className: 'mono crate-loading',
    textContent: 'LOADING TRACKS…',
  }));

  try {
    const item = await api(`/api/archive/items/${encodeURIComponent(result.identifier)}`);
    crateItems.set(result.identifier, item);
    renderCrateTracks(item, container);
  } catch (err) {
    container.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'mono crate-loading error',
      textContent: err.message,
    }));
  }
}

function renderCrateTracks(item, container) {
  const list = document.createElement('ul');
  list.className = 'crate-track-list';

  for (const track of item.tracks) {
    const li = document.createElement('li');
    li.className = 'crate-track';

    const name = document.createElement('span');
    name.className = 'crate-track-name';
    name.textContent = track.title;

    const length = document.createElement('span');
    length.className = 'mono crate-track-len';
    length.textContent = track.durationSec ? fmt(track.durationSec) : '—';

    const split = document.createElement('button');
    split.type = 'button';
    split.className = 'crate-split';
    if (track.importable) {
      split.textContent = 'SPLIT';
      split.addEventListener('click', () => void importArchiveTrack(item, track, split));
    } else {
      split.textContent = 'TOO LONG';
      split.disabled = true;
      split.title = 'Tracks must be under 15 minutes and 100 MB.';
    }

    li.append(name, length, split);
    list.append(li);
  }

  const credit = document.createElement('p');
  credit.className = 'mono crate-credit';
  const link = document.createElement('a');
  link.href = item.detailsUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'view on archive.org';
  credit.append(
    document.createTextNode(`${item.license}${item.creator ? ` · ${item.creator}` : ''} · `),
    link
  );

  container.replaceChildren(list, credit);
}

async function importArchiveTrack(item, track, button) {
  button.disabled = true;
  button.textContent = 'FETCHING…';
  uploadStatus.hidden = false;
  progressBar.style.width = '0%';
  showUploadMessage(`IMPORTING "${track.title}" FROM THE INTERNET ARCHIVE…`);

  try {
    const model = await requireSelectedModel();
    const job = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ archiveId: item.identifier, archiveFile: track.name, model }),
    });

    addJob(job);
    showUploadMessage('PROCESSING — stems will appear in the rack below. First track after a quiet spell can take a couple of minutes while the model warms up.');
    renderJobs();
    pollSoon();
    button.textContent = 'QUEUED';
  } catch (err) {
    showUploadMessage(err.message, true);
    button.disabled = false;
    button.textContent = 'SPLIT';
  }
}

async function handleFile(file) {
  if (file.size > 100 * 1024 * 1024) {
    showUploadMessage('File too large (max 100 MB).', true);
    return;
  }

  uploadStatus.hidden = false;
  progressBar.style.width = '0%';
  showUploadMessage(`UPLOADING ${file.name}…`);

  try {
    const model = await requireSelectedModel();
    const { key, uploadUrl } = await api('/api/uploads', {
      method: 'POST',
      body: JSON.stringify({ filename: file.name }),
    });

    await putWithProgress(uploadUrl, file, (pct) => {
      progressBar.style.width = `${pct}%`;
    });

    showUploadMessage('STARTING SEPARATION…');
    const job = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ key, filename: file.name, model }),
    });

    addJob(job);
    showUploadMessage('PROCESSING — stems will appear in the rack below. First track after a quiet spell can take a couple of minutes while the model warms up.');
    renderJobs();
    pollSoon();
  } catch (err) {
    showUploadMessage(err.message, true);
  }
}

function putWithProgress(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    if (new URL(url, window.location.href).origin === window.location.origin) {
      xhr.setRequestHeader('x-class-code', getClassCode());
    }
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status})`));
    });
    xhr.addEventListener('error', () => reject(new Error('Upload failed — network error')));
    xhr.send(file);
  });
}

function showUploadMessage(message, isError = false) {
  uploadStatus.hidden = false;
  uploadMessage.textContent = message;
  uploadMessage.classList.toggle('error', isError);
}

// --- synchronized stem mixer ------------------------------------------------
//
// One Mixer per finished job. All stems are HTMLAudio elements driven from a
// single transport; the first stem is the master clock and the others are
// nudged back into sync if they drift more than 80 ms.

class Mixer {
  constructor(job) {
    this.job = job;
    this.audios = [];
    this.playing = false;
    this.annotations = [...(job.annotations || [])];
    this.channelsByName = new Map(); // canonical stem name -> { audio, row, muteBtn }
    this.chatHistory = []; // per-instance; survives re-renders via the mixers Map
    this.coachBusy = false;
    this.el = this.build();
  }

  build() {
    const stems = [...this.job.stems].sort(
      (a, b) => idx(STEM_ORDER, a.name) - idx(STEM_ORDER, b.name)
    );

    const li = document.createElement('li');
    li.className = 'console';
    li.innerHTML = `
      <div class="console-head">
        <span class="console-title">${esc(this.job.filename)}</span>
        <span class="badge ready">READY</span>
      </div>
      <div class="transport">
        <button class="play-btn" aria-label="Play all stems">▶</button>
        <span class="timecode tc-now">0:00</span>
        <div class="seek-wrap">
          <input class="seek" type="range" min="0" max="1000" value="0" aria-label="Seek" />
          <div class="markers" aria-hidden="false"></div>
        </div>
        <span class="timecode tc-end">·:··</span>
        <button class="note-btn" title="Add a note at the current time">＋&nbsp;NOTE</button>
      </div>
      <div class="channels"></div>
      <div class="notes" hidden></div>
      <div class="coach">
        <button class="coach-toggle" aria-expanded="false">
          <span class="coach-led"></span>LISTENING GUY<span class="coach-caret">▾</span>
        </button>
        <div class="coach-body" hidden>
          <div class="coach-guide"></div>
          <div class="coach-log" role="log" aria-live="polite"></div>
          <form class="coach-form">
            <input maxlength="500" placeholder="ask about this song…" aria-label="Ask the listening coach" />
            <button type="submit">ASK</button>
          </form>
        </div>
      </div>
    `;

    this.playBtn = li.querySelector('.play-btn');
    this.readyBadge = li.querySelector('.badge');
    this.seek = li.querySelector('.seek');
    this.tcNow = li.querySelector('.tc-now');
    this.tcEnd = li.querySelector('.tc-end');
    this.markers = li.querySelector('.markers');
    this.notes = li.querySelector('.notes');
    this.noteBtn = li.querySelector('.note-btn');
    this.noteBtn.addEventListener('click', () => this.addNote());

    this.coachToggle = li.querySelector('.coach-toggle');
    this.coachLed = li.querySelector('.coach-led');
    this.coachBody = li.querySelector('.coach-body');
    this.coachGuide = li.querySelector('.coach-guide');
    this.coachLog = li.querySelector('.coach-log');
    this.coachForm = li.querySelector('.coach-form');
    this.coachInput = this.coachForm.querySelector('input');
    this.coachToggle.addEventListener('click', () => {
      const open = this.coachBody.hidden;
      this.coachBody.hidden = !open;
      this.coachToggle.setAttribute('aria-expanded', String(open));
    });
    this.coachForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.coachInput.value.trim();
      if (text) this.sendChat(text);
    });
    // One delegated handler covers timecode buttons in the guide and every chat row.
    this.coachBody.addEventListener('click', (e) => {
      const tc = e.target.closest('.coach-tc');
      if (tc) this.seekTo(Number(tc.dataset.t));
    });

    const channels = li.querySelector('.channels');

    for (const stem of stems) {
      const audio = new Audio(stem.url);
      audio.preload = 'metadata';
      this.audios.push(audio);

      const row = document.createElement('div');
      row.className = 'channel';
      row.style.setProperty('--ch', `var(--c-${cssName(stem.name)}, var(--ink-dim))`);
      row.innerHTML = `
        <span class="ch-id"><span class="ch-dot"></span><span class="ch-name" tabindex="0" title="Click to rename">${esc(this.label(stem.name))}</span></span>
        <span class="meter" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
        <button class="mute-btn" aria-pressed="false" aria-label="Mute ${esc(this.label(stem.name))}">MUTE</button>
        <a class="dl" href="${stem.url}?download" title="Download ${esc(stem.name)}">↓</a>
      `;
      const muteBtn = row.querySelector('.mute-btn');
      const download = row.querySelector('.dl');
      this.channelsByName.set(stem.name, { audio, row, muteBtn, download });
      muteBtn.addEventListener('click', () => this.setMute(stem.name, !audio.muted));
      audio.addEventListener('error', () => this.markAudioUnavailable(stem.name));

      const nameEl = row.querySelector('.ch-name');
      nameEl.addEventListener('click', () => this.editLabel(stem.name, nameEl));
      nameEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.editLabel(stem.name, nameEl);
      });

      channels.appendChild(row);
    }

    const master = this.audios[0];
    master.addEventListener('loadedmetadata', () => {
      this.tcEnd.textContent = fmt(master.duration);
      this.renderMarkers();
    });
    master.addEventListener('ended', () => this.stop(true));

    this.playBtn.addEventListener('click', () => (this.playing ? this.pause() : this.play()));

    // Scrub smoothly: while dragging, only preview the timecode (paint() backs
    // off); the actual multi-stem seek happens once, on release ('change').
    this.scrubbing = false;
    this.seek.addEventListener('pointerdown', () => (this.scrubbing = true));
    this.seek.addEventListener('pointercancel', () => (this.scrubbing = false));
    this.seek.addEventListener('input', () => {
      this.scrubbing = true;
      const t = (this.seek.value / 1000) * (master.duration || 0);
      this.seek.style.setProperty('--fill', `${this.seek.value / 10}%`);
      this.tcNow.textContent = fmt(t);
    });
    this.seek.addEventListener('change', () => {
      const t = (this.seek.value / 1000) * (master.duration || 0);
      this.scrubbing = false;
      this.seekTo(t);
    });

    this.renderNotes();
    this.renderGuide();
    return li;
  }

  markAudioUnavailable(stemName) {
    const channel = this.channelsByName.get(stemName);
    if (!channel || channel.row.classList.contains('unavailable')) return;

    channel.audio.pause();
    channel.row.classList.add('unavailable');
    channel.muteBtn.disabled = true;
    channel.muteBtn.textContent = 'NO AUDIO';
    channel.download.removeAttribute('href');
    channel.download.setAttribute('aria-disabled', 'true');
    this.readyBadge.textContent = 'AUDIO ERROR';
    this.readyBadge.classList.remove('ready');
    this.readyBadge.classList.add('failed');
    this.playBtn.disabled = true;
  }

  async play() {
    this.audios.forEach((a) => (a.preload = 'auto'));
    try {
      await Promise.all(this.audios.map((a) => a.play()));
    } catch {
      return; // autoplay rejection — user can tap again
    }
    this.playing = true;
    this.playBtn.textContent = '❚❚';
    this.playBtn.classList.add('playing');
    this.el.classList.add('playing');
    this.tick();
    this.syncTimer = setInterval(() => this.resync(), 500);
  }

  pause() {
    this.audios.forEach((a) => a.pause());
    this.stopUi();
  }

  stop(reset) {
    this.audios.forEach((a) => {
      a.pause();
      if (reset) a.currentTime = 0;
    });
    this.stopUi();
    this.paint();
  }

  stopUi() {
    this.playing = false;
    this.playBtn.textContent = '▶';
    this.playBtn.classList.remove('playing');
    this.el.classList.remove('playing');
    clearInterval(this.syncTimer);
    cancelAnimationFrame(this.raf);
  }

  resync() {
    const t = this.audios[0].currentTime;
    for (const a of this.audios.slice(1)) {
      if (Math.abs(a.currentTime - t) > 0.08) a.currentTime = t;
    }
  }

  tick() {
    this.paint();
    if (this.playing) this.raf = requestAnimationFrame(() => this.tick());
  }

  paint() {
    if (this.scrubbing) return; // don't fight the user's drag
    const master = this.audios[0];
    const dur = master.duration || 0;
    const pct = dur ? (master.currentTime / dur) * 1000 : 0;
    this.seek.value = pct;
    this.seek.style.setProperty('--fill', `${pct / 10}%`);
    this.tcNow.textContent = fmt(master.currentTime);
  }

  label(name) {
    return (this.job.labels && this.job.labels[name]) || name;
  }

  editLabel(stemName, nameEl) {
    const input = document.createElement('input');
    input.className = 'ch-name-input';
    input.maxLength = 40;
    input.value = this.label(stemName);
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let finished = false;
    const done = async (save) => {
      if (finished) return;
      finished = true;
      const value = input.value.trim().slice(0, 40);
      input.replaceWith(nameEl);
      if (!save || !value || value === this.label(stemName)) return;

      this.job.labels = { ...(this.job.labels || {}), [stemName]: value };
      nameEl.textContent = value;
      try {
        await api(`/api/jobs/${this.job.id}/labels`, {
          method: 'PUT',
          body: JSON.stringify({ labels: this.job.labels }),
        });
      } catch (err) {
        showUploadMessage(err.message, true);
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true));
  }

  seekTo(t) {
    for (const a of this.audios) a.currentTime = t;
    this.paint();
  }

  renderMarkers() {
    const dur = this.audios[0].duration;
    this.markers.innerHTML = '';
    if (!dur || !isFinite(dur)) return;
    for (const note of this.annotations) {
      const m = document.createElement('button');
      m.className = 'marker';
      m.style.left = `${Math.min(100, (note.atSeconds / dur) * 100)}%`;
      m.setAttribute('aria-label', `Note at ${fmt(note.atSeconds)}: ${note.text}`);
      m.title = `${fmt(note.atSeconds)} — ${note.text}`;
      m.addEventListener('click', () => {
        this.seekTo(note.atSeconds);
        this.flashNote(note.id);
      });
      this.markers.appendChild(m);
    }
  }

  // Always-visible list of every annotation under the channels — read them
  // all without touching playback; the timecode is the deliberate "jump" act.
  renderNotes() {
    this.notes.innerHTML = '';
    this.notes.hidden = this.annotations.length === 0;
    for (const note of this.annotations) {
      const row = document.createElement('div');
      row.className = 'note-row';
      row.dataset.id = note.id;
      row.innerHTML = `
        <button class="note-time mono" title="Jump to this moment">${fmt(note.atSeconds)}</button>
        <span class="note-text">${esc(note.text)}</span>
        <button class="note-del" aria-label="Delete note" title="Delete note">✕</button>
      `;
      row.querySelector('.note-time').addEventListener('click', () => this.seekTo(note.atSeconds));
      row.querySelector('.note-del').addEventListener('click', () => this.deleteNote(note));
      this.notes.appendChild(row);
    }
  }

  async deleteNote(note) {
    this.annotations = this.annotations.filter((n) => n.id !== note.id);
    this.renderMarkers();
    this.renderNotes();
    try {
      await api(`/api/jobs/${this.job.id}/annotations/${note.id}`, { method: 'DELETE' });
    } catch (err) {
      this.annotations.push(note);
      this.annotations.sort((a, b) => a.atSeconds - b.atSeconds);
      this.renderMarkers();
      this.renderNotes();
      showUploadMessage(err.message, true);
    }
  }

  flashNote(id) {
    const row = this.notes.querySelector(`[data-id="${id}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    row.classList.remove('flash');
    void row.offsetWidth; // restart the animation
    row.classList.add('flash');
  }

  addNote() {
    if (this.el.querySelector('.note-form')) return;
    const t = this.audios[0].currentTime;
    const form = document.createElement('form');
    form.className = 'note-form';
    form.innerHTML = `
      <span class="mono note-form-time">${fmt(t)}</span>
      <input maxlength="200" placeholder="e.g. chorus starts — listen to the bass" aria-label="Note text" />
      <button type="submit">SAVE</button>
    `;
    this.el.querySelector('.transport').after(form);
    const input = form.querySelector('input');
    input.focus();

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') form.remove();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      form.remove();
      if (!text) return;
      try {
        await this.saveNote(t, text);
      } catch (err) {
        showUploadMessage(err.message, true);
      }
    });
  }

  // Shared by the ＋NOTE form and the coach's add_note tool — both hit the
  // authenticated annotations API and render markers/notes identically.
  async saveNote(atSeconds, text) {
    const note = await api(`/api/jobs/${this.job.id}/annotations`, {
      method: 'POST',
      body: JSON.stringify({ atSeconds, text }),
    });
    this.annotations.push(note);
    this.annotations.sort((a, b) => a.atSeconds - b.atSeconds);
    this.renderMarkers();
    this.renderNotes();
    this.flashNote(note.id);
    return note;
  }

  // --- listening guy panel ----------------------------------------------

  duration() {
    const d = this.audios[0].duration;
    return isFinite(d) && d > 0 ? d : undefined;
  }

  setLed(state) {
    this.coachLed.classList.toggle('ready', state === 'ready');
    this.coachLed.classList.toggle('busy', state === 'busy');
  }

  renderGuide() {
    this.coachGuide.innerHTML = '';
    if (this.job.guide && this.job.guide.text) {
      const div = document.createElement('div');
      div.className = 'coach-guide-text';
      div.innerHTML = this.linkifyTimecodes(this.job.guide.text);
      this.coachGuide.appendChild(div);
      this.setLed('ready');
      return;
    }
    const cue = document.createElement('div');
    cue.className = 'coach-cue';
    cue.innerHTML = `
      <button class="coach-cue-btn">CUE THE LISTENING GUIDE</button>
      <p class="coach-hint">One-time setup for this song — takes ~10–20 seconds.</p>
    `;
    cue.querySelector('.coach-cue-btn').addEventListener('click', () => this.requestGuide());
    this.coachGuide.appendChild(cue);
  }

  async requestGuide() {
    const btn = this.coachGuide.querySelector('.coach-cue-btn');
    const hint = this.coachGuide.querySelector('.coach-hint');
    if (btn) btn.disabled = true;
    if (hint) {
      hint.textContent = 'READING THE CHARTS…';
      hint.classList.remove('error');
    }
    this.setLed('busy');
    try {
      const res = await api(`/api/jobs/${this.job.id}/guide`, {
        method: 'POST',
        body: JSON.stringify({ durationSec: this.duration() }),
      });
      this.job.guide = res.guide;
      this.renderGuide();
    } catch (err) {
      this.setLed('idle');
      if (hint) {
        hint.textContent = err.message;
        hint.classList.add('error');
      }
      if (btn) btn.disabled = false;
    }
  }

  // Escape first, then turn m:ss timecodes into seek buttons (no markdown lib).
  linkifyTimecodes(text) {
    return esc(text).replace(/\b(\d+):([0-5]\d)\b/g, (m, min, sec) =>
      `<button class="coach-tc mono" data-t="${Number(min) * 60 + Number(sec)}">${m}</button>`
    );
  }

  addChatRow(kind, html) {
    const row = document.createElement('div');
    row.className = `coach-row ${kind}`;
    row.innerHTML = html;
    this.coachLog.appendChild(row);
    this.coachLog.scrollTop = this.coachLog.scrollHeight;
    return row;
  }

  async sendChat(text) {
    if (this.coachBusy) return;
    this.coachBusy = true;
    this.chatHistory.push({ role: 'user', content: text });
    this.chatHistory = this.chatHistory.slice(-12);
    this.addChatRow('you', esc(text));
    const typing = this.addChatRow('typing', '···');
    this.coachInput.value = '';
    this.coachInput.disabled = true;
    this.setLed('busy');
    try {
      const res = await api(`/api/jobs/${this.job.id}/chat`, {
        method: 'POST',
        body: JSON.stringify({ messages: this.chatHistory, durationSec: this.duration() }),
      });
      typing.remove();
      if (res.reply) {
        this.chatHistory.push({ role: 'assistant', content: res.reply });
        this.chatHistory = this.chatHistory.slice(-12);
        let html = this.linkifyTimecodes(res.reply);
        if (res.finishReason === 'length') html += ' <span class="coach-trim">…(trimmed)</span>';
        this.addChatRow('coach', html);
      }
      await this.executeToolCalls(res.toolCalls || []);
    } catch (err) {
      typing.remove();
      this.addChatRow('error', esc(err.message));
    }
    this.coachBusy = false;
    this.coachInput.disabled = false;
    this.coachInput.focus();
    this.setLed(this.job.guide ? 'ready' : 'idle');
  }

  // Sequential with a short stagger so students can see each console move land.
  async executeToolCalls(calls) {
    for (const call of calls) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        await this.executeCall(call);
      } catch (err) {
        this.addChatRow('error', esc(err.message));
      }
    }
  }

  async executeCall({ name, args }) {
    if (name === 'solo') {
      for (const stemName of this.channelsByName.keys()) this.setMute(stemName, stemName !== args.stem);
      this.flashChannel(args.stem);
      this.addActionChip(`SOLO · ${this.label(args.stem).toUpperCase()}`);
    } else if (name === 'set_mute') {
      this.setMute(args.stem, args.muted);
      this.flashChannel(args.stem);
      this.addActionChip(`${args.muted ? 'MUTE' : 'UNMUTE'} · ${this.label(args.stem).toUpperCase()}`);
    } else if (name === 'seek') {
      this.seekTo(args.seconds);
      this.addActionChip(`SEEK · ${fmt(args.seconds)}`);
    } else if (name === 'add_note') {
      await this.saveNote(args.seconds, args.text);
      this.addActionChip(`NOTE · ${fmt(args.seconds)}`);
    }
  }

  setMute(stemName, muted) {
    const ch = this.channelsByName.get(stemName);
    if (!ch) return;
    ch.audio.muted = muted;
    ch.muteBtn.setAttribute('aria-pressed', String(muted));
    ch.row.classList.toggle('muted', muted);
  }

  flashChannel(stemName) {
    const ch = this.channelsByName.get(stemName);
    if (!ch) return;
    ch.row.classList.remove('coach-flash');
    void ch.row.offsetWidth; // restart the animation
    ch.row.classList.add('coach-flash');
  }

  addActionChip(labelText) {
    this.addChatRow('action', `<span class="coach-chip mono">${esc(labelText)}</span>`);
  }
}

// --- job rendering & polling ----------------------------------------------

const jobList = document.getElementById('job-list');
const emptyState = document.getElementById('empty-state');
const jobStates = new Map(); // id -> latest server response
const mixers = new Map(); // id -> Mixer (persists across re-renders)

function renderJobs() {
  const jobs = getJobs();
  emptyState.hidden = jobs.length > 0;
  jobList.innerHTML = '';

  for (const job of jobs) {
    const state = jobStates.get(job.id) || {
      status: 'processing',
      stems: [],
      model: job.model,
      expectedStems: job.expectedStems || [],
    };

    if (state.status === 'done' && state.stems?.length) {
      let mixer = mixers.get(job.id);
      if (!mixer) {
        mixer = new Mixer({ ...state, filename: job.filename });
        mixers.set(job.id, mixer);
      }
      jobList.appendChild(mixer.el);
      continue;
    }

    const li = document.createElement('li');
    li.className = 'console';
    const failed = state.status === 'failed' || state.status === 'done';
    li.innerHTML = `
      <div class="console-head">
        <span class="console-title">${esc(job.filename)}</span>
        <span class="badge ${failed ? 'failed' : 'processing'}">${failed ? 'FAILED' : 'SEPARATING'}</span>
      </div>
      ${
        failed
          ? `<p class="job-error">${esc(
              state.error || 'No playable tracks were returned. Run the split again.'
            )}</p>`
          : `<p class="job-note">Creating ${esc(
              stemDescription(state.expectedStems || job.expectedStems)
            )}…</p>`
      }
    `;
    jobList.appendChild(li);
  }
}

function stemDescription(expectedStems) {
  return expectedStems?.length ? expectedStems.join(' / ') : 'the selected tracks';
}

let pollTimer = null;

async function pollActiveJobs() {
  const jobs = getJobs();
  let anyActive = false;

  for (const job of jobs) {
    const cached = jobStates.get(job.id);
    if (cached && (cached.status === 'done' || cached.status === 'failed')) continue;

    try {
      const res = await fetch(`/api/jobs/${job.id}`);
      if (res.status === 404) {
        // Job expired (30-day cleanup) or unknown — drop it.
        saveJobs(getJobs().filter((j) => j.id !== job.id));
        continue;
      }
      const state = await res.json();
      jobStates.set(job.id, state);
      if (state.status !== 'done' && state.status !== 'failed') anyActive = true;
    } catch {
      anyActive = true; // network blip — keep polling
    }
  }

  renderJobs();
  const states = jobs.map((job) => jobStates.get(job.id));
  if (
    states.length > 0 &&
    states.every((state) => state?.status === 'done' || state?.status === 'failed')
  ) {
    uploadStatus.hidden = true;
  }
  if (anyActive) pollSoon();
}

function pollSoon() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollActiveJobs, POLL_INTERVAL_MS);
}

// --- helpers ----------------------------------------------------------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cssName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function idx(arr, v) {
  const i = arr.indexOf(String(v).toLowerCase());
  return i === -1 ? 99 : i;
}

function fmt(sec) {
  if (!isFinite(sec)) return '·:··';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// --- init -------------------------------------------------------------

separationOptionsReady = loadSeparationOptions();
void ensureClassCode();
renderJobs();
pollActiveJobs();
