import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { browserTransferContract } from '../src/browser-transfer.ts';

const source = readFileSync(new URL('../public/browser-state-transfer.js', import.meta.url), 'utf8');
const subject = `cail-${'a'.repeat(32)}`;
const other = `cail-${'b'.repeat(32)}`;
function browser({ quota = Infinity } = {}) {
  const data = new Map();
  const storage = {
    get length() { return data.size; },
    key(index) { return [...data.keys()][index] ?? null; },
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { if (String(value).length + [...data.values()].reduce((sum, item) => sum + item.length, 0) > quota) throw new Error('quota'); data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
  };
  const window = {};
  runInNewContext(source, { window, localStorage: storage, crypto: { randomUUID: () => '12345678-1234-4234-8234-123456789abc' }, TextEncoder, Date, JSON, Set, Map, Uint8Array });
  return { api: window.StemBrowserStateTransfer, storage, window };
}

test('rack removal and unavailable-job cleanup do not resurrect imported rows', () => {
  const b = browser();
  const payload = { schema: b.api.schema, subject, jobs: [{ id: 'job-1', collapsed: false }, { id: 'job-2', collapsed: true }], playback: [], recovery: [], preferences: {} };
  const id = b.api.stage(subject, payload);
  assert.equal(b.api.activate(id, subject), true);
  const original = b.storage.getItem(`stem-browser-recovery:v1:${id}`);
  const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const functions = appSource.slice(appSource.indexOf('function getJobs()'), appSource.indexOf('// A new song takes the spotlight:'));
  const app = runInNewContext(`let accountJobs = []; const runtime = { authMode: 'cail' }; const accountSubject = subject; const jobsStorageKey = 'jobs:' + subject; ${functions}; ({ getJobs, saveJobs })`, {
    subject, window: b.window, localStorage: b.storage, JSON,
  });
  assert.equal(app.getJobs().length, 2);
  app.saveJobs(app.getJobs().filter(job => job.id !== 'job-1'));
  assert.deepEqual(JSON.parse(JSON.stringify(app.getJobs().map(job => job.id))), ['job-2']);
  // A fresh page must honor the removal; immutable recovery bytes remain intact.
  const freshWindow = {};
  runInNewContext(source, { window: freshWindow, localStorage: b.storage, TextEncoder, JSON, Set, Map });
  assert.deepEqual(JSON.parse(JSON.stringify(freshWindow.StemBrowserStateTransfer.mergeJobs(subject, []).map(job => job.id))), ['job-2']);
  app.saveJobs([]);
  assert.equal(app.getJobs().length, 0);
  assert.equal(b.storage.getItem(`stem-browser-recovery:v1:${id}`), original);
  assert.equal(b.api.mergeJobs(other, []).length, 0);
});

test('export is subject-bound, allowlisted, and keeps unfinished requests only as recovery data', () => {
  const b = browser();
  b.storage.setItem(`jobs:${subject}`, JSON.stringify([{ id: 'job-1', collapsed: true, filename: 'private.wav' }, { id: '../other', collapsed: false }]));
  b.storage.setItem(`stem-listening:${subject}:job-1`, JSON.stringify({ position: 23, rate: 1.25, draft: 'unfinished', pendingChat: { messageId: 'message_0123456789', messages: [{ role: 'user', content: 'do not replay' }] } }));
  b.storage.setItem('coachChat', 'legacy secret');
  b.storage.setItem('classCode', 'legacy code');
  b.storage.setItem('stem-song-rotation-v1', JSON.stringify({ seen: ['archive/file.wav', '../bad'], order: ['archive/file.wav'] }));
  const copy = b.api.exportLocal(subject);
  assert.deepEqual(JSON.parse(JSON.stringify(copy.jobs)), [{ id: 'job-1', collapsed: true }]);
  assert.equal(copy.recovery[0].draft, 'unfinished');
  assert.equal(copy.recovery[0].pendingChat.messages[0].content, 'do not replay');
  assert.equal(copy.preferences.songRotation.seen[0], 'archive/file.wav');
  assert.equal('coachChat' in copy, false);
  assert.equal('classCode' in copy, false);
  assert.deepEqual(JSON.parse(JSON.stringify(b.api.exportLocal(other).jobs)), []);
});

test('export includes retained listening data for a split removed from the rack', () => {
  const b = browser();
  b.storage.setItem(`jobs:${subject}`, JSON.stringify([]));
  b.storage.setItem(`stem-listening:${subject}:folder-job`, JSON.stringify({ position: 42, rate: 1, draft: 'retained note' }));
  b.storage.setItem(`stem-listening:${other}:private-job`, JSON.stringify({ position: 99, rate: 1, draft: 'other account' }));
  const copy = b.api.exportLocal(subject);
  assert.deepEqual(JSON.parse(JSON.stringify(copy.jobs)), []);
  assert.equal(copy.playback[0].jobId, 'folder-job');
  assert.equal(copy.recovery[0].draft, 'retained note');
  const normalized = b.api.normalizePayload(copy, subject, ['folder-job'], new Set(['personal']), new Set(), new Set());
  assert.equal(normalized.playback[0].jobId, 'folder-job');
  assert.equal(normalized.recovery[0].draft, 'retained note');
});

test('normalization rejects hostile identity and filters course/job/model scope', () => {
  const b = browser();
  const raw = { schema: b.api.schema, jobs: [{ id: 'job-1' }, { id: 'job-2' }], playback: [], recovery: [], preferences: { workspaceChoice: 'other-course', splitChoice: 'forged', benchTab: 'splitter' } };
  const normalized = b.api.normalizePayload(raw, subject, ['job-1'], new Set(['personal', 'course-1']), new Set(['model-1']), new Set());
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.jobs)), [{ id: 'job-1', collapsed: false }]);
  assert.equal('workspaceChoice' in normalized.preferences, false);
  assert.equal('splitChoice' in normalized.preferences, false);
  assert.equal(normalized.preferences.benchTab, 'splitter');
});

