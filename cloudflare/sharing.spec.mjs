import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

test('shared split opens signed out, plays, and keeps private tools and data inaccessible', async ({ page, context }) => {
  const issuer = await createTestIdentityIssuer();
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_ADMIN: TEST_SUBJECTS.carol, TEST_BROWSER: 'true' } }] });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const { url } = await server.listen();
    const sql = schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
    sql.push(`INSERT INTO app_users (subject) VALUES ('${TEST_SUBJECTS.alice}')`,
      `INSERT INTO jobs (id, filename, source_key, status, model, stems, labels) VALUES ('remix-fixture', 'Shared audio', 'uploads/private.wav', 'done', 'htdemucs_ft', '[{"name":"vocals","key":"stems/remix-fixture/vocals.mp3"}]', '{"vocals":"PRIVATE LABEL"}')`,
      `INSERT INTO job_attributions(job_id,attribution) VALUES ('remix-fixture','{"provider":"commons","creator":"Fixture creator","licenseName":"CC BY 4.0","sourceUrl":"https://commons.wikimedia.org/wiki/File:Fixture.mp3","attributionText":"Fixture recording — Fixture creator. CC BY 4.0.","privateFixture":"DO NOT SHARE"}')`,
      `INSERT INTO job_owners (job_id, subject) VALUES ('remix-fixture', '${TEST_SUBJECTS.alice}')`);
    await server.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(sql) });
    await server.fetch('/__fixture/audio', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: await readFile(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url)) });
    const token = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice });
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': token });
    await page.goto(url.href);
    await expect(page.locator('.console-title')).toHaveText('Shared audio');
    await expect(page).toHaveTitle('Stem Splitter');
    await expect(page.locator('.split-meta')).toContainText('SPLITS');
    await expect(page.locator('#stem-choice')).not.toContainText(/parts/i);
    await expect(page.getByRole('radio', { name: '4 splits: voice, percussion, low end, the rest', exact: true })).toBeVisible();
    await expect(page.locator('footer .project-credit')).toContainText('Critical AI Literacy Institute');
    expect(await page.locator('main > footer').evaluate(el => getComputedStyle(el).borderTopWidth)).toBe('1px');
    expect(await page.locator('.project-credit').evaluate(el => getComputedStyle(el).borderBottomWidth)).toBe('0px');
    await page.locator('.recording-credit summary').click();
    await expect(page.locator('.recording-credit')).toContainText('Fixture creator');
    await page.locator('.session-actions-toggle').count().then(async n=>{if(n)await page.locator('.session-actions-toggle').click();});
    const zipDownload=page.waitForEvent('download');await page.locator('.export-btn').click({force:true});const zip=await zipDownload;const stream=await zip.createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);const zipBytes=Buffer.concat(chunks);expect(zipBytes.includes(Buffer.from('source-attribution.json'))).toBe(true);expect(zipBytes.includes(Buffer.from('Fixture creator'))).toBe(true);
    await page.locator('.share-btn:not(.to-remix-btn)').click();
    await expect.poll(async () => (await server.fetch('/api/shared-jobs/remix-fixture')).status).toBe(200);
    const sharedCredit=await(await server.fetch('/api/shared-jobs/remix-fixture')).json();expect(sharedCredit.attribution.creator).toBe('Fixture creator');expect(JSON.stringify(sharedCredit)).not.toContain('DO NOT SHARE');
    const fixture = await readFile(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url));
    for (const route of ['/api/shared-jobs/remix-fixture/stems/0', '/api/files/stems/remix-fixture/vocals.mp3']) {
      const headers = route.includes('/files/') ? { 'x-fixture-identity': token } : {};
      const response = await server.fetch(`${route}?download`, { headers: { ...headers, Range: 'bytes=0-1023' } });
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(`bytes 0-1023/${fixture.length}`);
      expect(response.headers.get('accept-ranges')).toBe('bytes');
      expect(response.headers.get('content-disposition')).toBe('attachment; filename="vocals.mp3"');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(fixture.subarray(0, 1024));
      const unsatisfiable = await server.fetch(route, { headers: { ...headers, Range: `bytes=${fixture.length}-` } });
      expect(unsatisfiable.status).toBe(416);
      const stale = await server.fetch(route, { headers: { ...headers, Range: 'bytes=0-0', 'If-Range': '"stale"' } });
      expect(stale.status).toBe(200);
      expect((await stale.arrayBuffer()).byteLength).toBe(fixture.length);
    }
    expect((await server.fetch('/api/files/stems/remix-fixture/vocals.mp3', { headers: { Range: 'bytes=0-0' } })).status).toBe(401);
    // The owner opens the same shared URL with the editable account view.
    await page.goto(new URL('/?job=remix-fixture', url).href);
    await expect(page.locator('.badge')).toHaveText('READY');
    await page.locator('.ch-name').click();
    await page.getByRole('textbox', { name: 'Split name', exact: true }).fill('Lead voice');
    await page.getByRole('textbox', { name: 'Split name', exact: true }).press('Enter');
    await expect(page.locator('.ch-name')).toHaveText('Lead voice');
    await expect(page.locator('.mute-btn')).toHaveAttribute('aria-label', 'Mute Lead voice');
    await page.reload();
    await expect(page.locator('.ch-name')).toHaveText('Lead voice');
    // A rejected write must not leave an unsaved label looking saved.
    await page.route('**/api/jobs/remix-fixture/labels', route => route.fulfill({ status: 503, json: { error: 'Could not save the split name. Try again.' } }));
    await page.locator('.ch-name').click();
    await page.getByRole('textbox', { name: 'Split name', exact: true }).fill('Not saved');
    await page.getByRole('textbox', { name: 'Split name', exact: true }).press('Enter');
    await expect(page.locator('.ch-name')).toHaveText('Lead voice');
    await expect(page.locator('#upload-message')).toContainText('Could not save');
    await page.unroute('**/api/jobs/remix-fixture/labels');
    await page.locator('.unshare-btn').click();
    await expect.poll(async () => (await server.fetch('/api/shared-jobs/remix-fixture')).status).toBe(404);
    await page.locator('.share-btn:not(.to-remix-btn)').click();
    await expect.poll(async () => (await server.fetch('/api/shared-jobs/remix-fixture')).status).toBe(200);
    await context.setExtraHTTPHeaders({});
    await page.goto(new URL('/?job=remix-fixture', url).href);
    await expect(page.locator('.console-title')).toHaveText('Shared audio');
    await expect(page.locator('.badge')).toHaveText('SHARED');
    await page.locator('.recording-credit summary').click();await expect(page.locator('.recording-credit')).toContainText('CC BY 4.0');
    await expect(page.locator('#upload-message')).toBeHidden();
    await expect(page.getByText('Shared split · Listen and mix. Notes and conversations stay private.', { exact: true })).toHaveCount(0);
    await expect(page.locator('.coach')).toBeHidden();
    await expect(page.locator('.note-btn')).toBeHidden();
    await expect(page.locator('.folder-btn')).toBeHidden();
    await expect(page.getByText('PRIVATE LABEL')).toHaveCount(0);
    await expect(page.getByText('Lead voice', { exact: true })).toHaveCount(0);
    await expect(page.locator('.shared-notice')).toContainText('Only the owner');
    await page.locator('.ch-name').click();
    await expect(page.locator('.ch-name-input')).toHaveCount(0);
    expect(await page.evaluate(async () => (await fetch('/api/jobs/remix-fixture/labels', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ labels: { vocals: 'Unauthorized' } }) })).status)).toBe(401);
    const refreshRequests=[];page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))refreshRequests.push(new URL(request.url()).pathname);});
    await expect(page.locator('.refresh-btn')).toHaveCount(0);
    await page.reload(); await expect(page.locator('.console')).toBeVisible();
    expect(refreshRequests.filter(path=>path.includes('/jobs/')||path.includes('conversation'))).toEqual([]);
    expect(refreshRequests).toContain('/api/shared-jobs/remix-fixture');
    await page.locator('.play-btn').click();
    await expect(page.locator('.tc-now')).not.toHaveText('0:00', { timeout: 8000 });
    await page.locator('.play-btn').click();
    expect(new URL(page.url()).searchParams.get('job')).toBe('remix-fixture');
    await page.reload();
    await expect(page.locator('.console-title')).toHaveText('Shared audio');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.play-btn')).toBeVisible();
    await page.locator('.console').screenshot({ path: '/tmp/stem-shared-mobile.png', animations: 'disabled' });
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
