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
const historyMoreBtn = document.getElementById('prompt-history-more');

const analysisForm = document.getElementById('analysis-form');
const analysisJobId = document.getElementById('analysis-job-id');
const analysisLoadBtn = document.getElementById('analysis-load');
const analysisStatus = document.getElementById('analysis-status');
const analysisResult = document.getElementById('analysis-result');
const analysisJobMeta = document.getElementById('analysis-job-meta');
const analysisCoreRoute = document.getElementById('analysis-core-route');
const analysisRoleVersion = document.getElementById('analysis-role-version');
const analysisReason = document.getElementById('analysis-reason');
const analysisDiscoveryMeta = document.getElementById('analysis-discovery-meta');
const analysisDetections = document.getElementById('analysis-detections');
const analysisDetectionsEmpty = document.getElementById('analysis-detections-empty');
const analysisFeedbackPanel = document.getElementById('analysis-feedback-panel');
const analysisFeedbackMeta = document.getElementById('analysis-feedback-meta');
const analysisFeedbackForm = document.getElementById('analysis-feedback-form');
const analysisFeedbackDetectedFieldset = document.getElementById(
  'analysis-feedback-detected-fieldset'
);
const analysisFeedbackDetected = document.getElementById('analysis-feedback-detected');
const analysisFeedbackGenre = document.getElementById('analysis-feedback-genre');
const analysisFeedbackFilter = document.getElementById('analysis-feedback-filter');
const analysisFeedbackMissed = document.getElementById('analysis-feedback-missed');
const analysisFeedbackSubmit = document.getElementById('analysis-feedback-submit');
const analysisFeedbackStatus = document.getElementById('analysis-feedback-status');

let maxChars = 2000;
let maxChangeNoteChars = 240;
let loadedAmendment = '';
let loadedRevision = 0;
let showingPromptTop = false;
let historyNextBeforeId = null;
let historyLoading = false;
let analysisLoadSequence = 0;
let loadedFeedbackJobId = '';
let loadedFeedbackRevision = 0;
let loadedFeedbackDetectedIds = [];

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

function showAnalysisStatus(message, isError = false) {
  analysisStatus.hidden = !message;
  analysisStatus.textContent = message;
  analysisStatus.classList.toggle('error', isError);
}

function showFeedbackStatus(message, isError = false) {
  analysisFeedbackStatus.hidden = !message;
  analysisFeedbackStatus.textContent = message;
  analysisFeedbackStatus.classList.toggle('error', isError);
}

function resetInstrumentFeedback() {
  analysisFeedbackPanel.hidden = true;
  analysisFeedbackMeta.textContent = '';
  analysisFeedbackDetected.replaceChildren();
  analysisFeedbackMissed.replaceChildren();
  analysisFeedbackGenre.replaceChildren();
  analysisFeedbackFilter.value = '';
  analysisFeedbackDetectedFieldset.hidden = false;
  analysisFeedbackForm.reset();
  analysisFeedbackSubmit.disabled = false;
  showFeedbackStatus('');
  loadedFeedbackJobId = '';
  loadedFeedbackRevision = 0;
  loadedFeedbackDetectedIds = [];
}

function resetAnalysisResult({ clearInput = false } = {}) {
  analysisResult.hidden = true;
  analysisJobMeta.textContent = '';
  analysisCoreRoute.textContent = '';
  analysisRoleVersion.textContent = '';
  analysisReason.textContent = '';
  analysisDiscoveryMeta.textContent = '';
  analysisDetections.replaceChildren();
  analysisDetectionsEmpty.hidden = true;
  analysisDetectionsEmpty.textContent = '';
  resetInstrumentFeedback();
  if (clearInput) analysisForm.reset();
}

function confidencePercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function renderAnalysisReview(record) {
  const routing = record?.autoRouting;
  const analysis = routing?.analysis;
  if (
    !record ||
    typeof record.jobId !== 'string' ||
    !routing ||
    !analysis ||
    !['shadow', 'authoritative'].includes(routing.mode) ||
    typeof routing.applied !== 'boolean' ||
    typeof routing.resolvedCoreModel !== 'string' ||
    typeof analysis.roleClassifier?.version !== 'string' ||
    typeof analysis.decision?.reason !== 'string' ||
    !Array.isArray(analysis.detectedInstruments)
  ) {
    throw new Error('Stored analysis has an unsupported display shape.');
  }

  analysisJobMeta.textContent = `JOB ${record.jobId}`;
  const routeState = routing.applied ? 'APPLIED' : 'NOT APPLIED';
  const degradedState = analysis.degraded?.active
    ? ` · FALLBACK ${String(analysis.degraded.code || 'UNKNOWN').toUpperCase()}`
    : '';
  analysisCoreRoute.textContent =
    `${routing.mode.toUpperCase()} · ${routeState} · ${routing.resolvedCoreModel}${degradedState}`;
  analysisRoleVersion.textContent = analysis.roleClassifier.version;
  analysisReason.textContent = analysis.decision.reason;

  const discovery = analysis.instrumentDiscovery;
  const classifier = analysis.vocabularyClassifier;
  if (discovery?.status === 'complete') {
    const classifierVersion = typeof classifier?.version === 'string'
      ? classifier.version
      : 'CLASSIFIER NOT RECORDED';
    const vocabularyVersion = typeof classifier?.vocabularyVersion === 'string'
      ? classifier.vocabularyVersion
      : 'VOCABULARY NOT RECORDED';
    analysisDiscoveryMeta.textContent =
      `COMPLETE · ${discovery.windowsAnalyzed} WINDOWS · ${discovery.totalMs} MS · ` +
      `${vocabularyVersion} · ${classifierVersion}`;
  } else if (discovery?.status === 'unavailable') {
    analysisDiscoveryMeta.textContent =
      `UNAVAILABLE · ${String(discovery.code || 'NO CODE').toUpperCase()} · ` +
      `${discovery.totalMs} MS`;
  } else {
    analysisDiscoveryMeta.textContent = 'NOT RECORDED';
  }

  analysisDetections.replaceChildren();
  for (const detection of analysis.detectedInstruments) {
    if (
      !detection ||
      typeof detection.id !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(detection.id) ||
      typeof detection.label !== 'string' ||
      typeof detection.confidence !== 'number' ||
      !Number.isFinite(detection.confidence) ||
      detection.confidence < 0 ||
      detection.confidence > 1 ||
      !['possible', 'uncertain'].includes(detection.state) ||
      !Number.isSafeInteger(detection.windowSupport) ||
      detection.windowSupport < 1 ||
      !Number.isSafeInteger(detection.windowsAnalyzed) ||
      detection.windowsAnalyzed < 1 ||
      detection.windowSupport > detection.windowsAnalyzed
    ) {
      throw new Error('Stored instrument detection has an unsupported display shape.');
    }
    const item = document.createElement('li');
    item.className = 'teacher-detection-item';
    item.dataset.instrumentId = detection.id;

    const label = document.createElement('strong');
    label.textContent = detection.label;
    const state = document.createElement('span');
    state.className =
      `teacher-detection-state ${detection.state === 'uncertain' ? 'uncertain' : ''}`;
    state.textContent = detection.state.toUpperCase();
    const metadata = document.createElement('span');
    metadata.className = 'mono teacher-detection-meta';
    metadata.textContent =
      `${confidencePercent(detection.confidence)} · ` +
      `${detection.windowSupport} / ${detection.windowsAnalyzed} WINDOWS`;

    item.append(label, state, metadata);
    analysisDetections.appendChild(item);
  }

  analysisDetectionsEmpty.hidden = analysis.detectedInstruments.length > 0;
  if (analysis.detectedInstruments.length === 0) {
    analysisDetectionsEmpty.textContent = discovery?.status === 'complete'
      ? 'The candidate classifier returned no possible instruments. This is an abstention, not proof that instruments are absent.'
      : 'No candidate detections are available for this stored Auto decision.';
  }
  analysisResult.hidden = false;
  return discovery?.status === 'complete' && Boolean(classifier);
}

const FEEDBACK_KIND_LABELS = Object.freeze({
  'specific-instrument-or-voice': 'SPECIFIC INSTRUMENT / VOICE',
  'family-or-ensemble': 'FAMILY / ENSEMBLE',
  'production-texture': 'PRODUCTION TEXTURE',
});

function reviewOptionMap(context) {
  if (!Array.isArray(context?.reviewOptions) || context.reviewOptions.length < 1) {
    throw new Error('Review vocabulary is unavailable.');
  }
  const options = new Map();
  for (const option of context.reviewOptions) {
    if (
      !option ||
      typeof option.id !== 'string' ||
      typeof option.label !== 'string' ||
      typeof option.family !== 'string' ||
      !Object.prototype.hasOwnProperty.call(FEEDBACK_KIND_LABELS, option.kind) ||
      options.has(option.id)
    ) {
      throw new Error('Review vocabulary has an unsupported display shape.');
    }
    options.set(option.id, option);
  }
  return options;
}

