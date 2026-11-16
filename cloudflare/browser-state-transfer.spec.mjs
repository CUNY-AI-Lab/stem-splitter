import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const sourceOrigin = 'https://stem-splitter.ailab-452.workers.dev';
const destinationOrigin = 'https://tools.ailab.gc.cuny.edu';
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const sourceSubject = kind => kind === 'member' ? `cail-${'a'.repeat(32)}` : `guest-${'b'.repeat(64)}`;
const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });

async function installTransferSites(context, initialSubject) {
  let activeSubject = initialSubject, nextPause = null;
  const requests = [], stageBodies = [];
  await context.addInitScript(({ sourceOrigin, subject }) => {
    if (location.origin !== sourceOrigin) return;
    localStorage.setItem(`jobs:${subject}`, JSON.stringify([{ id: 'shared-job', collapsed: true }]));
    localStorage.setItem(`stem-listening:${subject}:shared-job`, JSON.stringify({
      position: 21, rate: 1.25, muted: [], solo: null, guideOpen: false, loop: null,
      draft: 'Alice private draft', pendingChat: { messageId: 'message_0123456789', messages: [{ role: 'user', content: 'Alice private chat note' }] },
    }));
  }, { sourceOrigin, subject: initialSubject });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const target = url.origin === destinationOrigin;
    const apiPrefix = target ? '/stem-splitter/api/' : '/api/';
    if (url.pathname.startsWith(apiPrefix)) {
      const path = url.pathname.slice(apiPrefix.length);
      requests.push(`${target ? 'target' : 'source'}:${route.request().method()}:${path}`);
      if (path === 'account' && route.request().method() === 'GET') return json(route, { account: { subject: activeSubject, quotaClass: 'member' } });
      if (path === 'browser-transfer/proof') return json(route, { proof: 'Q'.repeat(43), sourceOrigin, destinationOrigin, expiresAt: Date.now() + 300000 });
      if (path === 'browser-transfer/authorize') return json(route, { authorized: true });
      if (path === 'browser-transfer/stage') {
        const body = route.request().postDataJSON(); stageBodies.push(body);
        return json(route, { allowedJobIds: body.jobIds });
      }
      if (path === 'browser-transfer/reauthorize') {
        const body = route.request().postDataJSON();
        if (nextPause) { const paused = nextPause; nextPause = null; paused.started(); await paused.wait; }
        return json(route, { allowedJobIds: body.jobIds }); // Alice and Bob can both see this shared job.
      }
      if (path === 'browser-transfer/consume') return json(route, { consumed: true });
      if (path === 'separation-options') return json(route, { models: [{ id: 'htdemucs_ft' }] });
      if (path === 'song-samples') return json(route, { tracks: [] });
      if (path === 'classroom/courses') return json(route, { courses: [] });
      return json(route, {}, 404);
    }
    const localPath = target ? url.pathname.replace(/^\/stem-splitter(?=\/|$)/, '') || '/' : url.pathname;
    const file = join(publicDir, localPath.replace(/^\//, ''));
    try {
      let body = await readFile(file);
      if (target && file.endsWith('.html')) body = Buffer.from(body.toString('utf8').replace(/(href|src|action)="\/(?!\/)([^"]*)"/g, (_match, attr, path) => `${attr}="/stem-splitter/${path}"`));
      return route.fulfill({ status: 200, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body });
    } catch { return route.fulfill({ status: 404, body: 'not found' }); }
  });
  return {
    requests, stageBodies,
    switchTo(subject) { activeSubject = subject; },
    pauseNextReauthorize() {
      let started, resume;
      const startedPromise = new Promise(resolve => { started = resolve; });
      const wait = new Promise(resolve => { resume = resolve; });
      nextPause = { started, wait };
      return { started: startedPromise, resume };
    },
  };
}

