'use strict';

const elements = {
  overallProgress: document.getElementById('overall-progress'),
  saveState: document.getElementById('save-state'),
  sourcePicker: document.getElementById('source-picker'),
  previousSource: document.getElementById('previous-source'),
  nextSource: document.getElementById('next-source'),
  reviewPanel: document.getElementById('review-panel'),
  sourceKind: document.getElementById('source-kind'),
  sourceTitle: document.getElementById('source-title'),
  sourceAudio: document.getElementById('source-audio'),
  sourceProgress: document.getElementById('source-progress'),
  markRemainingAbsent: document.getElementById('mark-remaining-absent'),
  instrumentGroups: document.getElementById('instrument-groups'),
  wholeSourceListened: document.getElementById('whole-source-listened'),
  previousSourceBottom: document.getElementById('previous-source-bottom'),
  nextSourceBottom: document.getElementById('next-source-bottom'),
  finishPanel: document.getElementById('finish-panel'),
  reviewerName: document.getElementById('reviewer-name'),
  attestationCheck: document.getElementById('attestation-check'),
  attestationText: document.getElementById('attestation-text'),
  completeReview: document.getElementById('complete-review'),
  finishStatus: document.getElementById('finish-status'),
  loadError: document.getElementById('load-error'),
};

const VERDICT_LABELS = {
  audible: 'Audible',
  absent: 'Not heard',
  uncertain: 'Unsure',
};

const FAMILY_LABELS = {
  voice: 'Voice',
  'bowed-strings': 'Bowed strings',
  'plucked-strings': 'Plucked strings',
  brass: 'Brass',
  woodwind: 'Woodwind',
  keys: 'Keys',
  electronic: 'Electronic',
  percussion: 'Percussion',
  'free-reed': 'Free reed',
  traditional: 'Traditional',
};

let state = null;
let sourceIndex = 0;
let saveTimer = null;
let saveSequence = Promise.resolve();
let bulkConfirmTimer = null;
let bulkConfirmArmed = false;

function sourceComplete(source) {
  return source.wholeSourceListened && source.verdicts.every(function (item) {
    return item.verdict !== 'unreviewed';
  });
}

function sourceReviewedCount(source) {
  return source.verdicts.filter(function (item) {
    return item.verdict !== 'unreviewed';
  }).length;
}

function setSaveState(label, className) {
  elements.saveState.textContent = label;
  elements.saveState.className = className || '';
}

function reopenCompletedReview() {
  if (state.review.reviewer || state.review.reviewedAt || state.review.attestation) {
    state.review.reviewer = '';
    state.review.reviewedAt = '';
    state.review.attestation = '';
  }
}

function resetBulkConfirm() {
  clearTimeout(bulkConfirmTimer);
  bulkConfirmTimer = null;
  bulkConfirmArmed = false;
  elements.markRemainingAbsent.classList.remove('confirming');
  elements.markRemainingAbsent.textContent = 'Set remaining to not heard';
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(function () { return {}; });
  if (!response.ok) throw new Error(body.error || 'Private review request failed.');
  return body;
}

function updateOverallProgress() {
  const completed = state.review.sources.filter(sourceComplete).length;
  elements.overallProgress.textContent = completed + ' of ' + state.review.sources.length + ' recordings complete';
  elements.finishPanel.hidden = completed !== state.review.sources.length;
  elements.reviewerName.value = state.review.reviewer || '';
  elements.attestationCheck.checked = state.review.attestation === state.attestation;
  elements.attestationText.textContent = state.attestation;
  elements.finishStatus.textContent = state.review.reviewedAt
    ? 'Worksheet completed ' + new Date(state.review.reviewedAt).toLocaleString() + '.'
    : '';
}

function updateSourcePicker() {
  elements.sourcePicker.replaceChildren();
  state.sources.forEach(function (source, index) {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = (sourceComplete(state.review.sources[index]) ? '✓ ' : '') + (index + 1) + '. ' + source.label;
    elements.sourcePicker.appendChild(option);
  });
  elements.sourcePicker.value = String(sourceIndex);
}

function familyOptions() {
  const groups = new Map();
  state.options.forEach(function (option) {
    if (!groups.has(option.family)) groups.set(option.family, []);
    groups.get(option.family).push(option);
  });
  return groups;
}

