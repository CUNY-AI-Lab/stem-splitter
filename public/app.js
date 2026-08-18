// Stem Splitter frontend: presigned upload to R2 → create job → poll status →
// synchronized stem mixer (all stems play together; per-stem mute).

const POLL_INTERVAL_MS = 5000;
const STEM_ORDER = ['vocals', 'instrumental', 'drums', 'bass', 'other', 'guitar', 'piano'];

// Solo has two stages on purpose, and this is the quiet one: the rest of the
// band drops back instead of disappearing, so you hear a part in its place
// before you hear it alone.
const BEHIND_GAIN = 0.13; // ≈ −18 dB
const SPEEDS = [0.5, 0.75, 1];
const NUDGE_SECONDS = 5;

// Five log-spaced bands across a 128-bin FFT: one bar each, low to high.
const METER_BANDS = [
  [1, 2],
  [2, 5],
  [5, 12],
  [12, 32],
  [32, 80],
];

// Contract id -> display copy from /api/separation-options, so a finished
// console can say which split made it. Filled once the options land.
const splitMeta = new Map();

// --- shared audio graph ---------------------------------------------------
//
// The five bars per channel used to be a fixed CSS loop: they moved whenever a
// stem was playing, whatever was in it. One AudioContext for the whole page
// makes them true — each bar is a frequency band of that stem, so a bass strip
// and a hi-hat strip stop looking alike, and a near-silent stem reads as
// silent. Everything falls back to the CSS loop if the context won't start.

let audioCtx = null;
let audioCtxBlocked = false;

function sharedAudioContext() {
  if (audioCtx || audioCtxBlocked) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    audioCtxBlocked = true;
    return null;
  }
  try {
    audioCtx = new Ctx();
  } catch {
    audioCtxBlocked = true;
  }
  return audioCtx;
}

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

// POST to a Listening Guide endpoint and consume its SSE stream, calling onEvent for
// each `data:` JSON event. Setup failures are plain JSON with a real status;
// mid-stream failures arrive as {type:'error'} events, which throw here.
async function streamApi(path, body, onEvent) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-class-code': getClassCode() },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    localStorage.removeItem('classCode');
    void ensureClassCode();
    throw new Error('Invalid class code — enter it and retry.');
  }
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data: ')) continue;
        let event;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (event.type === 'error') throw new Error(event.message || 'The Listening Guide dropped out — try again.');
        onEvent(event);
        // `done` is the application protocol's terminal event. Some proxies
        // keep an otherwise complete SSE response open, so waiting for the
        // transport EOF can leave the guide stuck in its loading state.
        if (event.type === 'done') return;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
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

// A new song takes the spotlight: previous sessions collapse (nothing is
// deleted — one click on a console head reopens it).
function addJob(job) {
  const jobs = getJobs().map((j) => ({ ...j, collapsed: true }));
  jobs.unshift({
    id: job.id,
    filename: job.filename,
    model: job.model,
    expectedStems: job.expectedStems || [],
    ...(job.autoRouting ? { autoRouting: job.autoRouting } : {}),
    // POST /api/jobs doesn't carry a timestamp; this stands in until the first
    // poll returns the server's own createdAt.
    startedAt: Date.now(),
    collapsed: false,
  });
  saveJobs(jobs.slice(0, 50));
}

function setJobCollapsed(id, collapsed) {
  saveJobs(getJobs().map((j) => (j.id === id ? { ...j, collapsed } : j)));
}

/** D1 writes `datetime('now')` — naked UTC that Safari won't parse unaided. */
function serverTime(value) {
  if (typeof value !== 'string' || !value) return null;
  const iso = /(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

// --- upload flow ----------------------------------------------------------

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const uploadStatus = document.getElementById('upload-status');
const progressBar = document.getElementById('progress-bar');
const uploadMessage = document.getElementById('upload-message');

const ytDisclosure = document.getElementById('yt-disclosure');
const ytForm = document.getElementById('yt-form');
const ytUrlInput = document.getElementById('yt-url');
const ytFetchButton = ytForm.querySelector('button[type="submit"]');

// Opening the disclosure is a statement of intent — land the caret in the field
// so the next thing you do is paste.
ytDisclosure.addEventListener('toggle', () => {
  if (ytDisclosure.open) ytUrlInput.focus();
});
const stemChoice = document.getElementById('stem-choice');
const splitLegend = document.getElementById('split-legend');
const splitSummary = document.getElementById('split-summary');
const engineSummary = document.getElementById('engine-summary');
let separationOptionsReady;
let youtubeFetchInProgress = false;
const AUTO_MODEL = 'auto';
const BROWSER_AUDIO_DECODE_TIMEOUT_MS = 20_000;
const BROWSER_AUDIO_METADATA_TIMEOUT_MS = 5_000;
let catalogueModels = [];
let catalogueDefaultModel = '';
let serverAutoMode = 'off';

function selectedModel() {
  return document.querySelector('input[name="stem-model"]:checked')?.value || '';
}

async function requireSelectedModel() {
  await separationOptionsReady;
  const model = selectedModel();
  if (!model) throw new Error('Split choices are unavailable. Reload the page and try again.');
  return model;
}

function fallbackModel() {
  return (
    catalogueModels.find((model) => model.id === catalogueDefaultModel) ||
    catalogueModels.find((model) => model.stems.length === 4) ||
    catalogueModels[0]
  );
}

function classifyAudio(samples, sampleRate) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/autosplit-worker.js');
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error('Audio analysis timed out'));
    }, 20_000);

    worker.addEventListener('message', (event) => {
      clearTimeout(timeout);
      worker.terminate();
      if (event.data?.ok) resolve(event.data);
      else reject(new Error(event.data?.error || 'Audio analysis failed'));
    }, { once: true });
    worker.addEventListener('error', () => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error('Audio analysis worker failed'));
    }, { once: true });
    worker.postMessage({ samples: samples.buffer, sampleRate }, [samples.buffer]);
  });
}

function decodeAudioFile(context, file) {
  let timeout;
  const work = file.arrayBuffer().then((bytes) => context.decodeAudioData(bytes));
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error('Audio decoding timed out')),
      BROWSER_AUDIO_DECODE_TIMEOUT_MS
    );
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timeout));
}

