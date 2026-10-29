import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
import { handleAuth, SESSION_COOKIE, LOGIN_COOKIE } from './sso.ts';

// Auth navigation needs a real HTTPS response: WebKit cannot fulfill redirects
// through Playwright routing, and routed fake origins do not exercise its cookie
// transport. Only this disposable loopback certificate is untrusted; HTTPS,
// same-origin POSTs, 303 navigation and __Host- cookie handling remain real.
test.use({ ignoreHTTPSErrors: true });
async function fixtureFetch(server, request) {
  return server.fetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers),
    ...(!['GET', 'HEAD'].includes(request.method) ? { body: await request.arrayBuffer() } : {}) });
}
async function localHttpsFixture(handler) {
  const directory = await mkdtemp(join(tmpdir(), 'stem-account-browser-'));
  let server, origin;
  const errors = [], pending = new Set();
  try {
    const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
    server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (incoming, outgoing) => {
      const task = (async () => { try {
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const request = new Request(new URL(incoming.url, origin), { method: incoming.method, headers,
          ...(body.length ? { body } : {}) });
        const response = await handler(request);
        const responseBody = Buffer.from(await response.arrayBuffer());
        if (outgoing.destroyed) return;
        for (const [name, value] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name, value);
        const cookies = response.headers.getSetCookie();
        if (cookies.length) outgoing.setHeader('set-cookie', cookies);
        outgoing.writeHead(response.status); outgoing.end(responseBody);
      } catch (error) {
        errors.push(error.message);
        if (!outgoing.destroyed) {
          if (!outgoing.headersSent) outgoing.writeHead(500);
          outgoing.end('Local fixture request failed');
        }
      } })();
      pending.add(task); void task.finally(() => pending.delete(task));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = `https://127.0.0.1:${server.address().port}`;
    return { origin, errors, async close() {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await Promise.all(pending);
      await rm(directory, { recursive: true, force: true });
    } };
  } catch (error) {
    server?.closeAllConnections(); server?.close(); await rm(directory, { recursive: true, force: true }); throw error;
  }
}

test('Expired sign-in links give students readable recovery on desktop and mobile', async ({ page }) => {
  const origin = 'https://stem-signin.test';
  // This recovery page only needs the auth handler and its real static assets.
  // Avoid a second Workerd server (and its asset-proxy socket) for CSS/images.
  const assets = new Map([['/styles.css', 'text/css'], ['/cuny-ai-lab-logo.png', 'image/png'], ['/fonts/bricolage-grotesque-800.ttf', 'font/ttf']]);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(origin + '/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const response = path.startsWith('/auth/')
      ? await handleAuth(new Request(request.url(), { headers: await request.allHeaders() }), {
        PUBLIC_BASE_URL: origin, CANONICAL_BASE_URL: origin,
        IDENTITY: path === '/auth/callback' ? {} : undefined,
      })
      : assets.has(path)
        ? new Response(await readFile(new URL('../public' + path, import.meta.url)), { headers: { 'content-type': assets.get(path) } })
        : new Response(null, { status: 404 });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const response = await page.goto(origin + '/auth/callback?code=private-code&state=private-state');
    expect(response.status()).toBe(401);
    await expect(page.getByRole('heading', { name: 'Start sign-in again', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'CUNY Login', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/private-code|private-state|admission_required/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.STEM_SCREENSHOT_DIR) {
      await mkdir(process.env.STEM_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.STEM_SCREENSHOT_DIR}/signin-recovery-${viewport.width}.png`, fullPage: true });
    }
  }
  await page.getByRole('link', { name: 'CUNY Login', exact: true }).click();
  await expect(page).toHaveURL(origin + '/auth/login');
  await expect(page.getByRole('heading', { name: 'Sign-in is temporarily unavailable', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Retry', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'CUNY Login', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Verified sessions return to Splitter directly; unavailable verification offers Retry without guessing state', async ({ page, context }) => {
  const issuer = await createTestIdentityIssuer();
  const appJwt = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice });
  const token = '00000000-0000-4000-8000-000000000001.' + 's'.repeat(43);
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)), vars: {
    TEST_JWKS: issuer.jwksJson, TEST_BROWSER: 'true',
  } }] });
  let available = false, identityChecks = 0, frontend;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await server.listen();
    await server.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' },
      body: JSON.stringify(schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'))) });
    frontend = await localHttpsFixture(async request => {
      const { origin, pathname } = new URL(request.url);
      return pathname.startsWith('/auth/') ? handleAuth(request, {
        PUBLIC_BASE_URL: origin, CANONICAL_BASE_URL: origin, CAIL_IDENTITY_JWKS: issuer.jwksJson,
        REQUEST_LIMIT: { limit: async () => ({ success: true }) },
        IDENTITY: { identities: async received => {
          expect(received).toBe(token); identityChecks++;
          if (!available) throw new Error('fixture outage');
          return { ok: true, appJwt, gatewayJwt: 'unused', workspaceJwt: null };
        } },
      }) : fixtureFetch(server, request);
    });
    const origin = frontend.origin;
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': appJwt });
    await context.addCookies([{ name: SESSION_COOKIE, value: token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' }]);
    const expiredLink = origin + '/auth/callback?code=expired&state=expired&next=//attacker.test';
    const unavailable = await page.goto(expiredLink);
    expect(unavailable.status()).toBe(503);
    await expect(page.getByRole('heading', { name: 'Sign-in is temporarily unavailable', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Retry', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /CUNY Login|Settings/i })).toHaveCount(0);
    expect(identityChecks).toBe(1);
    available = true;
    const [retry] = await Promise.all([
      page.waitForResponse(response => response.url() === origin + '/auth/login'),
      page.getByRole('link', { name: 'Retry', exact: true }).click(),
    ]);
    expect(retry.status()).toBe(303); expect(retry.headers().location).toBe('/');
    await expect(page).toHaveURL(origin + '/');
    await expect(page.getByRole('heading', { name: 'Stem Splitter', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
    await page.goto(expiredLink);
    await expect(page).toHaveURL(origin + '/');
    await expect(page.getByRole('heading', { name: 'Stem Splitter', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: /sign.in/i })).toHaveCount(0);
    expect(identityChecks).toBe(3);
    expect((await context.cookies(origin)).find(cookie => cookie.name === SESSION_COOKIE)?.value).toBe(token);
    expect(errors).toEqual([]); expect(frontend.errors).toEqual([]);
  } finally { await page.close(); await frontend?.close(); await server.close(); }
});

test('Sign out submits a trusted origin, clears cookies and returns to Splitter', async ({ page, context }) => {
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)) }] });
  let revoked = false, submittedOrigin, frontend;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await server.listen();
    frontend = await localHttpsFixture(async request => {
      const { origin, pathname } = new URL(request.url);
      if (pathname === '/auth/logout') {
        submittedOrigin = request.headers.get('origin');
        return handleAuth(request, { PUBLIC_BASE_URL: origin, CANONICAL_BASE_URL: origin,
          IDENTITY: { revoke: async () => { revoked = true; }, identities: async () => ({ ok: false, status: 403 }) },
        });
      }
      if (pathname === '/api/account') return revoked
        ? Response.json({ error: { code: 'authentication_required', message: 'Sign in required' } }, { status: 401 })
        : Response.json({ account: { subject: 'fixture', role: 'student' } });
      if (pathname === '/api/model-quota') return Response.json({ quota: null });
      return fixtureFetch(server, request);
    });
    const origin = frontend.origin;
    await context.addCookies([SESSION_COOKIE, LOGIN_COOKIE].map(name => ({ name, value: name === SESSION_COOKIE ? '00000000-0000-4000-8000-000000000001.' + 'a'.repeat(43) : 'pending', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' })));
    await page.goto(origin + '/account.html');
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    const [logout] = await Promise.all([
      page.waitForResponse(response => response.url() === origin + '/auth/logout'),
      page.getByRole('button', { name: 'Sign out', exact: true }).click(),
    ]);
    expect(submittedOrigin).toBe(origin);
    expect(logout.request().method()).toBe('POST'); expect(logout.status()).toBe(303); expect(logout.headers().location).toBe('/');
    await expect(page).toHaveURL(origin + '/');
    expect(revoked).toBe(true);
    expect((await context.cookies()).filter(cookie => [SESSION_COOKIE, LOGIN_COOKIE].includes(cookie.name))).toEqual([]);
    await expect(page.getByRole('heading', { name: 'Stem Splitter', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'CUNY Login', exact: true })).toBeVisible();
    expect(errors).toEqual([]); expect(frontend.errors).toEqual([]);
  } finally { await page.close(); await frontend?.close(); await server.close(); }
});

test('Account stays simple; administration is deliberate, responsive, and recoverable', async ({ page, context }) => {
  const issuer = await createTestIdentityIssuer();
  const identities = Object.fromEntries(await Promise.all(['alice', 'carol'].map(async name => [name,
    await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS[name] })])));
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_ADMIN: TEST_SUBJECTS.carol, TEST_BROWSER: 'true' },
    secrets: { WEBHOOK_SECRET: 'fixture-only' } }] });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const consoleIssues = [];
  const usageConflicts = [];
  page.on('response', response => {
    if (response.status() === 409 && new URL(response.url()).pathname === '/api/usage-events') {
      usageConflicts.push(response.json().then(body => ({url:response.url(),body,
        requestActor:response.request().headers()['x-stem-usage-actor'],responseActor:response.headers()['x-stem-account']}))
        .catch(error => ({readError:error.message})));
    }
  });
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type())) consoleIssues.push({ text: message.text(), url: message.location().url });
  });
  let memberReads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/admin/users') memberReads++; });
  const receipts = process.env.STEM_SCREENSHOT_DIR;
  try {
    const { url } = await server.listen();
    const seed = statements => server.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(statements) });
    await seed(schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8')));
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': identities.carol });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(new URL('/account.html', url).href);
    await expect(page).toHaveTitle('Stem Splitter · Settings');
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.locator('#account-role')).toHaveText('Administrator access');
    await expect(page.locator('#account-splits')).toContainText('25 of 25 runs left today. Resets');
    await expect(page.getByRole('link', { name: 'Instructor Console', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Splitter', exact: true })).toHaveAttribute('href', '/');
    await expect(page.locator('#access-form')).toBeHidden();
    await expect(page.locator('#account-id')).toHaveCount(0);
    expect(memberReads).toBe(0);
    await expect(page.locator('body')).not.toContainText(/Workspace ID|back to the mixer|Manage CUNY sign-in/);
    if (receipts) {
      await mkdir(receipts, { recursive: true });
      await page.screenshot({ path: `${receipts}/account-admin-desktop-fixture.png`, fullPage: true });
    }
    await page.getByText('Manage access', { exact: true }).click();
    await expect(page.locator('#access-empty')).toBeVisible();
    await expect(page.locator('#access-form')).toBeHidden();
    expect(memberReads).toBe(1);

    await seed([`INSERT INTO app_users (subject) VALUES ('${TEST_SUBJECTS.alice}')`]);
    await page.reload();
    await page.getByText('Manage access', { exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Account', exact: true })).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeHidden();
    await page.getByRole('combobox', { name: 'Account', exact: true }).selectOption(TEST_SUBJECTS.alice);
    await expect(page.getByLabel('Instructor access ends', { exact: true })).toBeHidden();
    await expect(page.getByLabel('Allow access to Stem Splitter', { exact: true })).toBeChecked();
    await page.getByRole('combobox', { name: 'Access level', exact: true }).selectOption('instructor');
    await expect(page.getByLabel('Instructor access ends', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Instructor access ends', { exact: true })).toHaveAttribute('required', '');
    await expect(page.getByLabel('No end date', { exact: true })).not.toBeChecked();
    await page.getByLabel('Instructor access ends', { exact: true }).fill('2026-12-01T12:00');
    await page.getByRole('combobox', { name: 'Access level', exact: true }).selectOption('student');
    await page.getByLabel('Allow access to Stem Splitter', { exact: true }).uncheck();
    const [update] = await Promise.all([
      page.waitForRequest(request => request.method() === 'PUT'),
      page.getByRole('button', { name: 'Save changes', exact: true }).click(),
    ]);
    expect(update.postDataJSON()).toMatchObject({ role: 'student', disabled: true, expiresAt: null });
    await expect(page.locator('#access-status')).toHaveText('Access updated.');
    await expect(page.getByLabel('Allow access to Stem Splitter', { exact: true })).not.toBeChecked();
    await page.getByLabel('Allow access to Stem Splitter', { exact: true }).check();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(async () => (await page.request.get(new URL('/api/admin/users', url).href)).json().then(body => body.users.find(user => user.subject === TEST_SUBJECTS.alice).disabled)).toBe(0);

    // A provider-boundary failure affects only the deliberately opened management area.
    await page.route('**/api/admin/users', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Account access is temporarily unavailable.' }) }));
    await page.reload();
    await page.getByText('Manage access', { exact: true }).click();
    await expect(page.locator('#access-status')).toHaveText('Account access is temporarily unavailable.');
    await expect(page.locator('#account-role')).toHaveText('Administrator access');
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await expect(page.locator('#account-login')).toBeHidden();
    await expect(page.locator('#access-form')).toBeHidden();
    await page.unroute('**/api/admin/users');
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Account', exact: true })).toBeVisible();
    await expect(page.locator('#access-status')).toBeEmpty();
    await page.getByRole('combobox', { name: 'Account', exact: true }).selectOption(TEST_SUBJECTS.alice);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await page.getByRole('button', { name: 'Save changes', exact: true }).boundingBox()).height).toBeGreaterThanOrEqual(44);
    if (receipts) await page.screenshot({ path: `${receipts}/account-access-mobile-fixture.png`, fullPage: true });

    await context.setExtraHTTPHeaders({ 'x-fixture-identity': identities.alice });
    await page.reload();
    await expect(page.locator('#account-role')).toHaveText('Student access');
    const resources = page.getByRole('navigation', { name: 'CUNY AI Lab resources' });
    for (const [name, href] of Object.entries({
      'Lab home': 'https://ailab.gc.cuny.edu/',
      FAQ: 'https://ailab.gc.cuny.edu/faq/',
      Welcome: 'https://tools.ailab.gc.cuny.edu/welcome',
      'Model access': 'https://tools.ailab.gc.cuny.edu/model-access',
      'My classes': 'https://tools.ailab.gc.cuny.edu/my-classes',
    })) await expect(resources.getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
    await expect(page.locator('main > footer')).toContainText('Built through the Critical AI Literacy Institute.');
    await expect(page.locator('main > footer')).toContainText('Uploaded files are deleted after 90 days.');
    await expect(page.locator('#account-splits')).toContainText('15 of 15 runs left today. Resets');
    await expect(page.locator('#account-admin')).toBeHidden();
    await expect(page.getByRole('link', { name: 'Instructor Console', exact: true })).toBeHidden();
    await expect(page.getByText('Account ID', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (receipts) await page.screenshot({ path: `${receipts}/account-student-mobile-fixture.png`, fullPage: true });
    const day = new Date().toISOString().slice(0, 10);
    await seed(Array.from({ length: 10 }, (_, index) => `INSERT INTO app_request_reservations (id, subject, scope, day) VALUES ('account-split-${index}', '${TEST_SUBJECTS.alice}', 'split', '${day}')`));
    await page.reload();
    await expect(page.locator('#account-splits')).toContainText('15 of 15 runs left today'); // historical attempts are not manufactured successes
    await expect(page.locator('#account-chat')).toHaveCount(0);
    const listeningAccount=await(await page.request.get(new URL('/api/account',url).href)).json();
    expect(listeningAccount.chatAllowance).toBeNull();expect(listeningAccount.listeningUsage.remainingTurns).toBe(50);
    const clock=Date.now();
    await seed(Array.from({length:15},(_,index)=>`INSERT INTO app_operations(id,subject,kind,idempotency_key,fingerprint,day,state,phase,deadline,created_at,updated_at) VALUES('account-operation-${index}','${TEST_SUBJECTS.alice}','split','account-operation-${index}','fixture-${index}','${day}','${index<8?'succeeded':'queued'}','split',${clock+86400000},${clock},${clock})`));
    await page.reload();
    await expect(page.locator('#account-splits')).toContainText('0 of 15 runs left today. Resets');
    await expect(page.getByRole('link', { name: 'Splitter', exact: true })).toBeVisible();
    if (receipts) await page.screenshot({ path: `${receipts}/account-exhausted-mobile-fixture.png`, fullPage: true });
    // A counter outage is not zero usage, a failed sign-in, or a full allowance.
    await page.route('**/api/account', async route => {
      const upstream = await route.fetch();
      const body = await upstream.json();
      await route.fulfill({ response: upstream, json: { ...body, splitAllowance: null } });
    });
    await page.reload();
    await expect(page.locator('#account-splits')).toHaveText('Daily allowance unavailable.');
    await expect(page.locator('#account-role')).toHaveText('Student access');
    await expect(page.locator('#account-login')).toBeHidden();
    await page.unroute('**/api/account');
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': identities.carol });
    await page.reload();
    await page.getByText('Manage access', { exact: true }).click();
    await page.getByRole('combobox', { name: 'Account', exact: true }).selectOption(TEST_SUBJECTS.alice);
    await page.getByRole('combobox', { name: 'Access level', exact: true }).selectOption('instructor');
    await page.getByLabel('Instructor access ends', { exact: true }).fill('2026-12-01T12:00');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('#access-status')).toHaveText('Access updated.');
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': identities.alice });
    await page.reload();
    await expect(page.locator('#account-role')).toHaveText('Instructor access');
    await expect(page.getByRole('link', { name: 'Instructor Console', exact: true })).toBeVisible();
    await expect(page.locator('#account-admin')).toBeHidden();

    await context.setExtraHTTPHeaders({ 'x-fixture-identity': identities.carol });
    await page.reload();
    await page.getByText('Manage access', { exact: true }).click();
    await page.getByRole('combobox', { name: 'Account', exact: true }).selectOption(TEST_SUBJECTS.alice);
    await expect(page.getByLabel('No end date', { exact: true })).not.toBeChecked();
    await page.getByLabel('No end date', { exact: true }).check();
    await expect(page.getByLabel('Instructor access ends', { exact: true })).toBeHidden();
    await expect(page.locator('#access-expiry')).toBeDisabled();
    const [permanentUpdate] = await Promise.all([
      page.waitForRequest(request => request.method() === 'PUT'),
      page.getByRole('button', { name: 'Save changes', exact: true }).click(),
    ]);
    expect(permanentUpdate.postDataJSON()).toMatchObject({ role: 'instructor', disabled: false, expiresAt: null });
    await expect(page.locator('#access-status')).toHaveText('Access updated.');
    await page.reload();
    await page.getByText('Manage access', { exact: true }).click();
    await page.getByRole('combobox', { name: 'Account', exact: true }).selectOption(TEST_SUBJECTS.alice);
    await expect(page.getByRole('combobox', { name: 'Access level', exact: true })).toHaveValue('instructor');
    await expect(page.getByLabel('No end date', { exact: true })).toBeChecked();
    await expect(page.locator('#access-expiry')).toHaveValue('');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (receipts) await page.screenshot({ path: `${receipts}/account-permanent-mobile-fixture.png`, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await page.getByText('Manage access', { exact: true }).click();
    await page.getByRole('combobox', { name: 'Account', exact: true }).selectOption(TEST_SUBJECTS.alice);
    await expect(page.getByLabel('No end date', { exact: true })).toBeChecked();
    if (receipts) await page.screenshot({ path: `${receipts}/account-permanent-desktop-fixture.png`, fullPage: true });
    await page.getByLabel('No end date', { exact: true }).uncheck();
    await expect(page.getByLabel('Instructor access ends', { exact: true })).toBeVisible();
    await expect(page.locator('#access-expiry')).toHaveAttribute('required', '');
    await page.getByLabel('No end date', { exact: true }).check();
    await page.getByRole('combobox', { name: 'Access level', exact: true }).selectOption('student');
    await expect(page.getByLabel('No end date', { exact: true })).toBeHidden();
    await page.getByRole('combobox', { name: 'Access level', exact: true }).selectOption('instructor');
    await expect(page.getByLabel('No end date', { exact: true })).not.toBeChecked();
    await expect(page.locator('#access-expiry')).toHaveAttribute('required', '');

    await context.setExtraHTTPHeaders({ 'x-fixture-identity': identities.alice });
    await page.reload();
    await expect(page.locator('#account-role')).toHaveText('Instructor access');
    await expect(page.getByRole('link', { name: 'Instructor Console', exact: true })).toBeVisible();
    await expect(page.locator('#account-admin')).toBeHidden();
    await expect(page.locator('body')).not.toContainText('Your splits remain in your account for 90 days.');
    await expect(page.getByRole('button', {name: 'Sign out', exact: true})).toBeVisible();
    await expect(page.locator('body')).not.toContainText('open them on any browser');
    // Account details must not survive a sign-out from another tab.
    await context.setExtraHTTPHeaders({});
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('#account-login')).toBeVisible();
    await expect(page.locator('#account-details')).toBeHidden();
    await expect(page.locator('#account-footer')).toBeHidden();
    await expect(page.locator('#account-id')).toHaveCount(0);
    expect(errors).toEqual([]);
    // Deliberate fixture identity changes can race an old pagehide batch.
    // Accept only a proven actor-fence rejection, never arbitrary409 failures.
    const verifiedConflictUrls = new Set();
    for (const conflict of await Promise.all(usageConflicts)) {
      expect(conflict.readError).toBeUndefined();
      expect(conflict.body).toEqual({error:'The account changed. Discard these observations.'});
      expect([TEST_SUBJECTS.alice,TEST_SUBJECTS.carol]).toContain(conflict.requestActor);
      expect([TEST_SUBJECTS.alice,TEST_SUBJECTS.carol]).toContain(conflict.responseActor);
      expect(conflict.requestActor).not.toBe(conflict.responseActor);
      verifiedConflictUrls.add(conflict.url);
    }
    // Quota fixture has no Gateway JWT (401); the deliberate management outage
    // is 503. Do not allow unrelated console errors to disappear in that noise.
    expect(consoleIssues.filter(message =>
      !(/^Failed to load resource: the server responded with a status of (401|503)\b/.test(message.text) && /\/api\/(account|model-quota|admin\/users)$/.test(message.url)) &&
      !(message.text === 'Failed to load resource: the server responded with a status of 409 (Conflict)' && verifiedConflictUrls.has(message.url)) &&
      !(message.text === 'Failed to load resource: the server responded with a status of 404 (Not Found)' && message.url.endsWith('/favicon.ico'))
    )).toEqual([]);
  } finally { await server.close(); }
});

test('students can reach sign-in help during an outage and retry their intended page', async ({ page }) => {
  const origin='https://stem-signin-help.test';
  const server=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url))}]});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  try {
    await server.listen();
    await page.route(origin+'/**',async route=>{
      const request=route.request(),url=new URL(request.url());
      const response=url.pathname.startsWith('/auth/')
        ? await handleAuth(new Request(request.url(),{headers:await request.allHeaders()}),{PUBLIC_BASE_URL:origin,CANONICAL_BASE_URL:origin})
        : await server.fetch(url.pathname);
      await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
    });
    await page.goto(origin+'/account.html');
    await expect(page.getByRole('link',{name:'CUNY Login',exact:true})).toBeVisible();
    await expect(page.getByRole('link',{name:'Trouble signing in?',exact:true})).toHaveCount(0);
    await page.getByRole('link',{name:'CUNY Login',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Sign-in is temporarily unavailable'})).toBeVisible();
    await expect(page.getByRole('link',{name:'Stem Splitter home',exact:true})).toHaveAttribute('href','/');
    await expect(page.getByRole('link',{name:'Trouble signing in?',exact:true})).toBeVisible();
    await page.getByRole('link',{name:'Trouble signing in?',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Trouble signing in?'})).toBeVisible();
    for(const width of [1280,390]){
      await page.setViewportSize({width,height:900});
      const response=await page.goto(origin+'/auth/help?next=/teacher.html');
      expect(response.status()).toBe(200);
      await expect(page.getByRole('heading',{name:'Trouble signing in?'})).toBeVisible();
      await expect(page.getByRole('link',{name:'Try CUNY Login again'})).toHaveAttribute('href','/auth/login?next=%2Fteacher.html');
      await expect(page.getByRole('link',{name:'Try CUNY Login again'})).toHaveAttribute('rel','noopener noreferrer');
      await expect(page.getByRole('link',{name:'Back to Stem Splitter'})).toHaveAttribute('href','/');
      await expect(page.locator('body')).toContainText('Guest work stays in the browser');
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      if(process.env.STEM_SCREENSHOT_DIR){
        await mkdir(process.env.STEM_SCREENSHOT_DIR,{recursive:true});
        await page.screenshot({path:`${process.env.STEM_SCREENSHOT_DIR}/signin-help-${width}.png`,fullPage:true,animations:'disabled'});
      }
    }
    // Route at the context level so the new sign-in tab receives the same
    // outage fixture; it cannot accidentally navigate to a live identity site.
    await page.context().route(origin+'/auth/**',async route=>{
      const response=await handleAuth(new Request(route.request().url(),{headers:await route.request().allHeaders()}),{PUBLIC_BASE_URL:origin,CANONICAL_BASE_URL:origin});
      await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
    });
    const [signin]=await Promise.all([page.context().waitForEvent('page'),page.getByRole('link',{name:'Try CUNY Login again'}).click()]);
    await expect(signin).toHaveURL(origin+'/auth/login?next=%2Fteacher.html');
    await expect(signin.getByRole('heading',{name:'Sign-in is temporarily unavailable'})).toBeVisible();
    expect(await signin.evaluate(()=>window.opener===null)).toBe(true);
    await expect(page).toHaveURL(origin+'/auth/help?next=/teacher.html');
    await expect(page.getByRole('heading',{name:'Trouble signing in?'})).toBeVisible();
    await signin.close();
    expect(errors).toEqual([]);
  }finally {await server.close();}
});

test('a simulated external CUNY dead end leaves the student recovery tab available',async({page,context})=>{
 const server=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url))}]});
 let starts=0,app,provider;
 try {
  await server.listen();
  provider=await localHttpsFixture(async()=>new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local provider failure fixture</title><main><p>LOCAL TEST · simulated external provider failure</p><h1>Login Failed</h1><p>Unable to load Domain/Client profile</p></main></html>',{status:500,headers:{'Content-Type':'text/html'}}));
  app=await localHttpsFixture(async request=>{
   const url=new URL(request.url);
   if(!url.pathname.startsWith('/auth/'))return fixtureFetch(server,request);
   const response=await handleAuth(request,{
    PUBLIC_BASE_URL:app.origin,CANONICAL_BASE_URL:app.origin,REQUEST_LIMIT:{limit:async()=>({success:true})},
    IDENTITY:{begin:async()=>{starts++;return {url:'https://tools.ailab.gc.cuny.edu/worker-login?request=local-fixture'};}}
   });
   if(url.pathname!=='/auth/login')return response;
   expect(response.status).toBe(303);
   expect(response.headers.get('location')).toBe('https://tools.ailab.gc.cuny.edu/worker-login?request=local-fixture');
   // Verify the real app response, then substitute only the external destination.
   // The browser follows an actual HTTPS 303 with the app's cookie headers;
   // no live identity service is contacted by this local failure fixture.
   const headers=new Headers(response.headers);headers.set('location',provider.origin+'/error');
   return new Response(null,{status:response.status,headers});
  });
  for(const width of [1280,390]){
   await page.setViewportSize({width,height:900});await page.goto(app.origin+'/auth/help?next=/classroom.html');
   const [signin]=await Promise.all([context.waitForEvent('page'),page.getByRole('link',{name:'Try CUNY Login again'}).click()]);
   await signin.setViewportSize({width,height:900});
   await expect(signin).toHaveURL(provider.origin+'/error');await expect(signin.getByRole('heading',{name:'Login Failed'})).toBeVisible();
   expect(await signin.evaluate(()=>window.opener===null)).toBe(true);
   await expect(page).toHaveURL(app.origin+'/auth/help?next=/classroom.html');await expect(page.getByRole('link',{name:'Back to Stem Splitter'})).toBeVisible();
   if(process.env.STEM_SCREENSHOT_DIR){
    await mkdir(process.env.STEM_SCREENSHOT_DIR,{recursive:true});
    await signin.screenshot({path:`${process.env.STEM_SCREENSHOT_DIR}/simulated-provider-error-${width}.png`,fullPage:true,animations:'disabled'});
    await page.screenshot({path:`${process.env.STEM_SCREENSHOT_DIR}/recovery-retained-${width}.png`,fullPage:true,animations:'disabled'});
   }
   await signin.close();await page.getByRole('link',{name:'Back to Stem Splitter'}).click();await expect(page).toHaveURL(app.origin+'/');
   await expect(page.locator('h1')).toContainText('Splitter');
  }
  expect(starts).toBe(2);expect(app.errors).toEqual([]);expect(provider.errors).toEqual([]);
 }finally{await page.close();await app?.close();await provider?.close();await server.close();}
});

for (const width of [1280,390]) test(`named student activity loads audio on request at ${width}px`, async ({page,context})=>{
 const issuer=await createTestIdentityIssuer();
 const identity=await issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject:TEST_SUBJECTS.carol});
 const server=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url)),vars:{TEST_JWKS:issuer.jwksJson,TEST_ADMIN:TEST_SUBJECTS.carol,TEST_BROWSER:'true',CAIL_CLASSROOM_ENABLED:'false'}}]});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let audioReads=0;page.on('request',r=>{if(/\/students\/.*\/stems\//.test(r.url()))audioReads++;});
 try {
  const {url}=await server.listen();
  const sql=schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
  sql.push(`INSERT INTO app_users(subject) VALUES('${TEST_SUBJECTS.alice}')`,
   `INSERT INTO app_users(subject) VALUES('${TEST_SUBJECTS.bob}')`,
   `INSERT INTO account_display_names(subject,display_name,updated_at) VALUES('${TEST_SUBJECTS.alice}','Alice Rivera',${Date.now()})`,
   `INSERT INTO account_display_names(subject,display_name,updated_at) VALUES('${TEST_SUBJECTS.bob}','Bob Morgan',${Date.now()})`,
   `INSERT INTO jobs(id,filename,source_key,status,stems) VALUES('remix-fixture','Student recording','uploads/fixture.wav','done','[{"name":"vocals","key":"stems/remix-fixture/vocals.mp3"}]')`,
   `INSERT INTO job_owners(job_id,subject) VALUES('remix-fixture','${TEST_SUBJECTS.alice}')`);
  for(const [index,state] of ['succeeded','failed'].entries()) {
   const guest='guest-'+String(index).repeat(64),now=Date.now();
   sql.push(`INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES('${guest}',${now},${now+86400000},'2026-10-23')`,
    `INSERT INTO app_operations(id,subject,quota_class,kind,idempotency_key,fingerprint,day,state,phase,deadline,created_at,updated_at) VALUES('guest-activity-${index}','${guest}','guest','split','guest-activity-request-${index}','hash','2026-10-23','${state}','split',${now+86400000},${now},${now})`);
  }
  await server.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify(sql)});
  await server.fetch('/__fixture/audio',{method:'POST',headers:{'x-fixture':'local-only'},body:await readFile(new URL('../tests/fixtures/audio/vocals.mp3',import.meta.url))});
  await context.setExtraHTTPHeaders({'x-fixture-identity':identity});
  await page.setViewportSize({width,height:900});
  await page.goto(new URL('/account.html',url).href);
  await expect(page).toHaveTitle('Stem Splitter · Settings');
  await page.getByText('Manage access',{exact:true}).click();
  await expect(page.locator('#access-member')).toContainText('Alice Rivera');
  await expect(page.locator('#access-member')).not.toContainText('cail-');
  let activityReads=0;
  await page.route('**/api/teacher/students',async route=>{
   activityReads++;
   await route.fulfill({status:503,json:{error:'Activity is temporarily unavailable.'}});
  });
  await page.locator('#access-member').selectOption(TEST_SUBJECTS.alice);
  await expect(page.locator('#student-review')).toHaveAttribute('open','');
  await expect(page.locator('#student-name')).toHaveText('Alice Rivera');
  await expect(page.locator('#student-name')).toBeInViewport();
  await expect(page.locator('#student-status')).toHaveText('Activity is temporarily unavailable.');
  await expect(page.locator('#student-summary')).toBeEmpty();
  await expect(page.locator('#guest-activity')).toHaveText('Guest activity unavailable.');
  expect(activityReads).toBe(1);
  await page.unroute('**/api/teacher/students');
  await page.locator('#student-retry').click();
  await expect(page.locator('#student-summary')).toContainText('1 recorded split attempt · 1 completed');
  await expect(page.locator('#student-summary')).toContainText('Visit and playback history begins Oct 29');
  await expect(page.locator('#guest-activity')).toHaveText('2 split attempts · 1 completed · 2 sessions with splits');
  await expect(page.locator('#student-jobs')).toContainText('Student recording');

  // A slower recording response must not replace the next selected person's work.
  await page.locator('#access-member').selectOption(TEST_SUBJECTS.bob);
  await expect(page.locator('#student-summary')).toContainText('0 recorded split attempts · 0 completed');
  let releaseAlice, aliceStarted, aliceFinished;
  const heldAlice=new Promise(resolve=>{releaseAlice=resolve;});
  const startedAlice=new Promise(resolve=>{aliceStarted=resolve;});
  const finishedAlice=new Promise(resolve=>{aliceFinished=resolve;});
  const aliceJobs=`**/api/teacher/students/${TEST_SUBJECTS.alice}/jobs`;
  await page.route(aliceJobs,async route=>{
   const response=await route.fetch();aliceStarted();await heldAlice;
   await route.fulfill({response});aliceFinished();
  });
  await page.locator('#access-member').selectOption(TEST_SUBJECTS.alice);
  await startedAlice;
  await page.locator('#access-member').selectOption(TEST_SUBJECTS.bob);
  await expect(page.locator('#student-name')).toHaveText('Bob Morgan');
  await expect(page.locator('#student-status')).toHaveText('No saved splits in the past 90 days.');
  releaseAlice();await finishedAlice;
  await expect(page.locator('#student-name')).toHaveText('Bob Morgan');
  await expect(page.locator('#student-jobs')).toBeEmpty();
  await page.unroute(aliceJobs);
  await page.route(aliceJobs,route=>route.fulfill({status:503,json:{error:'Recordings are temporarily unavailable.'}}));
  await page.locator('#access-member').selectOption(TEST_SUBJECTS.alice);
  await expect(page.locator('#student-status')).toHaveText('Recordings are temporarily unavailable.');
  await page.unroute(aliceJobs);
  await page.locator('#student-retry').click();
  await expect(page.locator('#student-name')).toHaveText('Alice Rivera');
  await expect(page.locator('#student-jobs')).toContainText('Student recording');
  expect(audioReads).toBe(0);
  const receipts=process.env.STEM_SCREENSHOT_DIR;
  if(receipts){await mkdir(receipts,{recursive:true});await page.screenshot({path:`${receipts}/student-activity-${width}.png`,fullPage:true,animations:'disabled'});}
  await page.locator('#student-jobs').getByRole('link',{name:'Load',exact:true}).click();
  await expect(page.locator('.console-title')).toHaveText('Student recording');
  await expect(page.locator('.channel')).toHaveCount(1);
  await expect(page.locator('.shared-notice')).toHaveText('Student listening view.');
  await expect(page.getByRole('button',{name:/^Rename recording:/})).toHaveCount(0);
  await expect(page.getByRole('textbox',{name:'Recording title',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'RENAME',exact:true})).toHaveCount(0);
  await expect.poll(()=>audioReads).toBeGreaterThan(0);
  await expect(page.locator('.folder-btn')).toBeHidden();
  await expect(page.locator('.note-btn')).toBeHidden();
  await expect(page.locator('#station-word')).toHaveText('Splitter');
  await expect(page.locator('#station-tagline')).toHaveText('Split audio tracks into musical layers. Listen closely, one stem at a time. Take notes and cue the Listening Guy to guide analysis.');
  await expect(page.locator('#split-summary')).toBeHidden();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(receipts)await page.screenshot({path:`${receipts}/student-audio-${width}.png`,fullPage:true,animations:'disabled'});
  expect(errors).toEqual([]);
 }finally{await server.close();}
});

test('listening to a shared recording records student use without creating a split, and refreshes retain one visit',async({page,context})=>{
 const issuer=await createTestIdentityIssuer(),alice=TEST_SUBJECTS.alice,admin=TEST_SUBJECTS.carol;
 const token=subject=>issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject});
 const [studentToken,adminToken]=await Promise.all([token(alice),token(admin)]);
 const server=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url)),vars:{TEST_JWKS:issuer.jwksJson,TEST_ADMIN:admin,TEST_BROWSER:'true',CAIL_CLASSROOM_ENABLED:'false'}}]});
 const errors=[],batches=[];page.on('pageerror',error=>errors.push(error.message));
 let reviewer;
 try {
  const {url}=await server.listen(),sql=schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
  sql.push(`INSERT INTO app_users(subject,created_at) VALUES('${alice}','2026-10-08 18:00:00')`,
   `INSERT INTO jobs(id,filename,source_key,status,stems) VALUES('remix-fixture','Shared listening example','uploads/fixture.wav','done','[{"name":"vocals","key":"stems/remix-fixture/vocals.mp3"}]')`,
   `INSERT INTO public_split_links(job_id) VALUES('remix-fixture')`);
  await server.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify(sql)});
  await server.fetch('/__fixture/audio',{method:'POST',headers:{'x-fixture':'local-only'},body:await readFile(new URL('../tests/fixtures/audio/vocals.mp3',import.meta.url))});
  await context.setExtraHTTPHeaders({'x-fixture-identity':studentToken});
  let rejectFirst=true;
  await page.route('**/api/usage-events',async route=>{
   batches.push(route.request().postDataJSON());
   if(rejectFirst){rejectFirst=false;return route.fulfill({status:503,json:{error:'Temporary fixture outage'}});}
   return route.continue();
  });
  const activity=async()=>{
   const response=await server.fetch('/api/teacher/students',{headers:{'x-fixture-identity':adminToken}});
   expect(response.ok).toBe(true);return (await response.json()).students;
  };
  const student=async()=>(await activity()).find(row=>row.subject===alice);
  await page.goto(new URL('/?job=remix-fixture',url).href);
  await expect(page.locator('.channel')).toHaveCount(1);
  await expect.poll(async()=>(await student()).recordedVisits).toBe(1);
  await page.locator('.play-btn').click();
  await expect.poll(async()=>(await student()).recordedPlays).toBe(1);
  expect((await student()).runs).toBe(0);
  await page.locator('.play-btn').click();
  await page.reload();
  await expect(page.locator('.channel')).toHaveCount(1);
  await page.goto(new URL('/account.html',url).href);
  await expect(page.locator('#account-role')).toBeVisible();
  await expect.poll(()=>batches.filter(batch=>batch.events.some(event=>event.type==='page_view')).length).toBeGreaterThanOrEqual(3);
  await expect.poll(async()=>(await student()).recordedVisits).toBe(1);
  expect((await student()).recordedPlays).toBe(1);
  const visitIds=batches.flatMap(batch=>batch.events.filter(event=>event.type==='session_start').map(event=>event.id));
  expect(new Set(visitIds).size).toBe(1);
  expect(JSON.stringify(batches)).not.toContain('Shared listening example');
  expect(JSON.stringify(batches)).not.toContain('remix-fixture');
  reviewer=await context.newPage();
  reviewer.on('pageerror',error=>errors.push(error.message));
  await reviewer.setExtraHTTPHeaders({'x-fixture-identity':adminToken});
  await reviewer.goto(new URL('/account.html',url).href);
  await reviewer.locator('#student-review > summary').click();
  const row=reviewer.locator('#student-list > li').filter({hasText:'1 recorded visit · 1 recorded play'});
  await expect(row).toContainText('0 recorded split attempts');
  await expect(row).toContainText('1 recorded visit · 1 recorded play');
  await expect(row).toContainText('First account access');
  await expect(reviewer.locator('#student-list')).toContainText('(you)');
  for(const width of [1280,390]){
   await reviewer.setViewportSize({width,height:900});
   expect(await reviewer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   if(process.env.STEM_SCREENSHOT_DIR){await mkdir(process.env.STEM_SCREENSHOT_DIR,{recursive:true});await reviewer.screenshot({path:`${process.env.STEM_SCREENSHOT_DIR}/recorded-listening-${width}.png`,fullPage:true});}
  }
  // A delayed observation from Alice must never be assigned to the next account.
  const stale=await server.fetch('/api/usage-events',{method:'POST',headers:{'x-fixture-identity':adminToken,'Origin':new URL(url).origin,'X-Stem-Usage-Actor':alice,'Content-Type':'application/json'},body:JSON.stringify({events:[{id:'stale-playback-event-0001',type:'playback_start'}]})});
  expect(stale.status).toBe(409);
  expect((await activity()).find(row=>row.subject===admin).recordedPlays).toBe(0);
  expect(errors).toEqual([]);
 }finally{await reviewer?.close();await server.close();}
});

test('account pagination loads an older account beyond 200, reports completeness, and opens its activity',async({page,context})=>{
 const issuer=await createTestIdentityIssuer();
 const server=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url)),vars:{TEST_JWKS:issuer.jwksJson,TEST_ADMIN:TEST_SUBJECTS.carol}}]});
 try {
  const {url}=await server.listen();
  const sql=schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
  const oldest='cail-'+ '0'.repeat(32);
  for(let i=0;i<201;i++){
   const person='cail-'+i.toString(16).padStart(32,'0'),name=i===0?'Older eligible student':`Synthetic account ${i}`;
   sql.push(`INSERT INTO app_users(subject,created_at) VALUES('${person}','${new Date(1700000000000+i*1000).toISOString()}')`,
    `INSERT INTO account_display_names(subject,display_name,updated_at) VALUES('${person}','${name}',${Date.now()})`);
  }
  for(let i=0;i<41;i++)sql.push(`INSERT INTO jobs(id,filename,source_key,status,stems,created_at) VALUES('older-job-${i}','Older recording ${i}','uploads/fixture.wav','done','[]','${new Date(Date.now()-i*1000).toISOString().slice(0,19).replace('T',' ')}')`,`INSERT INTO job_owners(job_id,subject) VALUES('older-job-${i}','${oldest}')`);
  await server.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify(sql)});
  await context.setExtraHTTPHeaders({'x-fixture-identity':await issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject:TEST_SUBJECTS.carol})});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(new URL('/account.html',url).href);
  await page.getByText('Manage access',{exact:true}).click();
  const more=page.locator('#access-more');
  await expect(more).toBeVisible();await expect(page.locator('#access-list-status')).toContainText('More accounts');
  await expect(page.locator('#access-member')).not.toContainText('Older eligible student');
  for(let i=0;i<10&&await more.isVisible();i++){
   const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/users'&&new URL(r.url()).searchParams.has('cursor'));
   await more.click();expect((await response).ok()).toBe(true);await expect(more).toBeEnabled();
  }
  await expect(more).toBeHidden();await expect(page.locator('#access-list-status')).toHaveText('All available accounts loaded.');
  await expect(page.locator('#access-member')).toContainText('Older eligible student');
  const options=await page.locator('#access-member option').evaluateAll(nodes=>nodes.map(node=>node.value).filter(Boolean));
  expect(options).toHaveLength(201);expect(new Set(options).size).toBe(201);
  await page.locator('#access-member').selectOption(oldest);
  await expect(page.locator('#student-summary')).toContainText('41 recorded split attempts');
  await expect(page.locator('#student-name')).toHaveText('Older eligible student');
  await expect(page.locator('#student-list-status')).toHaveText('All available accounts loaded.');
  await expect(page.locator('#student-list-more')).toBeHidden();
  await expect(page.locator('#student-jobs > li')).toHaveCount(40);
  await page.locator('#student-review > summary').click();
  await page.locator('#student-review > summary').click();
  await page.locator('#student-more').click();
  await expect(page.locator('#student-jobs > li')).toHaveCount(41);
  await expect(page.locator('#student-more')).toBeHidden();expect(errors).toEqual([]);
 }finally{await server.close();}
});