function makeFeedbackKindBadge(option) {
  const badge = document.createElement('span');
  badge.className = `teacher-feedback-kind ${option.kind}`;
  badge.textContent = FEEDBACK_KIND_LABELS[option.kind];
  return badge;
}

function makeFeedbackVerdictControl(instrumentId, verdict, labelText) {
  const label = document.createElement('label');
  label.className = 'teacher-feedback-choice';
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = `feedback-verdict-${instrumentId}`;
  input.value = verdict;
  const text = document.createElement('span');
  text.textContent = labelText;
  label.append(input, text);
  return label;
}

function renderInstrumentFeedbackContext(context) {
  if (
    !context ||
    context.schemaVersion !== '1' ||
    typeof context.jobId !== 'string' ||
    !Number.isSafeInteger(context.currentRevision) ||
    context.currentRevision < 0 ||
    !Array.isArray(context.detectedInstrumentIds) ||
    !Array.isArray(context.genreFamilies) ||
    !context.provenance ||
    typeof context.provenance.analysisSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(context.provenance.analysisSha256) ||
    context.policy?.evidenceStatus !== 'unreviewed-candidate' ||
    context.policy?.deidentified !== false ||
    context.policy?.trainingEligible !== false ||
    context.policy?.affectsCoreRouting !== false ||
    context.policy?.requestsIsolation !== false ||
    context.policy?.overlapHandling !== 'review-separately-do-not-double-count'
  ) {
    throw new Error('Instrument feedback context has an unsupported display shape.');
  }
  const options = reviewOptionMap(context);
  const detectedIds = new Set(context.detectedInstrumentIds);
  if (detectedIds.size !== context.detectedInstrumentIds.length) {
    throw new Error('Instrument feedback context contains duplicate detections.');
  }
  for (const id of detectedIds) {
    if (!options.has(id)) throw new Error('Instrument feedback context contains an unknown detection.');
  }

  const latestObservations = new Map();
  if (context.latest !== null) {
    if (
      !context.latest ||
      context.latest.schemaVersion !== '1' ||
      context.latest.revision !== context.currentRevision ||
      context.latest.evidenceStatus !== 'unreviewed-candidate' ||
      context.latest.deidentified !== false ||
      context.latest.trainingEligible !== false ||
      !Array.isArray(context.latest.observations)
    ) {
      throw new Error('Stored instrument feedback has an unsupported display shape.');
    }
    for (const observation of context.latest.observations) {
      if (
        !observation ||
        typeof observation.instrumentId !== 'string' ||
        !['confirmed', 'absent', 'missed'].includes(observation.verdict) ||
        latestObservations.has(observation.instrumentId)
      ) {
        throw new Error('Stored instrument feedback has an unsupported observation.');
      }
      latestObservations.set(observation.instrumentId, observation.verdict);
    }
  }

  loadedFeedbackJobId = context.jobId;
  loadedFeedbackRevision = context.currentRevision;
  loadedFeedbackDetectedIds = [...detectedIds];
  analysisFeedbackMeta.textContent =
    `REVISION ${context.currentRevision} · TARGET ${context.provenance.analysisSha256.slice(0, 12)}`;

  analysisFeedbackGenre.replaceChildren();
  for (const genre of context.genreFamilies) {
    if (typeof genre !== 'string' || !/^[a-z]+(?:-[a-z]+)*$/.test(genre)) {
      throw new Error('Review genre vocabulary is invalid.');
    }
    const option = document.createElement('option');
    option.value = genre;
    option.textContent = genre.replaceAll('-', ' ').toUpperCase();
    analysisFeedbackGenre.appendChild(option);
  }
  analysisFeedbackGenre.value = context.latest?.genreFamily || 'unknown';

  analysisFeedbackDetected.replaceChildren();
  analysisFeedbackDetectedFieldset.hidden = detectedIds.size === 0;
  for (const instrumentId of detectedIds) {
    const option = options.get(instrumentId);
    const row = document.createElement('div');
    row.className = 'teacher-feedback-detected-row';

    const identity = document.createElement('div');
    identity.className = 'teacher-feedback-identity';
    const name = document.createElement('strong');
    name.textContent = option.label;
    const family = document.createElement('span');
    family.className = 'mono teacher-feedback-family';
    family.textContent = option.family.replaceAll('-', ' ').toUpperCase();
    identity.append(name, makeFeedbackKindBadge(option), family);

    const choices = document.createElement('div');
    choices.className = 'teacher-feedback-choices';
    const confirmed = makeFeedbackVerdictControl(instrumentId, 'confirmed', 'Confirmed audible');
    const absent = makeFeedbackVerdictControl(instrumentId, 'absent', 'Absent / false alert');
    choices.append(confirmed, absent);
    const prior = latestObservations.get(instrumentId);
    if (prior === 'confirmed' || prior === 'absent') {
      choices.querySelector(`input[value="${prior}"]`).checked = true;
    }
    row.append(identity, choices);
    analysisFeedbackDetected.appendChild(row);
  }

  analysisFeedbackMissed.replaceChildren();
  const kindGroups = new Map();
  for (const option of options.values()) {
    if (detectedIds.has(option.id)) continue;
    if (!kindGroups.has(option.kind)) kindGroups.set(option.kind, []);
    kindGroups.get(option.kind).push(option);
  }
  for (const [kind, groupOptions] of kindGroups) {
    const group = document.createElement('section');
    group.className = 'teacher-feedback-missed-group';
    const title = document.createElement('h4');
    title.textContent = FEEDBACK_KIND_LABELS[kind];
    const list = document.createElement('div');
    list.className = 'teacher-feedback-check-grid';
    for (const option of groupOptions) {
      const label = document.createElement('label');
      label.className = 'teacher-feedback-check';
      label.dataset.search =
        `${option.label} ${option.id} ${option.family} ${FEEDBACK_KIND_LABELS[option.kind]}`.toLowerCase();
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = option.id;
      input.checked = latestObservations.get(option.id) === 'missed';
      const text = document.createElement('span');
      text.textContent = option.label;
      const family = document.createElement('small');
      family.textContent = option.family.replaceAll('-', ' ');
      label.append(input, text, family);
      list.appendChild(label);
    }
    group.append(title, list);
    analysisFeedbackMissed.appendChild(group);
  }
  filterInstrumentFeedbackVocabulary();

  showFeedbackStatus(
    context.latest
      ? `REVISION ${context.currentRevision} LOADED · UNREVIEWED CANDIDATE EVIDENCE.`
      : 'NO FEEDBACK REVISION YET.'
  );
  analysisFeedbackPanel.hidden = false;
}