function verdictButton(source, verdict, value) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'verdict-button';
  button.dataset.instrumentId = verdict.instrumentId;
  button.dataset.verdict = value;
  button.textContent = VERDICT_LABELS[value];
  button.setAttribute('aria-pressed', String(verdict.verdict === value));
  button.addEventListener('click', function () {
    if (verdict.verdict === value) return;
    resetBulkConfirm();
    reopenCompletedReview();
    verdict.verdict = value;
    if (source.wholeSourceListened && source.verdicts.some(function (item) { return item.verdict === 'unreviewed'; })) {
      source.wholeSourceListened = false;
    }
    renderCurrentSource();
    const nextFocus = Array.from(document.querySelectorAll('.verdict-button')).find(function (candidate) {
      return candidate.dataset.instrumentId === verdict.instrumentId && candidate.dataset.verdict === value;
    });
    if (nextFocus) nextFocus.focus();
    scheduleSave();
  });
  return button;
}

function renderInstrumentGroups(source) {
  const openFamilies = new Set(Array.from(
    elements.instrumentGroups.querySelectorAll('.instrument-group[open]')
  ).map(function (details) { return details.dataset.family; }));
  elements.instrumentGroups.replaceChildren();
  let openedIncompleteGroup = false;
  familyOptions().forEach(function (options, family) {
    const details = document.createElement('details');
    details.className = 'instrument-group';
    details.dataset.family = family;
    const reviewed = options.filter(function (option) {
      return source.verdicts.find(function (item) { return item.instrumentId === option.id; }).verdict !== 'unreviewed';
    }).length;
    if (openFamilies.has(family) || (!openFamilies.size && !openedIncompleteGroup && reviewed < options.length)) {
      details.open = true;
      openedIncompleteGroup = true;
    }
    const summary = document.createElement('summary');
    const label = document.createElement('span');
    label.textContent = FAMILY_LABELS[family] || family;
    const count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = reviewed + '/' + options.length;
    const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.setAttribute('class', 'group-chevron');
    chevron.setAttribute('viewBox', '0 0 24 24');
    chevron.setAttribute('aria-hidden', 'true');
    const chevronPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    chevronPath.setAttribute('d', 'm6 9 6 6 6-6');
    chevron.appendChild(chevronPath);
    summary.append(label, count, chevron);
    details.appendChild(summary);
    const list = document.createElement('div');
    list.className = 'instrument-list';
    options.forEach(function (option) {
      const verdict = source.verdicts.find(function (item) { return item.instrumentId === option.id; });
      const row = document.createElement('div');
      row.className = 'instrument-row';
      const instrumentLabel = document.createElement('span');
      instrumentLabel.className = 'instrument-label';
      instrumentLabel.textContent = option.label;
      const control = document.createElement('div');
      control.className = 'verdict-control';
      control.setAttribute('role', 'group');
      control.setAttribute('aria-label', option.label);
      control.append(
        verdictButton(source, verdict, 'audible'),
        verdictButton(source, verdict, 'absent'),
        verdictButton(source, verdict, 'uncertain')
      );
      row.append(instrumentLabel, control);
      list.appendChild(row);
    });
    details.appendChild(list);
    elements.instrumentGroups.appendChild(details);
  });
}

function renderCurrentSource() {
  const descriptor = state.sources[sourceIndex];
  const source = state.review.sources[sourceIndex];
  const reviewed = sourceReviewedCount(source);
  const completeLabels = reviewed === source.verdicts.length;
  elements.reviewPanel.hidden = false;
  elements.sourceKind.textContent = descriptor.kindLabel + ' · ' + (sourceIndex + 1) + ' of ' + state.sources.length;
  elements.sourceTitle.textContent = descriptor.label;
  if (elements.sourceAudio.dataset.sourceIndex !== String(sourceIndex)) {
    elements.sourceAudio.pause();
    elements.sourceAudio.src = descriptor.audioUrl;
    elements.sourceAudio.dataset.sourceIndex = String(sourceIndex);
    elements.sourceAudio.load();
  }
  elements.sourceProgress.textContent = reviewed + ' of ' + source.verdicts.length + ' instruments reviewed';
  elements.wholeSourceListened.disabled = !completeLabels;
  elements.wholeSourceListened.checked = source.wholeSourceListened;
  elements.wholeSourceListened.title = completeLabels ? '' : 'Finish every instrument row first.';
  elements.markRemainingAbsent.disabled = reviewed === source.verdicts.length;
  elements.previousSource.disabled = sourceIndex === 0;
  elements.previousSourceBottom.disabled = sourceIndex === 0;
  elements.nextSource.disabled = sourceIndex === state.sources.length - 1;
  elements.nextSourceBottom.textContent = sourceIndex === state.sources.length - 1 ? 'Save' : 'Save and continue';
  renderInstrumentGroups(source);
  updateSourcePicker();
  updateOverallProgress();
}

function performSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  setSaveState('Saving', 'saving');
  saveSequence = saveSequence.catch(function () {}).then(function () {
    return requestJson('/api/review', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.review),
    });
  }).then(function () {
    setSaveState('Saved', '');
  }).catch(function (error) {
    setSaveState('Save failed', 'error');
    elements.loadError.hidden = false;
    elements.loadError.textContent = error.message;
    throw error;
  });
  return saveSequence;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  setSaveState('Unsaved', 'saving');
  saveTimer = setTimeout(performSave, 350);
}

async function moveToSource(index) {
  if (index < 0 || index >= state.sources.length || index === sourceIndex) return;
  if (saveTimer) await performSave();
  else await saveSequence;
  sourceIndex = index;
  resetBulkConfirm();
  elements.instrumentGroups.replaceChildren();
  renderCurrentSource();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

elements.sourcePicker.addEventListener('change', function () {
  moveToSource(Number(elements.sourcePicker.value));
});

elements.previousSource.addEventListener('click', function () { moveToSource(sourceIndex - 1); });
elements.nextSource.addEventListener('click', function () { moveToSource(sourceIndex + 1); });
elements.previousSourceBottom.addEventListener('click', function () { moveToSource(sourceIndex - 1); });
elements.nextSourceBottom.addEventListener('click', async function () {
  if (saveTimer) await performSave();
  else await saveSequence;
  if (sourceIndex < state.sources.length - 1) await moveToSource(sourceIndex + 1);
});

elements.markRemainingAbsent.addEventListener('click', function () {
  const source = state.review.sources[sourceIndex];
  const remaining = source.verdicts.filter(function (item) { return item.verdict === 'unreviewed'; }).length;
  if (!remaining) return;
  if (!bulkConfirmArmed) {
    bulkConfirmArmed = true;
    elements.markRemainingAbsent.classList.add('confirming');
    elements.markRemainingAbsent.textContent = 'Mark ' + remaining + ' as not heard?';
    bulkConfirmTimer = setTimeout(resetBulkConfirm, 5000);
    return;
  }
  resetBulkConfirm();
  reopenCompletedReview();
  source.verdicts.forEach(function (item) {
    if (item.verdict === 'unreviewed') item.verdict = 'absent';
  });
  renderCurrentSource();
  scheduleSave();
});

elements.wholeSourceListened.addEventListener('change', function () {
  const source = state.review.sources[sourceIndex];
  if (source.verdicts.some(function (item) { return item.verdict === 'unreviewed'; })) {
    elements.wholeSourceListened.checked = false;
    return;
  }
  reopenCompletedReview();
  source.wholeSourceListened = elements.wholeSourceListened.checked;
  renderCurrentSource();
  scheduleSave();
});

elements.completeReview.addEventListener('click', async function () {
  const reviewer = elements.reviewerName.value.trim();
  if (!reviewer) {
    elements.finishStatus.textContent = 'Enter your name.';
    elements.reviewerName.focus();
    return;
  }
  if (!elements.attestationCheck.checked) {
    elements.finishStatus.textContent = 'Confirm the listening statement.';
    elements.attestationCheck.focus();
    return;
  }
  state.review.reviewer = reviewer;
  state.review.reviewedAt = new Date().toISOString();
  state.review.attestation = state.attestation;
  elements.completeReview.disabled = true;
  try {
    await performSave();
    updateOverallProgress();
    elements.finishStatus.textContent = 'Worksheet complete. Return to Codex.';
  } catch {
    elements.completeReview.disabled = false;
  }
});

async function load() {
  try {
    state = await requestJson('/api/state');
    const firstIncomplete = state.review.sources.findIndex(function (source) { return !sourceComplete(source); });
    sourceIndex = firstIncomplete >= 0 ? firstIncomplete : 0;
    renderCurrentSource();
    setSaveState('Saved', '');
  } catch (error) {
    elements.loadError.hidden = false;
    elements.loadError.textContent = error.message;
    setSaveState('Unavailable', 'error');
  }
}

load();
