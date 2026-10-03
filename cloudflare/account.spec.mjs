import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
import { handleAuth, SESSION_COOKIE, LOGIN_COOKIE } from './sso.ts';

test('Expired sign-in links give students readable recovery on desktop and mobile', async ({ page }) => {
  const origin = 'https://stem-signin.test';
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)) }] });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await server.listen();
    await page.route(origin + '/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const response = path.startsWith('/auth/')
        ? await handleAuth(new Request(request.url(), { headers: await request.allHeaders() }), {
          PUBLIC_BASE_URL: origin, CANONICAL_BASE_URL: origin,
          IDENTITY: path === '/auth/callback' ? {} : undefined,
        })
        : await server.fetch(path);
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const response = await page.goto(origin + '/auth/callback?code=private-code&state=private-state');
      expect(response.status()).toBe(401);
      await expect(page.getByRole('heading', { name: 'Start sign-in again', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'CUNY Login', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'My account', exact: true })).toHaveCount(0);
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
    await expect(page.getByRole('link', { name: 'My account', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});

test('Verified sessions return to Splitter directly; unavailable verification offers Retry without guessing state', async ({ page, context }) => {
  const origin = 'https://stem-recovery.test';
  const issuer = await createTestIdentityIssuer();
  const appJwt = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice });
  const token = '00000000-0000-4000-8000-000000000001.' + 's'.repeat(43);
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)), vars: {
    TEST_JWKS: issuer.jwksJson, TEST_BROWSER: 'true',
  } }] });
  let available = false, identityChecks = 0;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { url } = await server.listen();
    await server.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' },
      body: JSON.stringify(schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'))) });
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': appJwt });
    await context.addCookies([{ name: SESSION_COOKIE, value: token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' }]);
    await page.route(origin + '/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const response = path.startsWith('/auth/')
        ? await handleAuth(new Request(request.url(), { headers: await request.allHeaders() }), {
          PUBLIC_BASE_URL: origin, CANONICAL_BASE_URL: origin, CAIL_IDENTITY_JWKS: issuer.jwksJson,
          REQUEST_LIMIT: { limit: async () => ({ success: true }) },
          IDENTITY: { identities: async received => {
            expect(received).toBe(token);
            identityChecks++;
            if (!available) throw new Error('fixture outage');
            return { ok: true, appJwt, gatewayJwt: 'unused', workspaceJwt: null };
          } },
        }) : await server.fetch(path);
      // Follow the actual handler's fixed home redirect into the local app,
      // never the real CUNY provider. This is a synthetic session fixture.
      if (response.status === 303) expect(response.headers.get('location')).toBe('/');
      await route.fulfill({ status: response.status,
        headers: { ...Object.fromEntries(response.headers), ...(response.status === 303 ? { location: url.href } : {}) },
        body: Buffer.from(await response.arrayBuffer()) });
    });
    const expiredLink = origin + '/auth/callback?code=expired&state=expired&next=//attacker.test';
    await page.goto(expiredLink);
    await expect(page.getByRole('heading', { name: 'Sign-in is temporarily unavailable', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Retry', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /CUNY Login|My account/i })).toHaveCount(0);
    available = true;
    await page.getByRole('link', { name: 'Retry', exact: true }).click();
    await expect(page).toHaveURL(url.href);
    await expect(page.getByRole('heading', { name: 'STEM SPLITTER', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'My account', exact: true })).toBeVisible();
    await page.goto(expiredLink);
    await expect(page).toHaveURL(url.href);
    await expect(page.getByRole('heading', { name: 'STEM SPLITTER', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: /sign.in/i })).toHaveCount(0);
    expect(identityChecks).toBe(3);
    expect((await context.cookies(origin)).find(cookie => cookie.name === SESSION_COOKIE)?.value).toBe(token);
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});

test('Sign out submits a trusted origin, clears cookies and returns to Splitter', async ({ page, context }) => {
  const origin = 'https://stem-signout.test';
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)) }] });
  let revoked = false;
  let submittedOrigin;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { url } = await server.listen();
    await context.addCookies([SESSION_COOKIE, LOGIN_COOKIE].map(name => ({ name, value: name === SESSION_COOKIE ? '00000000-0000-4000-8000-000000000001.' + 'a'.repeat(43) : 'pending', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' })));
    await page.route(origin + '/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/auth/logout') {
        const headers = await request.allHeaders();
        submittedOrigin = headers.origin;
        const response = await handleAuth(new Request(request.url(), { method: request.method(), headers }), {
          PUBLIC_BASE_URL: origin, CANONICAL_BASE_URL: origin,
          IDENTITY: { revoke: async () => { revoked = true; }, identities: async () => ({ ok: false, status: 403 }) },
        });
        // Redirect continuations bypass Playwright routing. Keep the destination
        // on the local harness, never a live service, after checking the handler.
        if (response.status === 303) expect(response.headers.get('location')).toBe('/');
        await route.fulfill({ status: response.status, headers: { ...Object.fromEntries(response.headers), ...(response.status === 303 ? { location: url.href } : {}), ...(response.headers.has('set-cookie') ? { 'set-cookie': response.headers.getSetCookie().join('\n') } : {}) }, body: await response.text() });
      } else if (path === '/api/account') {
        await route.fulfill({ json: { account: { subject: 'fixture', role: 'student' } } });
      } else if (path === '/api/model-quota') {
        await route.fulfill({ json: { quota: null } });
      } else if (path === '/') {
        await route.fulfill({ contentType: 'text/html', body: '<title>STEM Splitter</title><h1>STEM Splitter</h1><a href="/auth/login">CUNY Login</a>' });
      } else {
        const response = await server.fetch(path);
        const headers = Object.fromEntries(response.headers);
        // Only the fixture redirects to HTTP loopback after logout. Permit that
        // destination in its CSP while retaining the actual Referrer-Policy.
        if (headers['content-security-policy']) headers['content-security-policy'] = headers['content-security-policy'].replace("form-action 'self'", `form-action 'self' ${url.origin}`);
        await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
      }
    });
    await page.goto(origin + '/account.html');
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    expect(submittedOrigin).toBe(origin);
    await expect(page).toHaveURL(url.href);
    expect(revoked).toBe(true);
    expect((await context.cookies()).filter(cookie => [SESSION_COOKIE, LOGIN_COOKIE].includes(cookie.name))).toEqual([]);
    await expect(page.getByRole('heading', { name: 'STEM SPLITTER', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await server.close(); }
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
    await expect(page).toHaveTitle('STEM Splitter · Account');
    await expect(page.getByRole('heading', { name: 'My account', exact: true })).toBeVisible();
    await expect(page.locator('#account-role')).toHaveText('Administrator access');
    await expect(page.locator('#account-splits')).toContainText('10 of 10 runs left today. Resets');
    await expect(page.getByRole('link', { name: 'Guide instructions', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '← Back to Splitter', exact: true })).toHaveAttribute('href', '/');
    await expect(page.locator('#access-form')).toBeHidden();
    await expect(page.locator('#account-id')).toBeHidden();
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
    await expect(page.getByLabel('Allow access to STEM Splitter', { exact: true })).toBeChecked();
    await page.getByRole('combobox', { name: 'Access level', exact: true }).selectOption('instructor');
    await expect(page.getByLabel('Instructor access ends', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Instructor access ends', { exact: true })).toHaveAttribute('required', '');
    await expect(page.getByLabel('No end date', { exact: true })).not.toBeChecked();
    await page.getByLabel('Instructor access ends', { exact: true }).fill('2026-12-01T12:00');
    await page.getByRole('combobox', { name: 'Access level', exact: true }).selectOption('student');
    await page.getByLabel('Allow access to STEM Splitter', { exact: true }).uncheck();
    const [update] = await Promise.all([
      page.waitForRequest(request => request.method() === 'PUT'),
      page.getByRole('button', { name: 'Save changes', exact: true }).click(),
    ]);
    expect(update.postDataJSON()).toMatchObject({ role: 'student', disabled: true, expiresAt: null });
    await expect(page.locator('#access-status')).toHaveText('Access updated.');
    await expect(page.getByLabel('Allow access to STEM Splitter', { exact: true })).not.toBeChecked();
    await page.getByLabel('Allow access to STEM Splitter', { exact: true }).check();
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
    await expect(page.locator('footer')).toContainText('Built through the Critical AI Literacy Institute.');
    await expect(page.locator('footer')).toContainText('Uploaded files are deleted after 90 days.');
    await expect(page.locator('#account-splits')).toContainText('10 of 10 runs left today. Resets');
    await expect(page.locator('#account-admin')).toBeHidden();
    await expect(page.getByRole('link', { name: 'Guide instructions', exact: true })).toBeHidden();
    await page.getByText('Account ID', { exact: true }).click();
    await expect(page.locator('#account-id')).toHaveText(TEST_SUBJECTS.alice);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByText('Account ID', { exact: true }).click();
    if (receipts) await page.screenshot({ path: `${receipts}/account-student-mobile-fixture.png`, fullPage: true });
    const day = new Date().toISOString().slice(0, 10);
    await seed(Array.from({ length: 10 }, (_, index) => `INSERT INTO app_request_reservations (id, subject, scope, day) VALUES ('account-split-${index}', '${TEST_SUBJECTS.alice}', 'split', '${day}')`));
    await page.reload();
    await expect(page.locator('#account-splits')).toContainText('0 of 10 runs left today. Resets');
    await expect(page.getByRole('link', { name: '← Back to Splitter', exact: true })).toBeVisible();
    if (receipts) await page.screenshot({ path: `${receipts}/account-exhausted-mobile-fixture.png`, fullPage: true });
    // A counter outage is not zero usage, a failed sign-in, or a full allowance.
    await page.route('**/api/account', async route => {
      const upstream = await route.fetch();
      const body = await upstream.json();
      await route.fulfill({ response: upstream, json: { ...body, splitAllowance: null } });
    });
    await page.reload();
    await expect(page.locator('#account-splits')).toHaveText('Daily split allowance unavailable.');
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
    await expect(page.getByRole('link', { name: 'Guide instructions', exact: true })).toBeVisible();
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
    await expect(page.getByRole('link', { name: 'Guide instructions', exact: true })).toBeVisible();
    await expect(page.locator('#account-admin')).toBeHidden();
    await expect(page.locator('#account-footer')).toContainText('Your splits remain in your account for 90 days.');
    await expect(page.locator('body')).not.toContainText('open them on any browser');
    // Account details must not survive a sign-out from another tab.
    await context.setExtraHTTPHeaders({});
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('#account-login')).toBeVisible();
    await expect(page.locator('#account-details')).toBeHidden();
    await expect(page.locator('#account-footer')).toBeHidden();
    await expect(page.locator('#account-id')).toBeEmpty();
    expect(errors).toEqual([]);
    // Quota fixture has no Gateway JWT (401); the deliberate management outage
    // is 503. Do not allow unrelated console errors to disappear in that noise.
    expect(consoleIssues.filter(message =>
      !(/^Failed to load resource: the server responded with a status of (401|503)\b/.test(message.text) && /\/api\/(account|model-quota|admin\/users)$/.test(message.url)) &&
      !(message.text === 'Failed to load resource: the server responded with a status of 404 (Not Found)' && message.url.endsWith('/favicon.ico'))
    )).toEqual([]);
  } finally { await server.close(); }
});