test('staging is an immutable recovery copy and activation preserves conflicting local progress', () => {
  const b = browser();
  const payload = { schema: b.api.schema, subject, jobs: [{ id: 'job-1', collapsed: true }], playback: [{ jobId: 'job-1', value: { position: 30, rate: 1, muted: [], solo: null, guideOpen: false, loop: null } }], recovery: [], preferences: { splitChoice: 'model-1' } };
  const id = b.api.stage(subject, payload);
  payload.jobs[0].collapsed = false;
  assert.equal(b.api.getStage(id, subject).payload.jobs[0].collapsed, true);
  assert.equal(b.api.getStage(id, other), null);
  b.storage.setItem(`stem-listening:${subject}:job-1`, JSON.stringify({ position: 77, rate: 1, muted: [], solo: null, guideOpen: false, loop: null }));
  assert.equal(b.api.activate(id, subject), true);
  assert.equal(b.api.playback(subject, 'job-1', { position: 77 }).position, 77);
  assert.equal(b.api.playback(other, 'job-1', null), null);
  assert.equal(b.api.mergeJobs(subject, [{ id: 'job-1', collapsed: false }])[0].collapsed, false);
});

test('unfinished assistant writes stay in the recovery vault and cannot be restored into active keys', () => {
  const b = browser(); let saveCount = 0;
  b.window.StemListeningProgress = { read: () => ({ draft: '', position: 0, rate: 1, muted: [], solo: null, guideOpen: false, loop: null }), save: () => { saveCount++; } };
  const payload = { schema: b.api.schema, subject, jobs: [{ id: 'job-1', collapsed: false }], playback: [], recovery: [{ jobId: 'job-1', pendingConversation: { revision: 2, entries: [{ kind: 'you', text: 'unsaved answer' }] }, pendingGuide: { messageId: 'guide_message_012345' } }], preferences: {} };
  const id = b.api.stage(subject, payload);
  assert.equal(b.api.restoreRecovery(id, subject, 'job-1', 'pendingConversation').reason, 'manual_only');
  assert.equal(b.api.restoreRecovery(id, subject, 'job-1', 'pendingGuide').reason, 'manual_only');
  assert.equal(saveCount, 0);
  assert.equal(b.api.getStage(id, subject).payload.recovery[0].pendingConversation.entries[0].text, 'unsaved answer');
});