function filterInstrumentFeedbackVocabulary() {
  const query = analysisFeedbackFilter.value.trim().toLowerCase();
  for (const group of analysisFeedbackMissed.querySelectorAll('.teacher-feedback-missed-group')) {
    let visible = 0;
    for (const option of group.querySelectorAll('.teacher-feedback-check')) {
      option.hidden = Boolean(query) && !option.dataset.search.includes(query);
      if (!option.hidden) visible += 1;
    }
    group.hidden = visible === 0;
  }
}

function collectInstrumentFeedbackObservations() {
  const observations = [];
  for (const instrumentId of loadedFeedbackDetectedIds) {
    const checked = analysisFeedbackDetected.querySelector(
      `input[name="feedback-verdict-${instrumentId}"]:checked`
    );
    if (!checked) {
      throw new Error('MARK EVERY SURFACED LABEL CONFIRMED OR ABSENT.');
    }
    observations.push({ instrumentId, verdict: checked.value });
  }
  for (const checked of analysisFeedbackMissed.querySelectorAll('input[type="checkbox"]:checked')) {
    observations.push({ instrumentId: checked.value, verdict: 'missed' });
  }
  if (observations.length === 0) {
    throw new Error('RECORD AT LEAST ONE CONFIRMED, ABSENT, OR MISSED OBSERVATION.');
  }
  return observations;
}

function clearTeacherConsole() {
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
  analysisLoadSequence += 1;
  analysisLoadBtn.disabled = false;
  resetAnalysisResult({ clearInput: true });
  showAnalysisStatus('');
  showingPromptTop = false;
  fixedPromptToggle.setAttribute('aria-expanded', 'false');
  fixedPromptToggleLabel.textContent = 'SEE THE TOP OF THE FIXED PROMPT';
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
  fixedPromptMeta.title =
    `Base multi-variant policy SHA-256: ${record.basePromptHash || 'unavailable'}`;
  effectivePromptMeta.textContent = `EFFECTIVE · ${shortHash(record.effectivePromptHash)}`;
  effectivePromptMeta.title =
    `Effective multi-variant policy SHA-256: ${record.effectivePromptHash || 'unavailable'}`;
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
  setHistoryPagination(record.historyHasMore, record.historyNextBeforeId);
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
  signoutBtn.disabled = true;
  try {
    await api('/api/teacher/logout', { method: 'POST' });
    clearTeacherConsole();
    showPanel(false);
  } catch {
    showStatus('SIGN OUT FAILED — YOUR SESSION MAY STILL BE ACTIVE. TRY AGAIN.', true);
  } finally {
    signoutBtn.disabled = false;
  }
});

analysisForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const jobId = analysisJobId.value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(jobId)) {
    resetAnalysisResult();
    showAnalysisStatus('ENTER A VALID AUTO JOB ID.', true);
    analysisJobId.focus();
    return;
  }

  const requestSequence = ++analysisLoadSequence;
  analysisLoadBtn.disabled = true;
  resetAnalysisResult();
  showAnalysisStatus('LOADING ADVISORY ANALYSIS…');
  try {
    const record = await api(`/api/teacher/jobs/${encodeURIComponent(jobId)}/analysis`);
    if (requestSequence !== analysisLoadSequence) return;
    const feedbackAvailable = renderAnalysisReview(record);
    if (feedbackAvailable) {
      const feedback = await api(
        `/api/teacher/jobs/${encodeURIComponent(jobId)}/instrument-feedback`
      );
      if (requestSequence !== analysisLoadSequence) return;
      renderInstrumentFeedbackContext(feedback);
    }
    showAnalysisStatus(
      feedbackAvailable
        ? 'ADVISORY ANALYSIS AND CANDIDATE REVIEW LOADED — NO ROUTING OR ISOLATION CHANGE.'
        : 'ADVISORY ANALYSIS LOADED — NO ROUTING OR ISOLATION CHANGE.'
    );
  } catch (error) {
    if (requestSequence !== analysisLoadSequence) return;
    resetAnalysisResult();
    showAnalysisStatus(error.message, true);
  } finally {
    if (requestSequence === analysisLoadSequence) analysisLoadBtn.disabled = false;
  }
});

analysisFeedbackForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!loadedFeedbackJobId) {
    showFeedbackStatus('LOAD A REVIEWABLE AUTO ANALYSIS FIRST.', true);
    return;
  }
  let observations;
  try {
    observations = collectInstrumentFeedbackObservations();
  } catch (error) {
    showFeedbackStatus(error.message, true);
    return;
  }

  const requestSequence = analysisLoadSequence;
  analysisFeedbackSubmit.disabled = true;
  showFeedbackStatus('RECORDING CANDIDATE FEEDBACK…');
  try {
    const result = await api(
      `/api/teacher/jobs/${encodeURIComponent(loadedFeedbackJobId)}/instrument-feedback`,
      {
        method: 'POST',
        body: JSON.stringify({
          expectedRevision: loadedFeedbackRevision,
          genreFamily: analysisFeedbackGenre.value,
          observations,
        }),
      }
    );
    if (requestSequence !== analysisLoadSequence) return;
    const context = await api(
      `/api/teacher/jobs/${encodeURIComponent(loadedFeedbackJobId)}/instrument-feedback`
    );
    if (requestSequence !== analysisLoadSequence) return;
    renderInstrumentFeedbackContext(context);
    showFeedbackStatus(
      result.changed
        ? `REVISION ${result.feedback.revision} RECORDED · UNREVIEWED · NOT TRAINING ELIGIBLE.`
        : `NO CHANGE · REVISION ${result.feedback.revision} RETAINED.`
    );
  } catch (error) {
    if (requestSequence !== analysisLoadSequence) return;
    showFeedbackStatus(error.message, true);
  } finally {
    if (requestSequence === analysisLoadSequence) analysisFeedbackSubmit.disabled = false;
  }
});

analysisFeedbackFilter.addEventListener('input', filterInstrumentFeedbackVocabulary);

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

historyMoreBtn.addEventListener('click', async () => {
  if (historyLoading || historyNextBeforeId === null) return;
  historyLoading = true;
  historyMoreBtn.disabled = true;
  historyMoreBtn.textContent = 'LOADING EARLIER REVISIONS…';
  try {
    const page = await api(
      `/api/teacher/prompt/history?before=${encodeURIComponent(historyNextBeforeId)}`
    );
    renderHistory(page.history || [], true);
    setHistoryPagination(page.historyHasMore, page.historyNextBeforeId);
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    historyLoading = false;
    historyMoreBtn.disabled = false;
    historyMoreBtn.textContent = 'LOAD EARLIER REVISIONS';
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