function readAudioDuration(file) {
  return new Promise((resolve, reject) => {
    if (!globalThis.URL?.createObjectURL) {
      reject(new Error('Audio metadata is unavailable'));
      return;
    }
    const audio = document.createElement('audio');
    const objectUrl = URL.createObjectURL(file);
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      audio.removeEventListener('loadedmetadata', loaded);
      audio.removeEventListener('error', failed);
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(objectUrl);
    };
    const finish = (callback, value) => {
      cleanup();
      callback(value);
    };
    const loaded = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        finish(resolve, audio.duration);
      } else {
        finish(reject, new Error('Audio duration is invalid'));
      }
    };
    const failed = () => finish(reject, new Error('Audio metadata could not be read'));
    timeout = setTimeout(
      () => finish(reject, new Error('Audio metadata timed out')),
      BROWSER_AUDIO_METADATA_TIMEOUT_MS
    );
    audio.addEventListener('loadedmetadata', loaded, { once: true });
    audio.addEventListener('error', failed, { once: true });
    audio.preload = 'metadata';
    audio.src = objectUrl;
    audio.load();
  });
}

/**
 * Resolve AUTO according to the advertised rollout mode. With the kill switch
 * off this is the original browser behavior. Shadow mode reports the browser or
 * default choice while asking the server to compare. Authoritative mode keeps
 * `auto` as a routing request until the stored source has been analyzed.
 */
async function resolveModel(chosen, file, sourceLabel = 'this source') {
  if (chosen !== AUTO_MODEL) return { model: chosen, note: '' };

  const fallback = fallbackModel();
  const fallbackId = fallback?.id || '';
  const fallbackParts = fallback?.stems.length || 4;
  if (!file) {
    if (serverAutoMode === 'authoritative') {
      return {
        model: AUTO_MODEL,
        routingRequest: AUTO_MODEL,
        note: `AUTO will listen to ${sourceLabel} after it is imported.`,
      };
    }
    return {
      model: fallbackId,
      ...(serverAutoMode === 'shadow' ? { routingRequest: AUTO_MODEL } : {}),
      note:
        serverAutoMode === 'shadow'
          ? `AUTO is checking ${sourceLabel}; this split uses the ${fallbackParts}-part default.`
          : `AUTO could not analyze ${sourceLabel}; using the ${fallbackParts}-part default.`,
    };
  }

  // In authoritative mode the stored source is the source of truth. Avoid a
  // redundant full-file Web Audio allocation merely to produce an advisory
  // browser answer that the server must verify anyway.
  if (serverAutoMode === 'authoritative') {
    return {
      model: AUTO_MODEL,
      routingRequest: AUTO_MODEL,
      note: `AUTO will analyze ${sourceLabel} after upload.`,
    };
  }

  const AudioContextType = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextType || !globalThis.AutoSplit || !window.Worker) {
    return {
      model: serverAutoMode === 'authoritative' ? AUTO_MODEL : fallbackId,
      ...(serverAutoMode === 'off' ? {} : { routingRequest: AUTO_MODEL }),
      note:
        serverAutoMode === 'authoritative'
          ? 'AUTO will analyze the track after upload.'
          : `AUTO is unavailable — using the ${fallbackParts}-part default.`,
    };
  }

  let context;
  try {
    showUploadMessage('AUTO IS LISTENING BEFORE THE UPLOAD…');
    if (file.size > AutoSplit.MAX_BROWSER_DECODE_BYTES) {
      return {
        model: fallbackId,
        ...(serverAutoMode === 'shadow' ? { routingRequest: AUTO_MODEL } : {}),
        note:
          serverAutoMode === 'shadow'
            ? `AUTO is checking ${sourceLabel}; this split uses the ${fallbackParts}-part default.`
            : `AUTO could not analyze this long or large file — using the ${fallbackParts}-part default.`,
      };
    }
    const duration = await readAudioDuration(file);
    if (!AutoSplit.browserDecodeAllowed(file.size, duration)) {
      return {
        model: fallbackId,
        ...(serverAutoMode === 'shadow' ? { routingRequest: AUTO_MODEL } : {}),
        note:
          serverAutoMode === 'shadow'
            ? `AUTO is checking ${sourceLabel}; this split uses the ${fallbackParts}-part default.`
            : `AUTO could not analyze this long or large file — using the ${fallbackParts}-part default.`,
      };
    }
    context = new AudioContextType();
    const buffer = await decodeAudioFile(context, file);
    // Downmixing is a bounded linear pass. Keep the more expensive anti-alias
    // resampling and feature extraction together in the worker so long tracks
    // cannot monopolize the UI thread on lower-powered classroom devices.
    const samples = AutoSplit.downmix(buffer);
    const { verdict } = await classifyAudio(samples, buffer.sampleRate);
    const model = AutoSplit.pickModel(verdict.choice, catalogueModels) || fallbackId;
    const parts = catalogueModels.find((candidate) => candidate.id === model)?.stems.length;
    const browserAnalysis = {
      classifierVersion: AutoSplit.ROLE_CLASSIFIER_VERSION,
      choice: verdict.choice,
      resolvedCoreModel: model,
      reason: verdict.reason,
    };
    return {
      model: serverAutoMode === 'authoritative' ? AUTO_MODEL : model,
      ...(serverAutoMode === 'off'
        ? {}
        : { routingRequest: AUTO_MODEL, browserAnalysis }),
      note:
        serverAutoMode === 'authoritative'
          ? `AUTO heard a likely ${parts || fallbackParts}-part split and will confirm it after upload.`
          : `AUTO CHOSE ${parts || fallbackParts} PARTS — ${verdict.reason.toUpperCase()}.`,
    };
  } catch {
    return {
      model: serverAutoMode === 'authoritative' ? AUTO_MODEL : fallbackId,
      ...(serverAutoMode === 'off' ? {} : { routingRequest: AUTO_MODEL }),
      note:
        serverAutoMode === 'authoritative'
          ? 'AUTO will analyze the track after upload.'
          : `AUTO could not read this file — using the ${fallbackParts}-part default.`,
    };
  } finally {
    if (context) void context.close().catch(() => {});
  }
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

    catalogueModels = options.models;
    catalogueDefaultModel = options.defaultModel;
    serverAutoMode = ['shadow', 'authoritative'].includes(options.routing?.auto)
      ? options.routing.auto
      : 'off';
    stemChoice.replaceChildren();
    stemChoice.appendChild(buildAutoOption());
    for (const model of options.models) {
      splitMeta.set(model.id, model);
      stemChoice.appendChild(buildSplitOption(model, model.id === options.defaultModel));
    }
    // Consoles can finish rendering before the catalogue lands; give any that
    // did the engine name they were missing.
    for (const mixer of mixers.values()) mixer.renderSplitMeta();
    if (!selectedModel()) stemChoice.querySelector('input').checked = true;
    stemChoice.addEventListener('change', () => renderSplitLegend(options.models));
    renderSplitLegend(options.models);
    renderSeparationSummary(options.models);
    return true;
  } catch {
    stemChoice.innerHTML =
      '<span class="stem-choice-status mono">Split options unavailable. Reload to try again.</span>';
    splitLegend.replaceChildren();
    splitSummary.textContent = '// split options unavailable';
    engineSummary.textContent = 'SEPARATION MODELS: UNAVAILABLE';
    return false;
  }
}