test('draft restore reports swallowed local storage quota failures', () => {
  const b = browser();
  b.window.StemListeningProgress = {
    read: () => ({ draft: '', position: 0, rate: 1, muted: [], solo: null, guideOpen: false, loop: null }),
    save: () => {}, // production save catches quota exceptions internally
  };
  const id = b.api.stage(subject, { schema: b.api.schema, subject, jobs: [], playback: [], recovery: [{ jobId: 'job-1', draft: 'unfinished' }], preferences: {} });
  assert.equal(b.api.restoreRecovery(id, subject, 'job-1', 'draft').reason, 'storage');
  assert.equal(b.storage.getItem(`stem-listening:${subject}:job-1`), null);
  assert.equal(b.api.getStage(id, subject).payload.recovery[0].draft, 'unfinished');
});

test('corrupt recovery records are excluded from listings and activation', () => {
  const b = browser();
  const id = '12345678-1234-4234-8234-123456789abc';
  const key = `stem-browser-recovery:v1:${id}`;
  const corrupt = { schema: b.api.schema, id, subject, createdAt: Date.now(), payload: { schema: b.api.schema, subject, jobs: 'not-an-array', playback: [], recovery: [], preferences: {} } };
  b.storage.setItem(key, JSON.stringify(corrupt));
  b.storage.setItem(`stem-browser-recovery-active:v1:${subject}`, id);
  assert.equal(b.api.getStage(id, subject), null);
  assert.deepEqual(JSON.parse(JSON.stringify(b.api.listStages(subject))), []);
  assert.equal(b.api.active(subject), null);
  assert.equal(b.storage.getItem(key), JSON.stringify(corrupt));
  const validId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const valid = { ...corrupt, id: validId, payload: { schema: b.api.schema, subject, jobs: [], playback: [], recovery: [], preferences: {} } };
  b.storage.setItem(`stem-browser-recovery:v1:${validId}`, JSON.stringify(valid));
  b.storage.setItem(`stem-browser-recovery:v1:${id}`, JSON.stringify({ ...valid, id: validId }));
  const listed = b.api.listStages(subject);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, validId);
});

test('quota failure never installs an active pointer and preserves current storage', () => {
  const b = browser({ quota: 40 });
  const payload = { schema: b.api.schema, subject, jobs: [], playback: [], recovery: [], preferences: {} };
  assert.equal(b.api.stage(subject, payload), null);
  assert.equal(b.api.active(subject), null);
  assert.equal(b.storage.getItem(`jobs:${subject}`), null);
});

test('proof contracts bind member or guest class, exact configured origins, and unique bounded job IDs', () => {
  const member = { subject, quotaClass: 'member', role: 'student' };
  const guest = { subject: `guest-${'c'.repeat(64)}`, quotaClass: 'guest', role: 'guest' };
  assert.equal(browserTransferContract.actorKind(member), 'member');
  assert.equal(browserTransferContract.actorKind(guest), 'guest');
  assert.equal(browserTransferContract.actorKind({ ...member, subject: guest.subject }), null);
  const env = { PUBLIC_BASE_URL: 'https://stem-splitter.ailab-452.workers.dev', CAIL_BROWSER_ORIGIN: 'https://tools.ailab.gc.cuny.edu', APP_BASE_PATH: '/stem-splitter' };
  assert.deepEqual(browserTransferContract.transferOrigins(env), { source: 'https://stem-splitter.ailab-452.workers.dev', destination: 'https://tools.ailab.gc.cuny.edu', active: 'https://tools.ailab.gc.cuny.edu' });
  assert.equal(browserTransferContract.transferOrigins({ ...env, CAIL_BROWSER_ORIGIN: 'http://tools.ailab.gc.cuny.edu' }), null);
  assert.deepEqual(browserTransferContract.parseJobIds(['job-1']), ['job-1']);
  assert.equal(browserTransferContract.parseJobIds(['job-1', 'job-1']), null);
  assert.equal(browserTransferContract.parseJobIds(['../private']), null);
});

