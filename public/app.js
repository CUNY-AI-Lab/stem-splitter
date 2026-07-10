// Stem Splitter frontend: presigned upload to R2 → create job → poll status →
// synchronized stem mixer (all stems play together; per-stem mute).

const POLL_INTERVAL_MS = 5000;
const STEM_ORDER = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'];

// --- class code ---------------------------------------------------------

function getClassCode() {
  let code = localStorage.getItem('classCode');
  if (!code) {
    code = (prompt('Enter your class code:') || '').trim();
    if (code) localStorage.setItem('classCode', code);
  }
  return code;
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
    throw new Error('Invalid class code — reload the page and try again.');
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
  jobs.unshift({ id: job.id, filename: job.filename });
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

function selectedModel() {
  return document.querySelector('input[name="stem-model"]:checked')?.value || 'htdemucs_ft';
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
  if (!url) return;

  uploadStatus.hidden = false;
  progressBar.style.width = '0%';
  showUploadMessage('FETCHING FROM YOUTUBE…');

  try {
    const job = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ youtubeUrl: url, model: selectedModel() }),
    });
    ytUrlInput.value = '';
    addJob(job);
    showUploadMessage('PROCESSING — stems will appear in the rack below. First track after a quiet spell can take a couple of minutes while the model warms up.');
    renderJobs();
    pollSoon();
  } catch (err) {
    showUploadMessage(err.message, true);
  }
});

async function handleFile(file) {
  if (file.size > 100 * 1024 * 1024) {
    showUploadMessage('File too large (max 100 MB).', true);
    return;
  }

  uploadStatus.hidden = false;
  progressBar.style.width = '0%';
  showUploadMessage(`UPLOADING ${file.name}…`);

  try {
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
      body: JSON.stringify({ key, filename: file.name, model: selectedModel() }),
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
    `;

    this.playBtn = li.querySelector('.play-btn');
    this.seek = li.querySelector('.seek');
    this.tcNow = li.querySelector('.tc-now');
    this.tcEnd = li.querySelector('.tc-end');
    this.markers = li.querySelector('.markers');
    this.noteBtn = li.querySelector('.note-btn');
    this.noteBtn.addEventListener('click', () => this.addNote());
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
      row.querySelector('.mute-btn').addEventListener('click', (e) => {
        audio.muted = !audio.muted;
        e.currentTarget.setAttribute('aria-pressed', String(audio.muted));
        row.classList.toggle('muted', audio.muted);
      });

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

    this.seek.addEventListener('input', () => {
      const t = (this.seek.value / 1000) * (master.duration || 0);
      for (const a of this.audios) a.currentTime = t;
      this.paint();
    });

    return li;
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
      m.addEventListener('click', (e) => {
        e.stopPropagation();
        this.seekTo(note.atSeconds);
        this.showNoteTip(note, m);
      });
      this.markers.appendChild(m);
    }
  }

  showNoteTip(note, marker) {
    this.hideNoteTip();
    const tip = document.createElement('div');
    tip.className = 'note-tip';
    tip.innerHTML = `<span class="note-tip-time mono">${fmt(note.atSeconds)}</span><span class="note-tip-text">${esc(note.text)}</span><button class="note-del" title="Delete note">✕</button>`;
    tip.querySelector('.note-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      this.annotations = this.annotations.filter((n) => n.id !== note.id);
      this.renderMarkers();
      this.hideNoteTip();
      try {
        await api(`/api/jobs/${this.job.id}/annotations/${note.id}`, { method: 'DELETE' });
      } catch (err) {
        this.annotations.push(note);
        this.annotations.sort((a, b) => a.atSeconds - b.atSeconds);
        this.renderMarkers();
        showUploadMessage(err.message, true);
      }
    });
    marker.appendChild(tip);
    this.tip = tip;
    setTimeout(() => {
      document.addEventListener('click', () => this.hideNoteTip(), { once: true });
    }, 0);
  }

  hideNoteTip() {
    if (this.tip) {
      this.tip.remove();
      this.tip = null;
    }
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
        const note = await api(`/api/jobs/${this.job.id}/annotations`, {
          method: 'POST',
          body: JSON.stringify({ atSeconds: t, text }),
        });
        this.annotations.push(note);
        this.annotations.sort((a, b) => a.atSeconds - b.atSeconds);
        this.renderMarkers();
      } catch (err) {
        showUploadMessage(err.message, true);
      }
    });
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
    const state = jobStates.get(job.id) || { status: 'processing', stems: [] };

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
    const failed = state.status === 'failed';
    li.innerHTML = `
      <div class="console-head">
        <span class="console-title">${esc(job.filename)}</span>
        <span class="badge ${failed ? 'failed' : 'processing'}">${failed ? 'FAILED' : 'SEPARATING'}</span>
      </div>
      ${
        failed
          ? `<p class="job-error">${esc(state.error || 'Something went wrong.')}</p>`
          : `<p class="job-note">Splitting into ${
              state.model === 'htdemucs_6s'
                ? 'vocals / drums / bass / guitar / piano / other'
                : 'vocals / drums / bass / other'
            }…</p>`
      }
    `;
    jobList.appendChild(li);
  }
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

getClassCode();
renderJobs();
pollActiveJobs();