for (const kind of ['member', 'guest']) test(`browser recovery crosses the two configured origins for the same ${kind} account without replaying assistant requests`, async ({ browser }) => {
  const context = await browser.newContext();
  const subject = sourceSubject(kind), requests = [], stageBodies = [];
  await context.addInitScript(({ sourceOrigin, subject }) => {
    if (location.origin !== sourceOrigin) return;
    localStorage.setItem(`jobs:${subject}`, JSON.stringify([{ id: 'saved-job', collapsed: true, filename: 'private title' }]));
    localStorage.setItem(`stem-listening:${subject}:saved-job`, JSON.stringify({
      position: 21, rate: 1.25, muted: [], solo: null, guideOpen: false, loop: null,
      draft: 'unfinished text', pendingChat: { messageId: 'message_0123456789', messages: [{ role: 'user', content: 'keep this for manual review' }] },
    }));
    localStorage.setItem('coachChat', 'unscoped private data');
    localStorage.setItem('classCode', 'legacy code');
  }, { sourceOrigin, subject });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const target = url.origin === destinationOrigin;
    const apiPrefix = target ? '/stem-splitter/api/' : '/api/';
    if (url.pathname.startsWith(apiPrefix)) {
      const path = url.pathname.slice(apiPrefix.length);
      requests.push(`${target ? 'target' : 'source'}:${route.request().method()}:${path}`);
      if (path === 'account' && route.request().method() === 'GET') return json(route, { account: { subject, quotaClass: kind === 'guest' ? 'guest' : 'member' } });
      if (path === 'browser-transfer/proof') return json(route, { proof: 'P'.repeat(43), sourceOrigin, destinationOrigin, expiresAt: Date.now() + 300000 });
      if (path === 'browser-transfer/authorize') return json(route, { authorized: true });
      if (path === 'browser-transfer/stage') {
        const body = route.request().postDataJSON(); stageBodies.push(body);
        return json(route, { allowedJobIds: body.jobIds });
      }
      if (path === 'browser-transfer/reauthorize') return json(route, { allowedJobIds: route.request().postDataJSON().jobIds });
      if (path === 'browser-transfer/consume') return json(route, { consumed: true });
      if (path === 'separation-options') return json(route, { models: [{ id: 'htdemucs_ft', label: 'Four stems' }] });
      if (path === 'song-samples') return json(route, { tracks: [] });
      if (path === 'classroom/courses') return json(route, { courses: [] }, kind === 'guest' ? 401 : 200);
      if (/\/(guide|chat)$/.test(path)) return json(route, { ok: false }, 500);
      return json(route, {}, 404);
    }
    const localPath = target ? url.pathname.replace(/^\/stem-splitter(?=\/|$)/, '') || '/' : url.pathname;
    const file = join(publicDir, localPath.replace(/^\//, ''));
    try {
      let body = await readFile(file);
      if (target && file.endsWith('.html')) body = Buffer.from(body.toString('utf8').replace(/(href|src|action)="\/(?!\/)([^"]*)"/g, (_match, attr, path) => `${attr}="/stem-splitter/${path}"`));
      return route.fulfill({ status: 200, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body });
    } catch { return route.fulfill({ status: 404, body: 'not found' }); }
  });
  try {
    const page = await context.newPage();
    await page.goto(`${destinationOrigin}/stem-splitter/browser-transfer.html`);
    await expect(page.locator('#transfer-start')).toBeVisible();
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Open original Stem Splitter', exact: true }).click();
    const popup = await popupPromise;
    await expect(page.locator('#transfer-status')).toHaveText('Your data is ready to review.');
    await expect(page.locator('#transfer-counts')).toContainText('1 splits');
    await expect(page.locator('#transfer-pending')).toContainText('No messages will be sent');
    expect(popup.url()).toBe(`${sourceOrigin}/browser-transfer-source.html`);
    expect(requests).toContain('source:POST:browser-transfer/authorize');
    await page.getByRole('button', { name: 'Review chat', exact: true }).click();
    await expect(page.locator('#transfer-recovery-text')).toHaveValue(/keep this for manual review/);
    expect(requests.some(request => /:(guide|chat)$/.test(request))).toBe(false);
    await page.getByRole('button', { name: 'Apply available state', exact: true }).click();
    await expect(page.locator('#transfer-status')).toContainText('active for this account');
    const imported = await page.evaluate(subject => window.StemBrowserStateTransfer.active(subject), subject);
    expect(imported.jobs).toEqual([{ id: 'saved-job', collapsed: true }]);
    expect(imported.playback[0].value.position).toBe(21);
    expect(imported.recovery[0].pendingChat.messages[0].content).toBe('keep this for manual review');
    expect(stageBodies).toHaveLength(1);
    expect(JSON.stringify(stageBodies)).not.toContain('unfinished text');
    expect(JSON.stringify(stageBodies)).not.toContain('keep this for manual review');
    if (kind === 'guest') expect(requests.some(request => request.endsWith(':GET:classroom/courses'))).toBe(false);
    else expect(requests.some(request => request.endsWith(':GET:classroom/courses'))).toBe(true);
  } finally { await context.close(); }
});

for (const action of ['review', 'apply', 'draft', 'unfinished note']) test(`switching accounts during ${action} never exposes or stages the previous account's recovery copy`, async ({ browser }) => {
  const context = await browser.newContext();
  const alice = `cail-${'a'.repeat(32)}`, bob = `cail-${'b'.repeat(32)}`;
  const sites = await installTransferSites(context, alice);
  try {
    const page = await context.newPage();
    await page.goto(`${destinationOrigin}/stem-splitter/browser-transfer.html`);
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Open original Stem Splitter', exact: true }).click();
    await popupPromise;
    await expect(page.locator('#transfer-status')).toHaveText('Your data is ready to review.');

    const paused = sites.pauseNextReauthorize();
    if (action === 'review') await page.getByRole('button', { name: 'Review', exact: true }).click();
    else if (action === 'apply') await page.getByRole('button', { name: 'Apply available state', exact: true }).click();
    else if (action === 'draft') await page.getByRole('button', { name: 'Restore draft', exact: true }).click();
    else await page.getByRole('button', { name: 'Review chat', exact: true }).click();
    await paused.started;
    sites.switchTo(bob);
    await page.evaluate(() => dispatchEvent(new Event('focus')));
    await expect(page.locator('#transfer-status')).toContainText('Account changed.');
    await expect(page.locator('#transfer-review')).toBeHidden();
    paused.resume();
    await page.waitForTimeout(50);
    const bobState = await page.evaluate(bob => ({
      stages: window.StemBrowserStateTransfer.listStages(bob).length,
      active: window.StemBrowserStateTransfer.active(bob),
      draft: localStorage.getItem(`stem-listening:${bob}:shared-job`),
      preview: document.getElementById('transfer-recovery-text').value,
    }), bob);
    expect(bobState.stages).toBe(0);
    expect(bobState.active).toBeNull();
    expect(bobState.draft).toBeNull();
    expect(bobState.preview).not.toContain('Alice');
    await expect(page.locator('#transfer-status')).toContainText('Account changed.');
  } finally { await context.close(); }
});