// A choice is a strip of the song cut into its parts: one segment per part, in
// the same colour that part gets in the mixer. The count is the only text —
// the part names live in the legend for the selected choice, and in the radio's
// accessible name so a screen reader still hears all of them.
function buildSplitOption(model, checked) {
  const option = document.createElement('label');
  option.className = 'split-option';

  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'stem-model';
  input.value = model.id;
  input.checked = checked;
  input.setAttribute('aria-label', model.label);

  const bar = document.createElement('span');
  bar.className = 'split-bar';
  bar.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < model.stems.length; i += 1) {
    const segment = document.createElement('span');
    segment.className = 'split-seg';
    bar.appendChild(segment);
  }

  const mark = document.createElement('span');
  mark.className = 'split-mark';
  mark.setAttribute('aria-hidden', 'true');
  const count = document.createElement('span');
  count.className = 'split-count';
  count.textContent = String(model.stems.length);
  const word = document.createElement('span');
  word.className = 'split-word';
  word.textContent = 'parts';

  const line = document.createElement('span');
  line.className = 'split-line';
  line.append(mark, count, word);
  option.append(input, bar, line);
  return option;
}

function buildAutoOption() {
  const option = document.createElement('label');
  option.className = 'split-option split-option-auto';

  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'stem-model';
  input.value = AUTO_MODEL;
  input.setAttribute(
    'aria-label',
    serverAutoMode === 'authoritative'
      ? 'Auto: listen after import and choose 2, 4, or 6 parts'
      : 'Auto: listen to a local file and choose 2, 4, or 6 parts'
  );

  const bar = document.createElement('span');
  bar.className = 'split-bar';
  bar.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 4; i += 1) {
    const segment = document.createElement('span');
    segment.className = 'split-seg';
    bar.appendChild(segment);
  }

  const mark = document.createElement('span');
  mark.className = 'split-mark';
  mark.setAttribute('aria-hidden', 'true');
  const count = document.createElement('span');
  count.className = 'split-count';
  count.textContent = '?';
  const word = document.createElement('span');
  word.className = 'split-word';
  word.textContent = 'auto';

  const line = document.createElement('span');
  line.className = 'split-line';
  line.append(mark, count, word);
  option.append(input, bar, line);
  return option;
}

function renderSplitLegend(models) {
  splitLegend.replaceChildren();
  if (selectedModel() === AUTO_MODEL) {
    const item = document.createElement('li');
    item.textContent =
      serverAutoMode === 'authoritative'
        ? 'listens after import, then picks 2, 4, or 6 parts'
        : 'listens to local audio, then picks 2, 4, or 6 parts';
    splitLegend.appendChild(item);
    return;
  }
  const selected = models.find((model) => model.id === selectedModel()) || models[0];
  for (const stem of selected?.stems || []) {
    const item = document.createElement('li');
    item.textContent = stem;
    splitLegend.appendChild(item);
  }
}

function renderSeparationSummary(models) {
  const partCounts = [...new Set(models.map((model) => model.stems.length))].sort((a, b) => a - b);
  const engines = [...new Set(models.map((model) => model.engine.trim()))];
  splitSummary.textContent = `// ${formatList(partCounts)} parts per song`;
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
    const chosen = await requireSelectedModel();
    const resolved = await resolveModel(chosen, null, 'YouTube audio');
    const { model, note } = resolved;
    if (note) showUploadMessage(note);
    const job = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        youtubeUrl: url,
        model,
        ...(resolved.routingRequest ? { routingRequest: resolved.routingRequest } : {}),
        ...(resolved.browserAnalysis ? { browserAnalysis: resolved.browserAnalysis } : {}),
      }),
    });
    ytUrlInput.value = '';
    addJob(job);
    showUploadMessage(processingMessage(job));
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
      showCrateStatus('No openly licensed audio matched that search.');
    } else {
      showCrateStatus(`${data.total.toLocaleString()} OPENLY LICENSED ITEMS MATCH`);
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
  // Songs only: anything over the 5-minute cap (or 100 MB) is left out of the
  // list entirely rather than shown greyed — the server refuses them anyway.
  const splittable = item.tracks.filter((track) => track.importable);
  const hiddenCount = item.tracks.length - splittable.length;

  if (splittable.length === 0) {
    container.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'mono crate-loading',
      textContent: 'No tracks under 5 minutes on this item.',
    }));
    return;
  }

  const list = document.createElement('ul');
  list.className = 'crate-track-list';

  for (const track of splittable) {
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
    split.textContent = 'SPLIT';
    split.addEventListener('click', () => void importArchiveTrack(item, track, split));

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
  const hiddenNote = hiddenCount ? ` · ${hiddenCount} track${hiddenCount === 1 ? '' : 's'} over 5:00 not shown` : '';
  credit.append(
    document.createTextNode(`${item.license}${item.creator ? ` · ${item.creator}` : ''} · `),
    link,
    document.createTextNode(hiddenNote)
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
    const chosen = await requireSelectedModel();
    const resolved = await resolveModel(chosen, null, 'Internet Archive audio');
    const { model, note } = resolved;
    if (note) showUploadMessage(note);
    const job = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        archiveId: item.identifier,
        archiveFile: track.name,
        model,
        ...(resolved.routingRequest ? { routingRequest: resolved.routingRequest } : {}),
        ...(resolved.browserAnalysis ? { browserAnalysis: resolved.browserAnalysis } : {}),
      }),
    });

    addJob(job);
    showUploadMessage(processingMessage(job, 'stems'));
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
    const chosen = await requireSelectedModel();
    const resolved = await resolveModel(chosen, file);
    const { model, note } = resolved;
    if (note) showUploadMessage(note);
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
      body: JSON.stringify({
        key,
        filename: file.name,
        model,
        ...(resolved.routingRequest ? { routingRequest: resolved.routingRequest } : {}),
        ...(resolved.browserAnalysis ? { browserAnalysis: resolved.browserAnalysis } : {}),
      }),
    });

    addJob(job);
    showUploadMessage(processingMessage(job));
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

