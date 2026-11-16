import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

test.use({ ignoreHTTPSErrors: true });

for (const state of ['fresh guest', 'retained guest', 'signed-in member']) test(`Tools opens directly for a ${state} and keeps entry and reload free of transfer requests`, async ({ page, context }) => {
  const issuer = await createTestIdentityIssuer();
  const config = JSON.parse(await readFile(new URL('./test-wrangler.jsonc', import.meta.url), 'utf8'));
  const harness = createTestHarness({ root: fileURLToPath(new URL('./', import.meta.url)), workers: [{ config: {
    ...config, dev: { local_protocol: 'https' }, vars: { ...config.vars, TEST_BROWSER: 'true', TEST_JWKS: issuer.jwksJson,
      GUEST_ENABLED: 'true', GUEST_COOKIE_SECRET: 'browser-fixture-transfer-secret-0000000000',
      GUEST_TURNSTILE_SITE_KEY: 'fixture-site-key', GUEST_TURNSTILE_SECRET: 'fixture-turnstile-secret-only' },
  } }] });
  const errors = [], transferRequests = [], foreignRequests = [], navigation = [], guestStarts = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { url } = await harness.listen();
    const worker = harness.getWorker('stem-preview-contract-test');
    const seed = async statements => expect((await worker.fetch('/__fixture/schema', {
      method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(statements),
    })).status).toBe(200);
    await seed(schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8')));
    await seed([`INSERT INTO app_users(subject) VALUES('${TEST_SUBJECTS.alice}')`]);
    let actor = TEST_SUBJECTS.alice, originalGuest = null;
    if (state === 'retained guest') {
      // Issue a real guest session in the local Worker and retain its cookie at
      // the mounted origin. No source page or browser profile is consulted.
      const started = await worker.fetch(url.origin + '/stem-splitter/auth/guest', { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json' }, body: '{}' });
      expect(started.status).toBe(200);
      const cookie = started.headers.get('set-cookie').split(';')[0], split = cookie.indexOf('=');
      await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: url.origin, secure: true, httpOnly: true, sameSite: 'Lax' }]);
      originalGuest = await (await worker.fetch(url.origin + '/stem-splitter/api/account', { headers: { cookie } })).json();
      actor = originalGuest.account.subject;
    } else if (state === 'signed-in member') {
      const appJwt = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice });
      const gatewayJwt = await issuer.mintIdentityJwt({ audience: 'cail:gateway', subject: TEST_SUBJECTS.alice });
      await context.setExtraHTTPHeaders({ 'x-fixture-identity': appJwt, 'x-fixture-gateway-identity': gatewayJwt });
    }
    if (state !== 'fresh guest') {
      await seed([
        `INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES('remix-fixture','Retained entry track','uploads/fixture.wav','done','htdemucs_ft','[{"name":"vocals","key":"stems/remix-fixture/vocals.mp3"}]')`,
        `INSERT INTO ${state === 'retained guest' ? 'guest_job_owners' : 'job_owners'}(job_id,subject) VALUES('remix-fixture','${actor}')`,
        `INSERT INTO annotations(id,job_id,at_seconds,text,author_subject,author_name) VALUES('entry-note','remix-fixture',1,'Retained listening note','${actor}','Fixture listener')`,
      ]);
      await worker.fetch('/__fixture/audio', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: await readFile(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url)) });
    }
    if (state !== 'fresh guest') {
      // Retained local preferences flush on direct entry; no legacy-origin visit
      // is needed to preserve an explicit clear or a member's pending choice.
      await page.addInitScript(({ actor, value }) => {
        const key = `stem-preferences:v1:${actor}`;
        if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ records: {}, pending: {
          modelChoice: { requestId: crypto.randomUUID(), baseRevision: 0, value },
          benchTab: { requestId: crypto.randomUUID(), baseRevision: 0, value: 'remixer' },
          classChoice: { requestId: crypto.randomUUID(), baseRevision: 0, value: 'unavailable-old-course' },
        } }));
      }, { actor, value: state === 'retained guest' ? null : 'htdemucs_ft' });
    }
    await page.route('**/*', route => new URL(route.request().url()).origin === url.origin ? route.continue() : route.abort());
    page.on('request', request => {
      const target = new URL(request.url());
      if (target.origin !== url.origin && !['fonts.googleapis.com', 'fonts.gstatic.com'].includes(target.hostname)) foreignRequests.push(request.url());
      if (/guest-transfer/.test(target.pathname)) transferRequests.push(request.url());
      if (request.method() === 'POST' && target.pathname === '/stem-splitter/auth/guest') guestStarts.push(request.url());
    });
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigation.push(frame.url()); });
    const home = url.origin + '/stem-splitter/';
    await page.goto(home);
    await expect(page.locator('#yt-url')).toBeEnabled();
    await expect(page.locator('#stem-choice input[name="stem-model"]').first()).toBeVisible();
    await expect(page.locator('#transfer-status, #transfer-accounts, #transfer-retry')).toHaveCount(0);
    const initial = await page.evaluate(async () => (await window.StemFetch('/api/account')).json());
    expect(initial.account.role).toBe(state === 'signed-in member' ? 'student' : 'guest');
    if (state !== 'fresh guest') {
      expect(initial.account.subject).toBe(actor);
      await expect(page.locator('.console-title')).toHaveText('Retained entry track');
      await expect(page.locator('.note-text').filter({ hasText: 'Retained listening note' })).toBeVisible();
    }
    if (state !== 'fresh guest') {
      await expect.poll(() => page.evaluate(async actor => {
        const response = await window.StemFetch('/api/account/preferences', { headers: { 'X-Stem-Account': actor } });
        return response.ok ? (await response.json()).preferences : null;
      }, actor)).toMatchObject({
        modelChoice: { value: state === 'retained guest' ? null : 'htdemucs_ft' },
        benchTab: { value: 'remixer' }, classChoice: { value: 'unavailable-old-course' },
      });
      await expect.poll(() => page.evaluate(actor => JSON.parse(localStorage.getItem(`stem-preferences:v1:${actor}`)).pending, actor)).toEqual({});
    }
    if (originalGuest) expect(initial.guest.expiresAt).toBe(originalGuest.guest.expiresAt);
    await page.reload();
    await expect(page.locator('#yt-url')).toBeEnabled();
    const reloaded = await page.evaluate(async () => (await window.StemFetch('/api/account')).json());
    expect(reloaded.account.subject).toBe(initial.account.subject);
    if (state !== 'fresh guest') await expect(page.locator('.console-title')).toHaveText('Retained entry track');
    expect(guestStarts).toHaveLength(state === 'fresh guest' ? 1 : 0);
    expect(transferRequests).toEqual([]);
    expect(foreignRequests).toEqual([]);
    expect(navigation).toEqual([home, home]);
    expect(errors).toEqual([]);
  } finally { await harness.close(); }
});

