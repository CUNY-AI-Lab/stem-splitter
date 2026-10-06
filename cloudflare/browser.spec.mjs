import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
const receipts = process.env.STEM_SCREENSHOT_DIR;
test('CAIL student, instructor and admin surfaces; one Crate and attribution-bearing Remixer capture', async ({ page, context }) => {
  const issuer = await createTestIdentityIssuer();
  const alice = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice });
  const admin = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.carol });
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)), vars: {
    TEST_JWKS: issuer.jwksJson, TEST_ADMIN: TEST_SUBJECTS.carol, REMIXER_ENABLED: 'true', TEST_BROWSER: 'true',
  }, secrets: { WEBHOOK_SECRET: 'fixture-only' } }] });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  if (receipts) await mkdir(receipts, { recursive: true });
  try {
    const { url } = await server.listen();
    const sql = schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
    const attribution = { title: 'Licensed fixture', creator: 'Fixture ensemble', sourceUrl: 'https://archive.org/details/fixture', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', fileName: 'fixture.mp3' };
    sql.push(`INSERT INTO app_users (subject) VALUES ('${TEST_SUBJECTS.alice}')`,
      `INSERT INTO jobs (id, filename, source_key, status, model, stems) VALUES ('remix-fixture', 'Licensed fixture', 'uploads/fixture.wav', 'done', 'htdemucs_ft', '[{"name":"vocals","key":"stems/remix-fixture/vocals.mp3"}]')`,
      `INSERT INTO job_owners (job_id, subject) VALUES ('remix-fixture', '${TEST_SUBJECTS.alice}')`,
      `INSERT INTO job_attributions (job_id, attribution) VALUES ('remix-fixture', '${JSON.stringify(attribution)}')`);
    expect((await server.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(sql) })).status).toBe(200);
    await server.fetch('/__fixture/audio', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: await readFile(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url)) });
    await page.goto(new URL('/teacher.html', url).href);
    await expect(page.locator('#signin-panel')).toBeVisible();
    await expect(page.getByLabel('PASSWORD')).toBeHidden();
    await expect(page.getByRole('link', { name: 'CUNY Login', exact: true })).toHaveAttribute('href', '/auth/login?next=/teacher.html');
    await page.goto(new URL('/account.html', url).href);
    await expect(page.getByRole('link', { name: 'CUNY Login', exact: true })).toBeVisible();
    await expect(page.locator('#account-details')).toBeHidden();
    await page.goto(new URL('/teacher.html', url).href);
    if (receipts) await page.screenshot({ path: `${receipts}/01-instructor-signed-out.png`, fullPage: true, animations: 'disabled' });
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': alice });
    await page.addInitScript((subject) => localStorage.setItem(`jobs:${subject}`, JSON.stringify([{ id: 'remix-fixture', filename: 'Licensed fixture', model: 'htdemucs_ft' }])), TEST_SUBJECTS.alice);
    await page.goto(url.href);
    await expect(page.locator('.badge.ready')).toBeVisible();
    await expect(page.locator('#crate')).toHaveCount(1);
    await expect(page.locator('#split-summary')).toHaveText('// a closer listen');
    // Screenshot capture can outlast the short fixture. Keep it playing until
    // the explicit pause click, rather than accidentally toggling Play again.
    await page.evaluate(() => {
      for (const audio of mixers.get('remix-fixture').audios) audio.loop = true;
    });
    // A tap on the current seek position has no native `change` event.
    // Releasing it must not leave playback's clock in scrub-preview mode.
    const seek = page.locator('.console .seek');
    await seek.dispatchEvent('pointerdown', { pointerId: 1 });
    await seek.dispatchEvent('pointerup', { pointerId: 1 });
    await page.locator('.console .play-btn').click();
    await expect(page.locator('.console .tc-now')).not.toHaveText('0:00', { timeout: 8000 });
    if (receipts) {
      await page.locator('.console').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${receipts}/timer-playing-desktop.png` });
    }
    await page.locator('.console .play-btn').click();
    for (const event of ['pointercancel', 'lostpointercapture', 'blur']) {
      await seek.dispatchEvent('pointerdown', { pointerId: 1 });
      await seek.dispatchEvent(event, { pointerId: 1 });
      await expect.poll(() => page.evaluate(() => mixers.get('remix-fixture').scrubbing)).toBe(false);
    }
    await seek.focus();
    await seek.press('ArrowRight');
    expect(await page.evaluate(() => mixers.get('remix-fixture').scrubbing)).toBe(false);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.console .tc-now')).toBeVisible();
    await seek.dispatchEvent('pointerdown', { pointerId: 2, pointerType: 'touch' });
    await seek.dispatchEvent('pointerup', { pointerId: 2, pointerType: 'touch' });
    await page.locator('.console .play-btn').click();
    await expect.poll(() => page.evaluate(() => {
      const mixer = mixers.get('remix-fixture');
      return mixer.tcNow.textContent === fmt(mixer.audios[0].currentTime) && mixer.audios[0].currentTime > 1;
    })).toBe(true);
    if (receipts) {
      await page.locator('.console').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${receipts}/timer-playing-mobile.png` });
    }
    await page.locator('.console .play-btn').click();
    await page.setViewportSize({ width: 1280, height: 900 });
    const startup = await page.evaluate(async () => {
      const mixer = mixers.get('remix-fixture');
      const audio = mixer.audios[0];
      audio.loop = false;
      const original = audio.play;
      let resolve, calls = 0;
      audio.play = () => { calls++; return new Promise(done => { resolve = done; }); };
      const first = mixer.play();
      await mixer.play();
      mixer.pause();
      resolve();
      await first;
      audio.play = original;
      return { calls, playing: mixer.playing, starting: mixer.starting };
    });
    expect(startup).toEqual({ calls: 1, playing: false, starting: false });
    const failure = await page.evaluate(async () => {
      const mixer = mixers.get('remix-fixture');
      const extra = new Audio(mixer.audios[0].src);
      mixer.audios.push(extra);
      await mixer.play();
      mixer.audios[0].dispatchEvent(new Event('error'));
      const result = { stopped: mixer.audios.every(audio => audio.paused), playing: mixer.playing, disabled: mixer.playBtn.disabled };
      mixer.audios.pop();
      return result;
    });
    expect(failure).toEqual({ stopped: true, playing: false, disabled: true });
    await page.reload();
    await expect(page.locator('.badge.ready')).toBeVisible();
    await page.getByRole('tab', { name: /REMIXER/ }).click();
    await expect(page.locator('#crate')).toBeVisible();
    await page.locator('.shelf-stem').first().click();
    await expect(page.locator('.rlayer')).toHaveCount(1);
    await page.getByRole('button', { name: '● CAPTURE' }).click();
    await expect(page.getByRole('button', { name: '■ END TAKE' })).toBeVisible();
    await expect(page.locator('.rlayer')).toHaveAttribute('inert', '');
    await expect.poll(() => page.evaluate(() => remixNow())).toBeGreaterThan(0.25);
    await page.getByRole('button', { name: '■ END TAKE' }).click();
    const save = page.getByRole('link', { name: 'SAVE WITH CREDITS ↓' });
    await expect(save).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), save.click()]);
    const bytes = await readFile(await download.path());
    const bundle = { signature: [...bytes.slice(0, 4)], text: new TextDecoder().decode(bytes) };
    expect(bundle.signature).toEqual([80, 75, 3, 4]);
    expect(bundle.text).toContain('ATTRIBUTION.txt');
    expect(bundle.text).toContain('Fixture ensemble');
    expect(bundle.text).toContain('https://creativecommons.org/licenses/by/4.0/');
    if (receipts) await page.screenshot({ path: `${receipts}/02-remixer-fixture-export.png`, fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('tab', { name: /SPLITTER/ }).click();
    await expect(page.locator('.console-title')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.mouse.move(0, 0);
    if (receipts) await page.screenshot({ path: `${receipts}/03-student-mobile-fixture.png`, fullPage: true, animations: 'disabled' });
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': admin });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(new URL('/account.html', url).href);
    await expect(page.locator('#account-admin')).toBeVisible();
    await expect(page.locator('#access-form')).toBeHidden();
    await page.getByText('Manage access', { exact: true }).click();
    await page.getByRole('combobox', { name: 'Account', exact: true }).selectOption(TEST_SUBJECTS.alice);
    expect((await page.getByRole('button', { name: 'Save changes', exact: true }).boundingBox()).height).toBeGreaterThanOrEqual(44);
    await page.locator('#access-role').selectOption('instructor');
    await page.locator('#access-expiry').fill('2026-12-01T12:00');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('#access-status')).toHaveText('Access updated.');
    if (receipts) await page.screenshot({ path: `${receipts}/04-admin-access-fixture.png`, fullPage: true, animations: 'disabled' });
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': alice });
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': alice, 'x-fixture-course-role':'owner' });
    await page.goto(new URL('/teacher.html', url).href);
    await expect(page.locator('#console-panel')).toBeVisible();
    await page.locator('#amendment').fill('Ask students to compare two layers.');
    await page.locator('#change-note').fill('Listening exercise');
    await page.getByRole('button', { name: 'SAVE', exact: true }).click();
    await expect(page.locator('#prompt-status')).toContainText('Saved');
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
