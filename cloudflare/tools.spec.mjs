import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

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
    await expect(page.locator('.header-logout')).toHaveAttribute('action', '/auth/logout');
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
      await expect(page.locator('.header-logout')).toHaveAttribute('action', '/auth/logout');
    }
    await page.goto(new URL('/stem-splitter/auth/login?returnTo=%2Fstem-splitter%2Faccount.html', url).href);
    await expect(page).toHaveURL(/\/stem-splitter\/account(?:\.html)?$/);
    expect(outsideMount).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await harness.close(); }
});

test('Tools landing and assets stay public while anonymous and forged API requests remain denied', async ({ page }) => {
  const issuer = await createTestIdentityIssuer();
  const harness = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)), vars: {
    TEST_JWKS: issuer.jwksJson, TEST_BROWSER: 'true',
  } }] });
  const errors = [], loginRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.includes('/auth/')) loginRequests.push(request.url()); });
  try {
    const { url } = await harness.listen();
    // No database fixture is initialized: public reads must use ASSETS only.
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
    for (const path of ['/api', '/api/runtime', '/api/account', '/api/shared-jobs/fixture', '/api/files/stems/fixture/vocals.mp3', '/api/bug-reports/availability', '/auth/login']) {
      for (const headers of [{}, { 'x-cail-identity-jwt': 'forged', 'x-cail-gateway-identity-jwt': 'forged' }]) {
        const response = await harness.fetch('/stem-splitter' + path, { headers, redirect: 'manual' });
        expect(response.status).toBe(401);
        expect(response.headers.get('location')).toBeNull();
      }
    }
    for (const path of ['/', '/app.js']) {
      expect((await harness.fetch('/stem-splitter' + path, { method: 'POST', headers: { origin: url.origin } })).status).toBe(405);
    }
    for (const path of ['/auth/logout', '/auth/callback', '/auth/guest']) {
      expect((await harness.fetch('/stem-splitter' + path)).status).toBe(404);
    }
    const destination = '/stem-splitter/?job=fixture&course=demo';
    await page.goto(new URL(destination, url).href);
    await expect(page.locator('#header-signin')).toBeVisible();
    await expect(page.locator('#stem-choice')).toHaveText('Sign in with CUNY Login to upload and split tracks.');
    await expect(page).toHaveURL(new URL(destination, url).href);
    await expect(page.locator('#upload-status')).toBeHidden();
    await expect(page.locator('#job-list')).toBeEmpty();
    await expect(page.locator('#yt-url')).toBeDisabled();
    await expect(page.locator('#engine-summary')).toBeHidden();
    await expect(page.locator('#class-code-dialog')).not.toBeVisible();
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