test('retired transfer bookmarks return home without starting another handoff and an in-flight completion runs only once', async ({ page }) => {
  const issuer = await createTestIdentityIssuer();
  const config = JSON.parse(await readFile(new URL('./test-wrangler.jsonc', import.meta.url), 'utf8'));
  const harness = createTestHarness({ root: fileURLToPath(new URL('./', import.meta.url)), workers: [{ config: {
    ...config, dev: { local_protocol: 'https' }, vars: { ...config.vars, TEST_BROWSER: 'true', TEST_JWKS: issuer.jwksJson,
      GUEST_ENABLED: 'true', GUEST_COOKIE_SECRET: 'browser-fixture-transfer-secret-0000000000',
      GUEST_TURNSTILE_SITE_KEY: 'fixture-site-key', GUEST_TURNSTILE_SECRET: 'fixture-turnstile-secret-only' },
  } }] });
  try {
    const { url } = await harness.listen(), transferCalls = [];
    expect((await harness.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'))) })).status).toBe(200);
    await page.route('**/*', route => new URL(route.request().url()).origin === url.origin ? route.fallback() : route.abort());
    page.on('request', request => { if (/auth\/guest-transfer/.test(new URL(request.url()).pathname)) transferCalls.push({ method: request.method(), path: new URL(request.url()).pathname }); });
    for (const suffix of ['guest-transfer', 'guest-transfer.html', 'guest-transfer.html#transfer-failed']) {
      await page.goto(url.origin + '/stem-splitter/' + suffix);
      await expect(page).toHaveURL(url.origin + '/stem-splitter/');
      await expect(page.locator('#yt-url')).toBeEnabled();
    }
    expect(transferCalls).toEqual([]);
    const before = await page.evaluate(async () => (await window.StemFetch('/api/account')).json());
    const submitted = [];
    // Cryptographic validity/replay remains covered by guest-transfer.test.ts.
    // Here the already-issued fragment exercises the completion page only.
    await page.route('**/stem-splitter/auth/guest-transfer/finish', async route => {
      submitted.push(route.request().postDataJSON());
      await route.fulfill({ status: 409, json: { error: { code: 'workspace_conflict' } } });
    });
    await page.goto(url.origin + '/stem-splitter/guest-transfer.html#fixture-in-flight-token');
    await expect(page).toHaveURL(url.origin + '/stem-splitter/');
    await expect(page.locator('#yt-url')).toBeEnabled();
    await page.reload();
    await expect(page.locator('#yt-url')).toBeEnabled();
    expect(submitted).toEqual([{ token: 'fixture-in-flight-token' }]);
    expect(transferCalls).toEqual([{ method: 'POST', path: '/stem-splitter/auth/guest-transfer/finish' }]);
    const after = await page.evaluate(async () => (await window.StemFetch('/api/account')).json());
    expect(after.account.subject).toBe(before.account.subject);
  } finally { await harness.close(); }
});

test('Tools mount loads saved splits, plays audio, and keeps navigation and uploads in its namespace', async ({ page, context }) => {
  const issuer = await createTestIdentityIssuer();
  const appJwt = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice });
  const gatewayJwt = await issuer.mintIdentityJwt({ audience: 'cail:gateway', subject: TEST_SUBJECTS.alice });
  const harness = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)), vars: {
    TEST_JWKS: issuer.jwksJson, TEST_ADMIN: TEST_SUBJECTS.alice, TEST_BROWSER: 'true',
  }, secrets: { WEBHOOK_SECRET: 'fixture-only' } }] });
  const errors = [], outsideMount = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { url } = await harness.listen();
    const sql = schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
    sql.push(`INSERT INTO app_users (subject) VALUES ('${TEST_SUBJECTS.alice}')`,
      `INSERT INTO jobs (id, filename, source_key, status, model, stems) VALUES ('remix-fixture', 'Mounted saved split', 'uploads/fixture.wav', 'done', 'htdemucs_ft', '[{"name":"vocals","key":"stems/remix-fixture/vocals.mp3"}]')`,
      `INSERT INTO job_owners (job_id, subject) VALUES ('remix-fixture', '${TEST_SUBJECTS.alice}')`);
    expect((await harness.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(sql) })).status).toBe(200);
    await harness.fetch('/__fixture/audio', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: await readFile(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url)) });
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': appJwt, 'x-fixture-gateway-identity': gatewayJwt });
    page.on('request', request => {
      const target = new URL(request.url());
      if (target.origin === url.origin && !target.pathname.startsWith('/stem-splitter/')) outsideMount.push(target.pathname);
    });
    await page.goto(new URL('/stem-splitter/?job=remix-fixture', url).href);
    await expect(page.locator('.badge.ready')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Stem Splitter home', exact: true })).toHaveAttribute('href', '/stem-splitter/');
    await expect(page.locator('.account-nav.header-logout')).toHaveAttribute('action', '/auth/logout');
    const playback = await page.evaluate(() => {
      const mixer = mixers.get('remix-fixture');
      for (const audio of mixer.audios) audio.loop = true;
      return mixer.audios.map(audio => ({ src: audio.src, duration: audio.duration }));
    });
    expect(playback.length).toBe(1);
    expect(playback[0].src).toContain('/stem-splitter/api/files/stems/remix-fixture/vocals.mp3');
    await page.locator('.console .play-btn').click();
    await expect(page.locator('.console .tc-now')).not.toHaveText('0:00');
    await page.locator('.console .play-btn').click();
    await page.reload();
    await expect(page.locator('.badge.ready')).toBeVisible();
    const upload = await page.evaluate(async () => {
      const response = await window.StemFetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'mount.wav', contentType: 'audio/wav' }) });
      return { status: response.status, body: await response.json() };
    });
    expect(upload.status).toBe(200);
    expect(upload.body.uploadUrl).toMatch(/^\/stem-splitter\/api\/local-uploads\//);
    for (const destination of ['/account.html', '/teacher.html', '/classroom.html']) {
      await page.goto(new URL('/stem-splitter' + destination, url).href);
      await expect(page.getByRole('link', { name: 'Stem Splitter home', exact: true })).toHaveAttribute('href', '/stem-splitter/');
      expect(new URL(page.url()).pathname).toMatch(/^\/stem-splitter\//);
      await expect(page.locator('.account-nav.header-logout')).toHaveAttribute('action', '/auth/logout');
    }
    await page.goto(new URL('/stem-splitter/auth/login?returnTo=%2Fstem-splitter%2Faccount.html', url).href);
    await expect(page).toHaveURL(/\/stem-splitter\/account(?:\.html)?$/);
    expect(outsideMount).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await harness.close(); }
});