function processingMessage(job, noun = 'parts') {
  const route = job.autoRouting;
  let prefix = 'PROCESSING';
  const reason = route?.analysis?.decision?.reason;
  if (route?.mode === 'authoritative' && reason) {
    const count = job.expectedStems?.length || 4;
    prefix = route.analysis?.degraded?.active
      ? `AUTO USED THE ${count}-PART DEFAULT — ${reason.toUpperCase()}`
      : `AUTO CHOSE ${count} PARTS — ${reason.toUpperCase()}`;
  }
  return `${prefix} — ${noun} will appear in the rack below. First track after a quiet spell can take a couple of minutes while the model warms up.`;
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
    this.channelsByName = new Map(); // canonical stem name -> { audio, row, muteBtn, soloBtn }
    this.chatHistory = []; // per-instance; survives re-renders via the mixers Map
    this.coachBusy = false;
    // The student's own mute switches. Solo is a temporary override layered on
    // top and never writes here, so releasing solo restores exactly this.
    this.userMuted = new Map();
    this.soloState = null; // { stem, stage: 'behind' | 'only' }
    this.loop = null; // { start, end }
    this.rate = 1;
    this.el = this.build();
  }

  build() {
    const stems = [...this.job.stems].sort(
      (a, b) => idx(STEM_ORDER, a.name) - idx(STEM_ORDER, b.name)
    );

    const li = document.createElement('li');
    li.className = 'console';
    li.tabIndex = 0; // the console is the keyboard target; see bindKeys()
    this.el = li; // build() calls into methods that reach for it before it returns
    li.innerHTML = `
      <div class="console-head">
        <span class="console-title">${esc(this.job.filename)}</span>
        <span class="badge ready">READY</span>
        <button class="head-btn export-btn" title="Download stems + guide, chat, and notes as a zip">EXPORT</button>
        <button class="head-btn collapse-btn" aria-expanded="true" title="Collapse this session">▾</button>
      </div>
      <div class="console-sub mono">
        <span class="split-meta"></span>
        <button class="share-btn" title="Copy a link to this console">COPY LINK</button>
      </div>
      <div class="transport">
        <button class="play-btn" aria-label="Play all stems">▶</button>
        <span class="timecode tc-now">0:00</span>
        <div class="seek-wrap">
          <div class="loop-region" hidden></div>
          <input class="seek" type="range" min="0" max="1000" value="0" aria-label="Seek" />
          <div class="markers" aria-hidden="false"></div>
        </div>
        <span class="timecode tc-end">·:··</span>
        <button class="note-btn" title="Add a note at the current time">＋&nbsp;NOTE</button>
      </div>
      <div class="transport-aux mono">
        <div class="rate" role="group" aria-label="Playback speed">
          <span class="aux-label">SPEED</span>
        </div>
        <div class="loop-status" hidden>
          <span class="aux-label">LOOP</span>
          <span class="loop-range"></span>
          <button class="loop-clear" aria-label="Stop looping">✕</button>
        </div>
      </div>
      <div class="channels"></div>
      <div class="notes" hidden></div>
      <p class="console-keys mono" aria-hidden="true"></p>
      <div class="coach">
        <button class="coach-toggle" aria-expanded="false">
          <span class="coach-led"></span>LISTENING GUY<span class="coach-caret">▾</span>
        </button>
        <div class="coach-body" hidden>
          <div class="coach-guide"></div>
          <div class="coach-archive" hidden>
            <button type="button" class="coach-archive-toggle" aria-expanded="false"></button>
            <div class="coach-archive-log" hidden></div>
          </div>
          <div class="coach-log" role="log" aria-live="polite"></div>
          <form class="coach-form">
            <input maxlength="500" placeholder="ask about this song…" aria-label="Ask the Listening Guide" />
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

    this.collapseBtn = li.querySelector('.collapse-btn');
    this.collapseBtn.addEventListener('click', () => {
      const collapsed = !this.el.classList.contains('collapsed');
      this.setCollapsed(collapsed);
      setJobCollapsed(this.job.id, collapsed);
    });
    this.exportBtn = li.querySelector('.export-btn');
    this.exportBtn.addEventListener('click', () => this.exportZip());

    this.splitMetaEl = li.querySelector('.split-meta');
    this.shareBtn = li.querySelector('.share-btn');
    this.shareBtn.addEventListener('click', () => this.copyLink());
    this.rateGroup = li.querySelector('.rate');
    this.loopRegion = li.querySelector('.loop-region');
    this.loopStatus = li.querySelector('.loop-status');
    this.loopRange = li.querySelector('.loop-range');
    li.querySelector('.loop-clear').addEventListener('click', () => this.setLoop(null));
    this.keysHint = li.querySelector('.console-keys');
    this.keysHint.textContent =
      'SPACE play · ←→ 5s · 1–9 mute · ⇧1–9 solo · [ ] notes · L loop · ESC clear';

    for (const speed of SPEEDS) {
      const btn = document.createElement('button');
      btn.className = 'rate-opt';
      btn.dataset.rate = String(speed);
      btn.textContent = `${speed === 1 ? '1' : String(speed).replace('0.', '.')}×`;
      btn.setAttribute('aria-label', `Play at ${speed}× speed`);
      btn.setAttribute('aria-pressed', String(speed === this.rate));
      btn.addEventListener('click', () => this.setRate(speed));
      this.rateGroup.appendChild(btn);
    }

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
      // Polling stops once a job is done, so a guide a classmate already paid
      // for would otherwise still show the cue button here. Opening the panel
      // is the moment that matters — pick up their guide, names, and notes.
      if (open) void this.refresh();
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

    this.coachArchive = li.querySelector('.coach-archive');
    this.archiveToggle = li.querySelector('.coach-archive-toggle');
    this.archiveLog = li.querySelector('.coach-archive-log');
    this.archiveToggle.addEventListener('click', () => {
      const open = this.archiveLog.hidden;
      this.archiveLog.hidden = !open;
      this.archiveToggle.setAttribute('aria-expanded', String(open));
    });
    this.renderArchive();

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
        <button class="solo-btn" aria-pressed="false" title="Press once to bring this part forward, again to hear it alone">SOLO</button>
        <button class="mute-btn" aria-pressed="false" aria-label="Mute ${esc(this.label(stem.name))}">MUTE</button>
        <a class="dl" href="${stem.url}?download" title="Download ${esc(stem.name)}">↓</a>
      `;
      const muteBtn = row.querySelector('.mute-btn');
      const soloBtn = row.querySelector('.solo-btn');
      const download = row.querySelector('.dl');
      this.channelsByName.set(stem.name, {
        audio,
        row,
        muteBtn,
        soloBtn,
        download,
        bars: [...row.querySelectorAll('.meter i')],
        levels: new Float32Array(METER_BANDS.length),
        mixGain: 1,
      });
      this.userMuted.set(stem.name, false);
      muteBtn.addEventListener('click', () =>
        this.setMute(stem.name, !this.userMuted.get(stem.name))
      );
      soloBtn.addEventListener('click', () => this.cycleSolo(stem.name));
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

    this.bindKeys(li);
    this.renderSplitMeta();
    this.applyMix();
    this.renderNotes();
    this.renderGuide();
    return li;
  }

  // Keys are scoped to one console rather than the window: a rack can hold
  // several songs, and 1–9 has to mean "this song's channels".
  bindKeys(li) {
    li.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;

      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit) {
        const name = [...this.channelsByName.keys()][Number(digit[1]) - 1];
        if (!name) return;
        e.preventDefault();
        if (e.shiftKey) this.cycleSolo(name);
        else this.setMute(name, !this.userMuted.get(name));
        return;
      }
      if (e.shiftKey) return;

      switch (e.code) {
        case 'Space':
          // A focused button already answers to Space; don't fire twice.
          if (t.tagName === 'BUTTON' || t.tagName === 'A' || t.tagName === 'SUMMARY') return;
          e.preventDefault();
          if (!this.playBtn.disabled) (this.playing ? this.pause() : this.play());
          break;
        case 'ArrowLeft':
          e.preventDefault();
          this.seekTo(Math.max(0, this.audios[0].currentTime - NUDGE_SECONDS));
          break;
        case 'ArrowRight':
          e.preventDefault();
          this.seekTo(this.audios[0].currentTime + NUDGE_SECONDS);
          break;
        case 'BracketLeft':
        case 'BracketRight':
          e.preventDefault();
          this.jumpMarker(e.code === 'BracketRight' ? 1 : -1);
          break;
        case 'KeyL':
          e.preventDefault();
          this.toggleLoopAtPlayhead();
          break;
        case 'Escape':
          if (!this.soloState && !this.loop) return;
          e.preventDefault();
          this.soloState = null;
          this.setLoop(null);
          this.applyMix();
          break;
        default:
      }
    });
  }

  renderSplitMeta() {
    const meta = splitMeta.get(this.job.model);
    const count = this.job.stems.length;
    this.splitMetaEl.textContent = meta?.engine
      ? `${count} PARTS · ${meta.engine.toUpperCase()}`
      : `${count} PARTS`;
  }

  async copyLink() {
    const url = `${location.origin}${location.pathname}?job=${this.job.id}`;
    try {
      await navigator.clipboard.writeText(url);
      this.shareBtn.textContent = 'LINK COPIED';
      this.shareBtn.classList.add('copied');
      clearTimeout(this.shareTimer);
      this.shareTimer = setTimeout(() => {
        this.shareBtn.textContent = 'COPY LINK';
        this.shareBtn.classList.remove('copied');
      }, 2200);
    } catch {
      // No clipboard permission (or an insecure origin) — hand over the text
      // instead of failing quietly.
      const field = document.createElement('input');
      field.className = 'share-fallback mono';
      field.readOnly = true;
      field.value = url;
      this.shareBtn.replaceWith(field);
      field.select();
      field.addEventListener('blur', () => field.replaceWith(this.shareBtn));
    }
  }

  setRate(rate) {
    this.rate = rate;
    for (const audio of this.audios) {
      audio.preservesPitch = true;
      audio.mozPreservesPitch = true;
      audio.webkitPreservesPitch = true;
      audio.playbackRate = rate;
    }
    for (const btn of this.rateGroup.querySelectorAll('.rate-opt')) {
      btn.setAttribute('aria-pressed', String(Number(btn.dataset.rate) === rate));
    }
  }

  setCollapsed(collapsed) {
    if (this.el.classList.contains('collapsed') === collapsed) return;
    if (collapsed && this.playing) this.pause();
    this.el.classList.toggle('collapsed', collapsed);
    this.collapseBtn.textContent = collapsed ? '▸' : '▾';
    this.collapseBtn.title = collapsed ? 'Expand this session' : 'Collapse this session';
    this.collapseBtn.setAttribute('aria-expanded', String(!collapsed));
  }

  // --- session export -----------------------------------------------------

  exportMarkdown() {
    const lines = [`# ${this.job.filename} — listening session export`, ''];
    lines.push(`- Exported: ${new Date().toISOString()}`);
    if (this.job.model) lines.push(`- Model: ${this.job.model}`);
    lines.push(`- Tracks: ${this.job.stems.map((s) => this.label(s.name)).join(', ')}`, '');

    if (this.job.guide && this.job.guide.text) {
      lines.push('## Listening guide', '', this.job.guide.text, '');
    }
    if (this.annotations.length) {
      lines.push('## Notes', '');
      for (const note of this.annotations) lines.push(`- ${fmt(note.atSeconds)} — ${note.text}`);
      lines.push('');
    }
    if (this.chatHistory.length) {
      lines.push('## Listening Guy chat', '');
      for (const turn of this.chatHistory) {
        lines.push(`**${turn.role === 'user' ? 'You' : 'Listening Guy'}:** ${turn.content}`, '');
      }
    }
    return lines.join('\n');
  }

  async exportZip() {
    if (this.exportBtn.disabled) return;
    this.exportBtn.disabled = true;
    this.exportBtn.textContent = 'PACKING…';
    try {
      const entries = [];
      const used = new Set();
      for (const stem of this.job.stems) {
        const res = await fetch(stem.url);
        if (!res.ok) throw new Error(`Could not fetch the ${this.label(stem.name)} track (${res.status}).`);
        let base = fileSafe(this.label(stem.name)) || fileSafe(stem.name) || 'stem';
        if (used.has(base)) base = `${base}-${used.size + 1}`;
        used.add(base);
        entries.push({ name: `stems/${base}.mp3`, data: new Uint8Array(await res.arrayBuffer()) });
      }
      entries.push({
        name: 'guide-chat-and-notes.md',
        data: new TextEncoder().encode(this.exportMarkdown()),
      });

      const a = document.createElement('a');
      a.href = URL.createObjectURL(makeZip(entries));
      a.download = `${fileSafe(this.job.filename) || 'session'}-export.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      showUploadMessage(err.message, true);
    }
    this.exportBtn.disabled = false;
    this.exportBtn.textContent = 'EXPORT';
  }

  markAudioUnavailable(stemName) {
    const channel = this.channelsByName.get(stemName);
    if (!channel || channel.row.classList.contains('unavailable')) return;

    channel.audio.pause();
    channel.row.classList.add('unavailable');
    channel.muteBtn.disabled = true;
    channel.muteBtn.textContent = 'NO AUDIO';
    channel.soloBtn.disabled = true;
    channel.download.removeAttribute('href');
    channel.download.setAttribute('aria-disabled', 'true');
    this.readyBadge.textContent = 'AUDIO ERROR';
    this.readyBadge.classList.remove('ready');
    this.readyBadge.classList.add('failed');
    this.playBtn.disabled = true;
  }

  async play() {
    this.audios.forEach((a) => (a.preload = 'auto'));
    // play() is called synchronously inside the click so the gesture still
    // counts; the audio graph is wired afterwards, once the context is awake.
    try {
      await Promise.all(this.audios.map((a) => a.play()));
    } catch {
      // Autoplay rejection or a stalled stem — park everything so we never
      // sit half-playing behind a ▶ button; the user can tap again.
      this.audios.forEach((a) => a.pause());
      return;
    }
    void this.wireGraph();
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
    // The rAF loop is what drives the bars, so settle them here rather than
    // leaving the last frame frozen mid-song.
    for (const channel of this.channelsByName.values()) {
      if (!channel.analyser) continue;
      channel.levels.fill(0);
      for (const bar of channel.bars) bar.style.height = '18%';
    }
  }

  resync() {
    const master = this.audios[0];
    if (master.seeking) return; // still landing after a jump — no reference time yet
    const t = master.currentTime;
    for (const a of this.audios.slice(1)) {
      // A stem that is mid-seek or has no decodable data ahead is still
      // fetching after a jump. Re-seeking it every tick restarts that fetch,
      // so it stays silent forever — leave it alone until it can play.
      if (a.seeking || a.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) continue;
      if (Math.abs(a.currentTime - t) > 0.08) a.currentTime = t;
    }
  }

  // Route each stem through its own gain + analyser. Only taken once the
  // context is genuinely running: a suspended context that owns the elements
  // would play nothing at all, which is far worse than decorative meters.
  async wireGraph() {
    if (this.graphWired) return;
    const ctx = sharedAudioContext();
    if (!ctx) return;
    try {
      await ctx.resume();
    } catch {
      return;
    }
    if (ctx.state !== 'running') return; // try again on the next play

    this.graphWired = true;
    for (const channel of this.channelsByName.values()) {
      try {
        const source = ctx.createMediaElementSource(channel.audio);
        const gain = ctx.createGain();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.7;
        source.connect(gain).connect(analyser).connect(ctx.destination);
        channel.gainNode = gain;
        channel.analyser = analyser;
        channel.bins = new Uint8Array(analyser.frequencyBinCount);
        channel.row.querySelector('.meter').classList.add('live');
      } catch {
        // This strip keeps the element-level mixing and the CSS meter.
      }
    }
    // Gain nodes are the authority for any strip that got one.
    this.applyMix();
  }

  tick() {
    this.paint();
    this.paintMeters();
    if (this.loop && this.audios[0].currentTime >= this.loop.end) this.seekTo(this.loop.start);
    if (this.playing) this.raf = requestAnimationFrame(() => this.tick());
  }

  paintMeters() {
    for (const channel of this.channelsByName.values()) {
      if (!channel.analyser) continue;
      channel.analyser.getByteFrequencyData(channel.bins);
      for (let band = 0; band < METER_BANDS.length; band += 1) {
        const [from, to] = METER_BANDS[band];
        let sum = 0;
        for (let bin = from; bin < to; bin += 1) sum += channel.bins[bin];
        // Curve the raw magnitude so quiet detail is visible, then scale by what
        // this strip is actually contributing — a ducked or muted part reads low.
        const next =
          Math.min(1, (sum / (to - from) / 255) ** 0.7) * (this.playing ? channel.mixGain : 0);
        // Fast attack, slow release, like the meters this is drawn after.
        const level =
          next > channel.levels[band] ? next : channel.levels[band] * 0.8 + next * 0.2;
        channel.levels[band] = level;
        channel.bars[band].style.height = `${18 + level * 77}%`;
      }
    }
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
    for (const a of this.audios) {
      // Seeks can land while paused (Listening Guide tool calls do this a lot) — start
      // buffering the target region now so play() finds data ready instead of
      // six stems stalling at once.
      if (a.preload !== 'auto') a.preload = 'auto';
      a.currentTime = t;
    }
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
    this.renderLoop();
  }

  // --- section looping ---------------------------------------------------
  //
  // The class's shared notes already say where things happen, so a loop is
  // "from this note to the next one" — no second set of markers to place, and
  // one student's notes become another student's practice sections.

  boundaries() {
    const dur = this.audios[0].duration;
    const end = isFinite(dur) && dur > 0 ? dur : Infinity;
    return [0, ...this.annotations.map((n) => n.atSeconds).filter((t) => t < end), end];
  }

  sectionAt(seconds) {
    const marks = this.boundaries();
    for (let i = marks.length - 1; i >= 0; i -= 1) {
      if (seconds >= marks[i] - 0.05) return { start: marks[i], end: marks[i + 1] ?? marks[i] };
    }
    return { start: marks[0], end: marks[1] ?? marks[0] };
  }

  toggleLoopAtPlayhead() {
    if (this.loop) return this.setLoop(null);
    const section = this.sectionAt(this.audios[0].currentTime);
    // Before metadata lands the far edge is Infinity — that isn't a section.
    if (isFinite(section.end) && section.end > section.start) this.setLoop(section);
  }

  loopFromNote(note) {
    if (this.loop && Math.abs(this.loop.start - note.atSeconds) < 0.05) return this.setLoop(null);
    const end = this.boundaries().find((t) => t > note.atSeconds + 0.05);
    if (end !== undefined && isFinite(end)) this.setLoop({ start: note.atSeconds, end });
  }

  setLoop(range) {
    this.loop = range;
    this.renderLoop();
    if (!range) return;
    const now = this.audios[0].currentTime;
    if (now < range.start || now >= range.end) this.seekTo(range.start);
  }

  renderLoop() {
    const dur = this.audios[0].duration;
    const known = isFinite(dur) && dur > 0;
    this.loopStatus.hidden = !this.loop;
    this.loopRegion.hidden = !this.loop || !known;
    for (const btn of this.notes.querySelectorAll('.note-loop')) {
      btn.setAttribute(
        'aria-pressed',
        String(Boolean(this.loop) && Math.abs(this.loop.start - Number(btn.dataset.at)) < 0.05)
      );
    }
    if (!this.loop) return;

    const end = Math.min(this.loop.end, known ? dur : this.loop.end);
    this.loopRange.textContent = `${fmt(this.loop.start)} → ${fmt(end)}`;
    if (!known) return;
    this.loopRegion.style.left = `${(this.loop.start / dur) * 100}%`;
    this.loopRegion.style.width = `${Math.max(0, ((end - this.loop.start) / dur) * 100)}%`;
  }

  jumpMarker(direction) {
    const now = this.audios[0].currentTime;
    const marks = this.boundaries().filter((t) => isFinite(t));
    const target =
      direction > 0
        ? marks.find((t) => t > now + 0.25)
        : [...marks].reverse().find((t) => t < now - 0.25);
    if (target !== undefined) this.seekTo(target);
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
        <button class="note-loop" data-at="${note.atSeconds}" aria-pressed="false" aria-label="Loop from this note to the next" title="Loop from here to the next note">↻</button>
        <button class="note-del" aria-label="Delete note" title="Delete note">✕</button>
      `;
      row.querySelector('.note-time').addEventListener('click', () => this.seekTo(note.atSeconds));
      row.querySelector('.note-loop').addEventListener('click', () => this.loopFromNote(note));
      row.querySelector('.note-del').addEventListener('click', () => this.deleteNote(note));
      this.notes.appendChild(row);
    }
    this.renderLoop();
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

  // Shared by the ＋NOTE form and the Listening Guide's add_note tool — both hit the
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

  // Labels, notes, and the guide are class-wide; this pulls in whatever other
  // students have added since the page loaded. Read-only, so no class code.
  async refresh() {
    try {
      const res = await fetch(`/api/jobs/${this.job.id}`);
      if (!res.ok) return;
      const state = await res.json();
      jobStates.set(this.job.id, state);
      this.merge(state);
    } catch {
      // Offline or a blip — the panel keeps whatever it already had.
    }
  }

  merge(state) {
    if (state.labels) {
      this.job.labels = state.labels;
      this.renderChannelNames();
    }
    if (Array.isArray(state.annotations)) {
      this.annotations = [...state.annotations];
      this.renderMarkers();
      this.renderNotes();
    }
    if (state.guide && !this.job.guide) {
      this.job.guide = state.guide;
      this.renderGuide();
    }
  }

  renderChannelNames() {
    for (const [name, channel] of this.channelsByName) {
      const nameEl = channel.row.querySelector('.ch-name');
      if (!nameEl) continue; // a rename is open in this strip — leave it alone
      nameEl.textContent = this.label(name);
      channel.muteBtn.setAttribute('aria-label', `Mute ${this.label(name)}`);
    }
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
      div.innerHTML = coachHtml(this.job.guide.text);
      this.coachGuide.appendChild(div);
      this.setLed('ready');
      return;
    }
    const cue = document.createElement('div');
    cue.className = 'coach-cue';
    cue.innerHTML = `
      <button class="coach-cue-btn">CUE THE LISTENING GUIDE</button>
      <p class="coach-hint">The coach opens the conversation — first words in a few seconds.</p>
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
    // Stream: swap the cue for a live text block on the first delta, then do a
    // final formatted render (markdown-lite + timecode buttons) on completion.
    const live = document.createElement('div');
    live.className = 'coach-guide-text streaming';
    let acc = '';
    try {
      await streamApi(`/api/jobs/${this.job.id}/guide`, { durationSec: this.duration() }, (ev) => {
        if (ev.type === 'delta') {
          if (!live.isConnected) this.coachGuide.replaceChildren(live);
          acc += ev.text;
          live.textContent = acc;
        } else if (ev.type === 'done') {
          this.job.guide = { text: ev.text || acc, model: ev.model, createdAt: ev.createdAt };
        }
      });
      if (!this.job.guide) this.job.guide = { text: acc }; // stream ended without a done event
      this.renderGuide();
    } catch (err) {
      this.setLed('idle');
      this.renderGuide(); // restore the cue; partial text is discarded
      const failHint = this.coachGuide.querySelector('.coach-hint');
      if (failHint) {
        failHint.textContent = err.message;
        failHint.classList.add('error');
      }
    }
  }

  // --- previous-session archive (per song, localStorage) ----------------

  archiveKey() {
    return `coachChat:${this.job.id}`;
  }

  loadArchive() {
    try {
      const entries = JSON.parse(localStorage.getItem(this.archiveKey()) || '[]');
      return Array.isArray(entries) ? entries : [];
    } catch {
      return [];
    }
  }

  // Persist one conversation entry so the session survives a reload (it shows
  // up collapsed under "EARLIER SESSION" next time). Display-only: the model
  // still starts fresh each page load.
  logChatEntry(kind, text) {
    try {
      localStorage.setItem(this.archiveKey(), JSON.stringify([...this.loadArchive(), { kind, text }].slice(-60)));
    } catch {
      // Storage full/blocked — the live conversation still works.
    }
  }

  renderArchive() {
    const entries = this.loadArchive();
    if (!entries.length) return;
    this.coachArchive.hidden = false;
    this.archiveToggle.innerHTML = `<span class="coach-caret">▾</span>EARLIER SESSION · ${entries.length}`;
    for (const entry of entries) {
      const kind = entry.kind === 'you' || entry.kind === 'action' ? entry.kind : 'coach';
      const row = document.createElement('div');
      row.className = `coach-row ${kind}`;
      if (kind === 'action') row.innerHTML = `<span class="coach-chip mono">${esc(String(entry.text))}</span>`;
      else if (kind === 'you') row.textContent = String(entry.text);
      else row.innerHTML = coachHtml(String(entry.text));
      this.archiveLog.appendChild(row);
    }
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
    this.logChatEntry('you', text);
    const typing = this.addChatRow('typing', '···');
    this.coachInput.value = '';
    this.coachInput.disabled = true;
    this.setLed('busy');
    // Stream: prose deltas render live as plain text, then the finished reply
    // gets its formatted render; tool calls arrive after the prose and run last.
    let row = null;
    let acc = '';
    let calls = [];
    let finalText = '';
    let finishReason = 'stop';
    try {
      await streamApi(
        `/api/jobs/${this.job.id}/chat`,
        { messages: this.chatHistory, durationSec: this.duration() },
        (ev) => {
          if (ev.type === 'delta') {
            if (!row) {
              typing.remove();
              row = this.addChatRow('coach streaming', '');
            }
            acc += ev.text;
            row.textContent = acc;
            this.coachLog.scrollTop = this.coachLog.scrollHeight;
          } else if (ev.type === 'tool_calls') {
            calls = ev.calls || [];
          } else if (ev.type === 'done') {
            finalText = ev.text || acc;
            finishReason = ev.finishReason || 'stop';
          }
        }
      );
      typing.remove();
      if (finalText) {
        this.chatHistory.push({ role: 'assistant', content: finalText });
        this.chatHistory = this.chatHistory.slice(-12);
        this.logChatEntry('coach', finalText);
        if (!row) row = this.addChatRow('coach', '');
        row.classList.remove('streaming');
        let html = coachHtml(finalText);
        if (finishReason === 'length') html += ' <span class="coach-trim">…(trimmed)</span>';
        row.innerHTML = html;
      } else if (row) {
        row.remove(); // stream produced nothing durable
      }
      await this.executeToolCalls(calls);
    } catch (err) {
      typing.remove();
      if (row && !acc) row.remove();
      if (row) row.classList.remove('streaming');
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
      // The tool's contract is "every other channel is muted", so the Guide
      // gets the second stage directly — its own words have to stay true.
      if (!this.channelsByName.has(args.stem)) return;
      this.soloState = { stem: args.stem, stage: 'only' };
      this.applyMix();
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
    if (!this.channelsByName.has(stemName)) return;
    this.userMuted.set(stemName, Boolean(muted));
    this.applyMix();
  }

  // One press brings a part forward and leaves the rest quietly behind it; a
  // second press drops the rest entirely; a third gives the band back. Hearing
  // a part in place before hearing it alone is the whole point of the console.
  cycleSolo(stemName) {
    if (!this.channelsByName.has(stemName)) return;
    const current = this.soloState;
    if (!current || current.stem !== stemName) this.soloState = { stem: stemName, stage: 'behind' };
    else if (current.stage === 'behind') this.soloState = { stem: stemName, stage: 'only' };
    else this.soloState = null;
    this.applyMix();
    this.flashChannel(stemName);
  }

  // The single place that decides what every channel sounds like. Mute is the
  // student's switch, solo is an overlay on top of it, and neither writes to
  // the other — so releasing solo restores the mix exactly as it was left.
  applyMix() {
    const solo = this.soloState;
    for (const [name, channel] of this.channelsByName) {
      const muted = this.userMuted.get(name) === true;
      const focused = Boolean(solo) && solo.stem === name;
      let gain;
      if (focused) gain = 1; // soloing a muted strip is how you hear it
      else if (solo) gain = solo.stage === 'only' || muted ? 0 : BEHIND_GAIN;
      else gain = muted ? 0 : 1;

      channel.mixGain = gain;
      if (channel.gainNode) {
        // Ramp rather than step: a hard gain change on a playing stem clicks.
        channel.gainNode.gain.setTargetAtTime(gain, audioCtx.currentTime, 0.015);
        channel.audio.muted = false;
        channel.audio.volume = 1;
      } else {
        channel.audio.muted = gain === 0;
        channel.audio.volume = gain === 0 ? 1 : gain;
      }

      channel.row.classList.toggle('muted', gain === 0);
      channel.row.classList.toggle('behind', gain > 0 && gain < 1);
      channel.row.classList.toggle('focused', focused);
      channel.muteBtn.setAttribute('aria-pressed', String(muted));
      channel.soloBtn.setAttribute('aria-pressed', String(focused));
      channel.soloBtn.textContent = focused ? (solo.stage === 'only' ? 'ONLY' : 'FRONT') : 'SOLO';
    }
    this.el.classList.toggle('soloing', Boolean(solo));
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
    this.logChatEntry('action', labelText);
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
      autoRouting: job.autoRouting,
    };

    if (state.status === 'done' && state.stems?.length) {
      let mixer = mixers.get(job.id);
      if (!mixer) {
        mixer = new Mixer({ ...state, filename: job.filename });
        mixers.set(job.id, mixer);
      }
      mixer.setCollapsed(!!job.collapsed);
      jobList.appendChild(mixer.el);
      continue;
    }

    const li = document.createElement('li');
    li.className = 'console';
    const failed = state.status === 'failed' || state.status === 'done';
    // A silent wait reads as a hung wait. The clock is the server's own start
    // time once polling has one, and the local one until then.
    const since = serverTime(state.createdAt) ?? job.startedAt ?? Date.now();
    li.innerHTML = `
      <div class="console-head">
        <span class="console-title">${esc(job.filename)}</span>
        <span class="badge ${failed ? 'failed' : 'processing'}">${
          failed
            ? 'FAILED'
            : `SEPARATING<span class="elapsed" data-since="${since}">${fmt(
                (Date.now() - since) / 1000
              )}</span>`
        }</span>
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

  runElapsedClock();
}

