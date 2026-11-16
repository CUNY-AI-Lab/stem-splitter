(() => {
  'use strict';
  const SCHEMA = 'stem-browser-local-state-v1';
  const STAGE_PREFIX = 'stem-browser-recovery:v1:';
  const ACTIVE_PREFIX = 'stem-browser-recovery-active:v1:';
  const RACK_PREFIX = 'stem-browser-recovery-hidden:v1:';
  const hiddenRackIds = new Map();
  const ID = /^[A-Za-z0-9-]{1,80}$/;
  const SUBJECT = /^(?:cail-[0-9a-f]{32}|guest-[0-9a-f]{64})$/;
  const STEM = /^[A-Za-z0-9_-]{1,80}$/;
  const SAMPLE = /^[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9_.-]{1,120}$/;
  const clone = value => JSON.parse(JSON.stringify(value));
  const plain = value => value && typeof value === 'object' && !Array.isArray(value);

  function normalizePending(value) {
    if (!plain(value)) return null;
    const conversation = value.pendingConversation;
    const pendingConversation = conversation && Number.isSafeInteger(conversation.revision) && conversation.revision >= 0
      && Array.isArray(conversation.entries) && conversation.entries.length <= 60
      && conversation.entries.every(entry => plain(entry) && ['you', 'coach', 'action'].includes(entry.kind)
        && typeof entry.text === 'string' && entry.text.trim() && entry.text.length <= 3000)
      ? { revision: conversation.revision, entries: conversation.entries.map(({ kind, text }) => ({ kind, text })) } : null;
    const chat = value.pendingChat;
    const pendingChat = chat && typeof chat.messageId === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(chat.messageId)
      && Array.isArray(chat.messages) && chat.messages.length > 0 && chat.messages.length <= 12
      && chat.messages.at(-1)?.role === 'user'
      && chat.messages.every(turn => plain(turn) && ['user', 'assistant'].includes(turn.role)
        && typeof turn.content === 'string' && turn.content.trim() && turn.content.length <= 2000)
      ? { messageId: chat.messageId, messages: chat.messages.map(({ role, content }) => ({ role, content })),
        ...(Number.isFinite(chat.durationSec) && chat.durationSec > 0 ? { durationSec: chat.durationSec } : {}),
        ...(Number.isSafeInteger(chat.revision) && chat.revision >= 0 ? { revision: chat.revision } : {}) } : null;
    const guide = value.pendingGuide;
    const pendingGuide = guide && typeof guide.messageId === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(guide.messageId)
      ? { messageId: guide.messageId, ...(Number.isFinite(guide.durationSec) && guide.durationSec > 0 ? { durationSec: guide.durationSec } : {}) } : null;
    return {
      ...(typeof value.draft === 'string' && value.draft.trim() && value.draft.length <= 2000 ? { draft: value.draft } : {}),
      ...(pendingConversation ? { pendingConversation } : {}),
      ...(pendingChat ? { pendingChat } : {}),
      ...(pendingGuide ? { pendingGuide } : {}),
    };
  }

  function normalizePlayback(value) {
    if (!plain(value)) return null;
    return {
      position: Number.isFinite(value.position) && value.position >= 0 ? Math.min(value.position, 86400) : 0,
      rate: [0.5, 0.75, 1, 1.25, 1.5].includes(value.rate) ? value.rate : 1,
      muted: Array.isArray(value.muted) ? [...new Set(value.muted.filter(name => typeof name === 'string' && STEM.test(name)))].slice(0, 24) : [],
      solo: plain(value.solo) && STEM.test(value.solo.stem) && ['behind', 'only'].includes(value.solo.stage)
        ? { stem: value.solo.stem, stage: value.solo.stage } : null,
      guideOpen: value.guideOpen === true,
      loop: plain(value.loop) && Number.isFinite(value.loop.start) && value.loop.start >= 0
        && Number.isFinite(value.loop.end) && value.loop.end > value.loop.start && value.loop.end <= 86400
        ? { start: value.loop.start, end: value.loop.end } : null,
    };
  }

  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
  }

  function exportLocal(subject) {
    if (!SUBJECT.test(subject || '')) throw new Error('account_unavailable');
    const rawJobs = readJson(`jobs:${subject}`);
    const jobs = Array.isArray(rawJobs) ? rawJobs.filter(job => plain(job) && typeof job.id === 'string' && ID.test(job.id))
      .slice(0, 500).map(job => ({ id: job.id, collapsed: job.collapsed === true })) : [];
    const ids = new Set(jobs.map(job => job.id));
    // Listening state survives removal from the rack (for example, moving a
    // split into a class folder). Include only this exact account namespace.
    try {
      const prefix = `stem-listening:${subject}:`;
      for (let index = 0; index < localStorage.length && ids.size < 500; index++) {
        const key = localStorage.key(index);
        const id = key?.startsWith(prefix) ? key.slice(prefix.length) : '';
        if (ID.test(id) && localStorage.getItem(key) !== null) ids.add(id);
      }
    } catch { /* Keep the bounded rack export if storage enumeration is unavailable. */ }
    const playback = [], recovery = [];
    for (const id of ids) {
      const value = readJson(`stem-listening:${subject}:${id}`);
      const normalized = normalizePlayback(value);
      if (normalized) playback.push({ jobId: id, value: normalized });
      const backup = normalizePending(value);
      if (backup && Object.keys(backup).length) recovery.push({ jobId: id, ...backup });
    }
    const splitChoice = localStorage.getItem('stem-split-choice-v1');
    const workspaceChoice = localStorage.getItem(`stem-workspace-choice:v1:${subject}`);
    const rawRotation = readJson('stem-song-rotation-v1');
    const rotation = plain(rawRotation) ? {
      ...(typeof rawRotation.revision === 'string' && rawRotation.revision.length <= 120 ? { revision: rawRotation.revision } : {}),
      seen: Array.isArray(rawRotation.seen) ? rawRotation.seen.filter(value => typeof value === 'string' && SAMPLE.test(value)).slice(-64) : [],
      last: typeof rawRotation.last === 'string' && SAMPLE.test(rawRotation.last) ? rawRotation.last : '',
      pass: Number.isSafeInteger(rawRotation.pass) && rawRotation.pass >= 0 ? Math.min(rawRotation.pass, 10000) : 0,
      order: Array.isArray(rawRotation.order) ? rawRotation.order.filter(value => typeof value === 'string' && SAMPLE.test(value)).slice(0, 64) : [],
    } : null;
    const benchTab = localStorage.getItem('benchTab');
    return {
      schema: SCHEMA,
      jobs,
      playback,
      recovery,
      preferences: {
        ...(typeof workspaceChoice === 'string' && workspaceChoice.length <= 128 ? { workspaceChoice } : {}),
        ...(typeof splitChoice === 'string' && splitChoice.length <= 80 ? { splitChoice } : {}),
        ...(rotation ? { songRotation: rotation } : {}),
        ...(benchTab === 'splitter' || benchTab === 'remixer' ? { benchTab } : {}),
      },
    };
  }

  function normalizePayload(input, subject, allowedJobIds, courseIds, splitChoices, sampleIds) {
    if (!plain(input) || input.schema !== SCHEMA || !SUBJECT.test(subject || '') || !Array.isArray(input.jobs)
      || !Array.isArray(input.playback) || !Array.isArray(input.recovery) || !plain(input.preferences)) return null;
    const allowed = new Set(allowedJobIds.filter(id => typeof id === 'string' && ID.test(id)));
    const jobs = [], seenJobs = new Set();
    for (const job of input.jobs.slice(0, 500)) {
      if (!plain(job) || typeof job.id !== 'string' || !allowed.has(job.id) || seenJobs.has(job.id)) continue;
      seenJobs.add(job.id); jobs.push({ id: job.id, collapsed: job.collapsed === true });
    }
    const playback = [], seenPlayback = new Set();
    for (const entry of input.playback.slice(0, 500)) {
      if (!plain(entry) || typeof entry.jobId !== 'string' || !allowed.has(entry.jobId) || seenPlayback.has(entry.jobId)) continue;
      const value = normalizePlayback(entry.value);
      if (value) { playback.push({ jobId: entry.jobId, value }); seenPlayback.add(entry.jobId); }
    }
    const recovery = [], seenRecovery = new Set();
    for (const entry of input.recovery.slice(0, 500)) {
      if (!plain(entry) || typeof entry.jobId !== 'string' || !allowed.has(entry.jobId) || seenRecovery.has(entry.jobId)) continue;
      const pending = normalizePending(entry);
      if (pending && Object.keys(pending).length) { recovery.push({ jobId: entry.jobId, ...pending }); seenRecovery.add(entry.jobId); }
    }
    const prefs = input.preferences;
    const preferences = {
      ...(prefs.workspaceChoice === 'personal' || courseIds.has(prefs.workspaceChoice) ? { workspaceChoice: prefs.workspaceChoice } : {}),
      ...(splitChoices.has(prefs.splitChoice) ? { splitChoice: prefs.splitChoice } : {}),
      ...(prefs.benchTab === 'splitter' || prefs.benchTab === 'remixer' ? { benchTab: prefs.benchTab } : {}),
    };
    const sourceRotation = prefs.songRotation;
    if (plain(sourceRotation)) {
      const seen = [...new Set(Array.isArray(sourceRotation.seen) ? sourceRotation.seen.filter(id => sampleIds.has(id)) : [])].slice(-64);
      const last = sampleIds.has(sourceRotation.last) ? sourceRotation.last : '';
      const pass = Number.isSafeInteger(sourceRotation.pass) && sourceRotation.pass >= 0 ? Math.min(sourceRotation.pass, 10000) : 0;
      const order = Array.isArray(sourceRotation.order) ? sourceRotation.order.filter(id => sampleIds.has(id)).slice(0, 64) : [];
      if (seen.length || last || order.length) preferences.songRotation = {
        ...(typeof sourceRotation.revision === 'string' && sourceRotation.revision.length <= 120 ? { revision: sourceRotation.revision } : {}),
        seen, last, pass, order,
      };
    }
    const payload = { schema: SCHEMA, subject, jobs, playback, recovery, preferences };
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 512 * 1024) return null;
    return payload;
  }

  function stage(subject, payload) {
    const id = crypto.randomUUID();
    const key = STAGE_PREFIX + id;
    const record = { schema: SCHEMA, id, subject, createdAt: Date.now(), payload };
    try {
      if (localStorage.getItem(key) !== null) return null;
      localStorage.setItem(key, JSON.stringify(record));
      return id;
    } catch { return null; }
  }

  function getStage(id, subject) {
    if (!/^[0-9a-f-]{36}$/i.test(id || '') || !SUBJECT.test(subject || '')) return null;
    const record = readJson(STAGE_PREFIX + id);
    if (!plain(record) || record.schema !== SCHEMA || record.id !== id || record.subject !== subject
      || !plain(record.payload) || record.payload.schema !== SCHEMA || record.payload.subject !== subject
      || !Array.isArray(record.payload.jobs) || record.payload.jobs.length > 500
      || !Array.isArray(record.payload.playback) || record.payload.playback.length > 500
      || !Array.isArray(record.payload.recovery) || record.payload.recovery.length > 500
      || !plain(record.payload.preferences) || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) return null;
    const candidates = new Set();
    for (const group of [record.payload.jobs, record.payload.playback, record.payload.recovery]) {
      for (const item of group) {
        const id = group === record.payload.jobs ? item?.id : item?.jobId;
        if (typeof id !== 'string' || !ID.test(id)) return null;
        candidates.add(id);
      }
    }
    const prefs = record.payload.preferences;
    const courses = new Set(['personal', ...(typeof prefs.workspaceChoice === 'string' ? [prefs.workspaceChoice] : [])]);
    const splits = new Set(typeof prefs.splitChoice === 'string' ? [prefs.splitChoice] : []);
    const rotation = prefs.songRotation;
    const samples = new Set(plain(rotation) ? [rotation.last, ...(Array.isArray(rotation.seen) ? rotation.seen : []), ...(Array.isArray(rotation.order) ? rotation.order : [])].filter(value => typeof value === 'string') : []);
    const canonical = normalizePayload(record.payload, subject, [...candidates], courses, splits, samples);
    return canonical && JSON.stringify(canonical) === JSON.stringify(record.payload) ? record : null;
  }

  function listStages(subject) {
    if (!SUBJECT.test(subject || '')) return [];
    const out = [];
    try {
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (!key?.startsWith(STAGE_PREFIX)) continue;
        const record = readJson(key);
        const id = key.slice(STAGE_PREFIX.length);
        const validated = plain(record) && record.subject === subject && record.schema === SCHEMA && record.id === id
          ? getStage(id, subject) : null;
        if (validated) out.push(validated);
      }
    } catch { return []; }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  function active(subject) {
    if (!SUBJECT.test(subject || '')) return null;
    try {
      const id = localStorage.getItem(ACTIVE_PREFIX + subject);
      const record = id ? getStage(id, subject) : null;
      return record?.payload || null;
    } catch { return null; }
  }

  function activate(id, subject) {
    const record = getStage(id, subject);
    if (!record) return false;
    try { localStorage.setItem(ACTIVE_PREFIX + subject, id); return true; } catch { return false; }
  }

  function mergeJobs(subject, base) {
    const imported = active(subject)?.jobs || [];
    const existing = Array.isArray(base) ? base : [];
    const ids = new Set(existing.filter(job => plain(job) && typeof job.id === 'string').map(job => job.id));
    const key = rackKey(subject);
    const saved = key ? readJson(key) : null;
    const hidden = (key && hiddenRackIds.get(key)) || new Set(Array.isArray(saved) ? saved.filter(id => typeof id === 'string' && ID.test(id)).slice(0, 500) : []);
    return [...imported.filter(job => !ids.has(job.id) && !hidden.has(job.id)).map(job => ({ id: job.id, collapsed: job.collapsed })), ...existing];
  }

  function rackKey(subject) {
    if (!SUBJECT.test(subject || '')) return null;
    try {
      const id = localStorage.getItem(ACTIVE_PREFIX + subject);
      return /^[0-9a-f-]{36}$/i.test(id || '') ? `${RACK_PREFIX}${subject}:${id}` : null;
    } catch { return null; }
  }

  // Record rack removals separately; the imported recovery copy stays immutable.
  function rememberRack(subject, jobs) {
    const key = rackKey(subject);
    if (!key || !Array.isArray(jobs)) return;
    const ids = new Set(jobs.map(job => job?.id));
    const hidden = new Set((active(subject)?.jobs || []).filter(job => !ids.has(job.id)).map(job => job.id));
    hiddenRackIds.set(key, hidden);
    try { localStorage.setItem(key, JSON.stringify([...hidden])); } catch { /* Keep removals for this page if browser storage is unavailable. */ }
  }

  function playback(subject, jobId, base) {
    if (base !== null && base !== undefined) return base;
    return active(subject)?.playback?.find(entry => entry.jobId === jobId)?.value || null;
  }

  function preference(subject, name, base) {
    if (base !== null && base !== undefined) return base;
    return active(subject)?.preferences?.[name] ?? null;
  }

  function restoreRecovery(id, subject, jobId, field) {
    const record = getStage(id, subject);
    const item = record?.payload.recovery?.find(entry => entry.jobId === jobId);
    if (field !== 'draft') return { ok: false, reason: 'manual_only' };
    if (!item || !(field in item)) return { ok: false, reason: 'missing' };
    const saved = window.StemListeningProgress?.read(subject, jobId) || { draft: '', position: 0, rate: 1, muted: [], solo: null, guideOpen: false, loop: null };
    if (saved.draft) return { ok: false, reason: 'conflict' };
    saved[field] = clone(item[field]);
    if (!window.StemListeningProgress?.save) return { ok: false, reason: 'storage' };
    window.StemListeningProgress?.save(subject, jobId, saved);
    try {
      const written = JSON.parse(localStorage.getItem(`stem-listening:${subject}:${jobId}`) || 'null');
      if (!plain(written) || written.draft !== item.draft) return { ok: false, reason: 'storage' };
    } catch { return { ok: false, reason: 'storage' }; }
    return { ok: true };
  }

  window.StemBrowserStateTransfer = Object.freeze({
    exportLocal,
    normalizePayload,
    stage,
    getStage,
    listStages,
    active,
    activate,
    mergeJobs,
    rememberRack,
    playback,
    preference,
    restoreRecovery,
    schema: SCHEMA,
  });
})();