test('Tools pages and runtime stay public while private APIs and forged identities remain denied', async ({ page }) => {
  const issuer = await createTestIdentityIssuer();
  const harness = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)), vars: {
    TEST_JWKS: issuer.jwksJson, TEST_BROWSER: 'true',
  } }] });
  const errors = [], loginRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.includes('/auth/')) loginRequests.push(request.url()); });
  try {
    const { url } = await harness.listen();
    // Public reads remain usable even if background visit recording is unavailable.
    for (const method of ['GET', 'HEAD']) {
      for (const path of ['/', '/app-path.js', '/app.js', '/styles.css', '/fonts/bricolage-grotesque-800.ttf']) {
        const response = await harness.fetch('/stem-splitter' + path, { method });
        expect(response.status).toBe(200);
        expect(response.headers.get('set-cookie')).toBeNull();
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        if (method === 'HEAD') expect(await response.text()).toBe('');
      }
    }
    expect((await harness.fetch('/stem-splitter/healthz')).status).toBe(404);
    expect((await harness.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'))) })).status).toBe(200);
    for (const path of ['/api/account', '/api/files/stems/fixture/vocals.mp3', '/auth/login']) {
      for (const headers of [{}, { 'x-cail-identity-jwt': 'forged', 'x-cail-gateway-identity-jwt': 'forged' }]) {
        const response = await harness.fetch('/stem-splitter' + path, { headers, redirect: 'manual' });
        expect(response.status).toBe(401);
        expect(response.headers.get('location')).toBeNull();
      }
    }
    expect((await harness.fetch('/stem-splitter/api/shared-jobs/fixture')).status).toBe(404);
    for (const path of ['/api/runtime', '/api/bug-reports/availability']) {
      expect((await harness.fetch('/stem-splitter' + path)).status).toBe(200);
      expect((await harness.fetch('/stem-splitter' + path, { headers: { 'x-cail-identity-jwt': 'forged' } })).status).toBe(401);
    }
    for (const path of ['/', '/app.js']) {
      expect((await harness.fetch('/stem-splitter' + path, { method: 'POST', headers: { origin: url.origin } })).status).toBe(405);
    }
    for (const path of ['/auth/logout', '/auth/callback', '/auth/guest']) {
      expect((await harness.fetch('/stem-splitter' + path)).status).toBe(404);
    }
    const destination = '/stem-splitter/?job=fixture&course=demo';
    // A gateway released before its receiver can still reject runtime access.
    // Keep that recovery message legible without making it the normal guest UI.
    await page.route('**/stem-splitter/api/runtime', route => route.fulfill({ status: 401, json: {} }));
    await page.route('**/stem-splitter/api/bug-reports/availability', route => route.fulfill({ status: 401, json: {} }));
    const availabilityResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/bug-reports/availability'));
    await page.goto(new URL(destination, url).href);
    await expect(page.locator('#header-signin')).toBeVisible();
    await expect(page.locator('#stem-choice')).toHaveText('Sign in with CUNY to upload and split tracks.');
    await expect(page.locator('.sign-in-notice a')).toHaveAttribute('href', '/stem-splitter/auth/login?returnTo=' + encodeURIComponent(destination));
    const notice = await page.locator('.sign-in-notice').boundingBox();
    const choices = await page.locator('#stem-choice').boundingBox();
    expect(notice.width).toBeGreaterThan(choices.width - 2);
    await expect(page).toHaveURL(new URL(destination, url).href);
    await expect(page.locator('#upload-status')).toBeHidden();
    await expect(page.locator('#job-list')).toBeEmpty();
    await expect(page.locator('#yt-url')).toBeDisabled();
    await expect(page.locator('#engine-summary')).toBeHidden();
    await expect(page.locator('#class-code-dialog')).not.toBeVisible();
    expect((await availabilityResponse).status()).toBe(401);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    await expect(page.getByRole('button', { name: 'Retry problem reporting', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Report a problem', exact: true })).toHaveCount(0);
    await expect(page.getByText('Problem reporting is temporarily unavailable.', { exact: true })).toHaveCount(0);
    expect(loginRequests).toEqual([]);
    const login = '/stem-splitter/auth/login?returnTo=' + encodeURIComponent(destination);
    await expect(page.locator('#header-signin')).toHaveAttribute('href', login);
    await page.route('**/stem-splitter/auth/login?*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Explicit sign-in entry</h1>' }));
    await page.locator('#header-signin').click();
    await expect(page).toHaveURL(new URL(login, url).href);
    expect(loginRequests).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally { await harness.close(); }
});

test('mounted reporting treats sign-out as normal and retains real outage recovery', async ({ page }) => {
  const issuer = await createTestIdentityIssuer();
  const harness = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)), vars: {
    TEST_JWKS: issuer.jwksJson, TEST_BROWSER: 'true',
  } }] });
  let availabilityStatus = 503;
  await page.route('**/api/bug-reports/availability', route => route.fulfill({ status: availabilityStatus,
    json: availabilityStatus === 200 ? { enabled: true } : { error: 'fixture' } }));
  try {
    const { url } = await harness.listen();
    await page.goto(new URL('/stem-splitter/', url).href);
    const retry = page.getByRole('button', { name: 'Retry problem reporting', exact: true });
    await expect(retry).toBeVisible();
    availabilityStatus = 401;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(retry).toHaveCount(0);
    await expect(page.getByText('Problem reporting is temporarily unavailable.', { exact: true })).toHaveCount(0);
    availabilityStatus = 503;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(retry).toBeVisible();
    availabilityStatus = 200;
    await retry.click();
    await expect(page.getByRole('button', { name: 'Report a problem', exact: true })).toBeVisible();
    await expect(retry).toHaveCount(0);
  } finally { await harness.close(); }
});