// One clock for every separating card, started only while there is one to tick.
let elapsedTimer = null;

function runElapsedClock() {
  const paint = () => {
    const fields = jobList.querySelectorAll('.elapsed');
    if (!fields.length) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
      return;
    }
    for (const field of fields) {
      field.textContent = fmt((Date.now() - Number(field.dataset.since)) / 1000);
    }
  };
  if (!jobList.querySelector('.elapsed')) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
    return;
  }
  if (elapsedTimer) return;
  elapsedTimer = setInterval(paint, 1000);
}

// A job id is the only thing a student needs to open someone else's console —
// reads are unauthenticated by design, and names and notes are class-wide. The
// link is the piece that was missing.
async function adoptSharedJob() {
  const id = new URLSearchParams(location.search).get('job');
  if (!id) return;
  history.replaceState(null, '', location.pathname);

  if (!getJobs().some((existing) => existing.id === id)) {
    try {
      const res = await fetch(`/api/jobs/${id}`);
      if (!res.ok) {
        showUploadMessage(
          'That link points at a track that is no longer here. Splits are wiped after 30 days.',
          true
        );
        return;
      }
      const state = await res.json();
      jobStates.set(id, state);
      addJob({
        id,
        filename: state.filename,
        model: state.model,
        expectedStems: state.expectedStems || [],
        autoRouting: state.autoRouting,
      });
      renderJobs();
      if (state.status !== 'done' && state.status !== 'failed') pollSoon();
    } catch {
      showUploadMessage('Could not open that link — check your connection and try again.', true);
      return;
    }
  }

  const position = getJobs().findIndex((existing) => existing.id === id);
  jobList.children[position]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  showUploadMessage('Opened a shared track. Names and notes here are shared with the class.');
}

function stemDescription(expectedStems) {
  return expectedStems?.length ? expectedStems.join(' / ') : 'the parts you picked';
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

// Coach prose → safe HTML. The prompt bans markdown, but models still leak it;
// escape everything first, then absorb the common bleed-through (**bold**,
// *italic*, `code`, # headings, - bullets) and turn m:ss timecodes into seek
// buttons. Anything fancier renders as the plain text it arrived as.
function coachHtml(text) {
  const plain = String(text)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[ \t]*[-*]\s+/gm, '• ');
  return esc(plain)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\b(\d+):([0-5]\d)\b/g, (m, min, sec) =>
      `<button class="coach-tc mono" data-t="${Number(min) * 60 + Number(sec)}">${m}</button>`
    );
}

function cssName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function idx(arr, v) {
  const i = arr.indexOf(String(v).toLowerCase());
  return i === -1 ? 99 : i;
}

function fileSafe(s) {
  return String(s)
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
}

// Minimal ZIP writer (store method, no compression) — enough for bundling
// already-compressed MP3s plus one markdown file, without a zip library.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 filenames
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
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
// Adopt after the first poll so the shared console is rendered from real state
// and its notice isn't cleared by the poll's own tidy-up.
void pollActiveJobs().then(adoptSharedJob);
