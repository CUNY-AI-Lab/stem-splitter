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
    await page.goto(new URL('/stem-splitter/auth/login?next=%2Faccount.html', url).href);
    await expect(page).toHaveURL(/\/stem-splitter\/account(?:\.html)?$/);
    expect(outsideMount).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await harness.close(); }
});