test('public deep pages preserve their sign-in destination and protected login refuses unsafe returns', async ({ page }) => {
  const issuer = await createTestIdentityIssuer();
  const appJwt = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice });
  const gatewayJwt = await issuer.mintIdentityJwt({ audience: 'cail:gateway', subject: TEST_SUBJECTS.alice });
  const harness = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)), vars: {
    TEST_JWKS: issuer.jwksJson, TEST_BROWSER: 'true',
  } }] });
  try {
    const { url } = await harness.listen();
    for (const path of ['/teacher.html?course=demo', '/classroom.html?course=demo&view=students', '/account.html?view=usage']) {
      await page.goto(new URL('/stem-splitter' + path, url).href);
      await expect(page.locator('#header-signin')).toBeVisible();
      const target = new URL(await page.locator('#header-signin').getAttribute('href'), url);
      expect(target.pathname).toBe('/stem-splitter/auth/login');
      const returned = new URL(target.searchParams.get('returnTo'), url);
      expect(returned.pathname.replace(/\.html$/, '')).toBe('/stem-splitter' + path.split('?')[0].replace(/\.html$/, ''));
      expect(returned.search).toBe('?' + path.split('?')[1]);
      expect(new URL(page.url()).pathname).not.toContain('/auth/');
    }
    const headers = { 'x-fixture-identity': appJwt, 'x-fixture-gateway-identity': gatewayJwt };
    for (const method of ['GET', 'HEAD']) {
      for (const next of ['/stem-splitter/?job=fixture&course=demo', '/stem-splitter/classroom.html?course=demo&view=students', '/stem-splitter/auth/login', '/stem-splitter/api/account', '//attacker.test/', 'https://attacker.test/']) {
        const response = await harness.fetch('/stem-splitter/auth/login?returnTo=' + encodeURIComponent(next), { method, headers, redirect: 'manual' });
        expect(response.status).toBe(303);
        const target = new URL(response.headers.get('location'));
        expect(target.origin).toBe(url.origin);
        expect(target.pathname + target.search).toBe(next.includes('/?job=') || next.includes('/classroom.html?') ? next : '/stem-splitter/');
      }
    }
  } finally { await harness.close(); }
});