test('source bridge ignores hostile origin/window messages and authorizes one exact opener transfer', async () => {
  const bridge = readFileSync(new URL('../public/browser-transfer-source.js', import.meta.url), 'utf8');
  const opener = { messages: [], postMessage(message, origin) { this.messages.push({ message, origin }); } };
  const listeners = new Map();
  const calls = [];
  const payload = { schema: 'stem-browser-local-state-v1', jobs: [], playback: [], recovery: [], preferences: {} };
  const window = { opener, StemBrowserStateTransfer: { exportLocal: () => payload }, addEventListener: (name, fn) => listeners.set(name, fn) };
  const document = { getElementById: () => ({ textContent: '' }) };
  const fetch = async (path, options = {}) => {
    calls.push({ path, options });
    return path === '/api/account'
      ? { ok: true, json: async () => ({ account: { subject } }) }
      : { ok: true };
  };
  runInNewContext(bridge, { window, document, fetch, TextEncoder, AbortSignal, JSON, setTimeout: () => 1, clearTimeout: () => {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  const receiver = listeners.get('message');
  const port = { sent: [], postMessage(value) { this.sent.push(value); }, close() { this.closed = true; } };
  receiver({ origin: 'https://attacker.invalid', source: opener, data: { type: 'stem-browser-transfer-start', proof: 'a'.repeat(43) }, ports: [port] });
  receiver({ origin: 'https://tools.ailab.gc.cuny.edu', source: {}, data: { type: 'stem-browser-transfer-start', proof: 'a'.repeat(43) }, ports: [port] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.filter(call => call.path === '/api/browser-transfer/authorize').length, 0);
  assert.equal(opener.messages[0].message.type, 'stem-browser-transfer-ready');
  assert.equal(opener.messages[0].origin, 'https://tools.ailab.gc.cuny.edu');
  receiver({ origin: 'https://tools.ailab.gc.cuny.edu', source: opener, data: { type: 'stem-browser-transfer-start', proof: 'a'.repeat(43) }, ports: [port] });
  await new Promise(resolve => setTimeout(resolve, 0));
  receiver({ origin: 'https://tools.ailab.gc.cuny.edu', source: opener, data: { type: 'stem-browser-transfer-start', proof: 'a'.repeat(43) }, ports: [port] });
  assert.equal(calls.filter(call => call.path === '/api/browser-transfer/authorize').length, 1);
  assert.equal(port.sent.length, 1);
  assert.equal(port.sent[0].type, 'stem-browser-transfer-data');
  assert.equal(port.sent[0].payload, payload);
  assert.equal(calls.some(call => call.path === '/api/assistant' || call.path === '/api/teacher'), false);
});

test('source bridge drops data when account changes during authorization', async () => {
  const bridge = readFileSync(new URL('../public/browser-transfer-source.js', import.meta.url), 'utf8');
  const opener = { postMessage() {} }, listeners = new Map();
  let active = subject, releaseAuth!: (value: { ok: boolean }) => void;
  const auth = new Promise<{ ok: boolean }>(resolve => { releaseAuth = resolve; });
  const sent: unknown[] = [];
  const payload = { schema: 'stem-browser-local-state-v1', jobs: [{ id: 'private-job' }], playback: [], recovery: [], preferences: {} };
  const window = { opener, StemBrowserStateTransfer: { exportLocal: () => payload }, addEventListener: (name: string, fn: (event: any) => void) => listeners.set(name, fn) };
  const fetch = async (path: string) => path === '/api/account'
    ? { ok: true, json: async () => ({ account: { subject: active } }) } : auth;
  runInNewContext(bridge, { window, document: { getElementById: () => ({ textContent: '' }) }, fetch, TextEncoder, AbortSignal, JSON, setTimeout: () => 1, clearTimeout: () => {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  const port = { postMessage: (value: unknown) => sent.push(value), close() {} };
  const handler = listeners.get('message')!;
  handler({ origin: 'https://tools.ailab.gc.cuny.edu', source: opener, data: { type: 'stem-browser-transfer-start', proof: 'a'.repeat(43) }, ports: [port] });
  await new Promise(resolve => setTimeout(resolve, 0));
  active = other;
  releaseAuth({ ok: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(sent.some(value => (value as any)?.type === 'stem-browser-transfer-data'), false);
  assert.equal(sent.some(value => (value as any)?.payload?.jobs?.[0]?.id === 'private-job'), false);
});
