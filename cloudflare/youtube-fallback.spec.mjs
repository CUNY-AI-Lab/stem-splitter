import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

test('enabled link router turns YouTube metadata into Archive search and a local-upload alternative without creating a job', async ({ page, context }) => {
  const issuer = await createTestIdentityIssuer();
  const harness = createTestHarness({ workers: [{
    configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_BROWSER: 'true' },
  }] });
  const { url } = await harness.listen();
  const sourceUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  const query = 'Fixture ensemble Fixture classroom recording';
  const metadataRequests = [], searchQueries = [], blockedMutations = [], errors = [];
  try {
    const seeded = await harness.fetch('/__fixture/schema', {
      method: 'POST', headers: { 'x-fixture': 'local-only' },
      body: JSON.stringify(schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'))),
    });
    expect(seeded.status).toBe(200);
    const token = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice });
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': token });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), target = new URL(request.url());
      // Keep browser traffic local, including fonts; no real source/provider request is allowed.
      if (target.origin !== url.origin) return route.abort();
      if (target.pathname === '/api/import-options') return route.fulfill({ json: { linkRouter: true, urlImport: true } });
      if (target.pathname === '/api/link-info') {
        metadataRequests.push({ method: request.method(), body: request.postDataJSON() });
        return route.fulfill({ json: {
          kind: 'youtube', videoId: 'jNQXAC9IVRw', canonicalUrl: sourceUrl,
          title: 'Fixture classroom recording', author: 'Fixture ensemble', query,
        } });
      }
      if (target.pathname === '/api/song-samples') return route.fulfill({ json: { enabled: false, tracks: [] } });
      if (target.pathname === '/api/account/claim-guest') return route.fulfill({
        headers: { 'X-Stem-Account': request.headers()['x-stem-claim-actor'] }, json: { claimedJobIds: [] },
      });
      if (target.pathname === '/api/music/search') {
        searchQueries.push(target.searchParams.get('q'));
        return route.fulfill({ json: { results: [{
          id: 'fixture-archive-recording', title: 'Fixture classroom recording', artist: 'Fixture ensemble',
          archiveId: 'fixture-archive-recording', archiveFile: 'fixture.mp3',
          durationSec: 30, bytes: 100000, sourceUrl: 'https://archive.org/details/fixture-archive-recording',
        }] } });
      }
      // Fail closed before every other write, especially /api/jobs and upload/provider paths.
      if (target.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) {
        blockedMutations.push({ path: target.pathname, method: request.method() });
        return route.fulfill({ status: 409, json: { error: 'Fixture blocks all work creation.' } });
      }
      return route.continue();
    });
    await page.goto(url.href);
    const input = page.getByRole('combobox', { name: 'Song or link' });
    await expect(page.locator('#source-import-help')).toHaveText('YouTube links look for matching Internet Archive recordings. To use an exact recording, upload your audio file.');
    await input.fill(sourceUrl);
    await page.locator('#yt-form .yt-go').click();
    await expect(input).toHaveValue(query);
    await expect(page.locator('#upload-message')).toContainText('This app can’t fetch audio from YouTube.');
    await expect(page.locator('#upload-message')).toContainText('matching recordings from the Internet Archive, or upload your own file');
    await expect(page.getByRole('option', { name: /Fixture classroom recording.*Internet Archive/ })).toBeVisible();
    await expect(input).toBeEnabled();
    await expect(page.locator('#yt-form')).not.toHaveAttribute('aria-busy', 'true');
    const localUpload = page.getByRole('button', { name: 'Choose a local audio file', exact: true });
    await expect(localUpload).toBeVisible();
    const chooser = page.waitForEvent('filechooser');
    await localUpload.click();
    expect((await chooser).isMultiple()).toBe(false);
    expect(metadataRequests).toEqual([{ method: 'POST', body: { url: sourceUrl } }]);
    expect(searchQueries).toEqual([query]);
    expect(blockedMutations).toEqual([]);
    await expect(page.locator('.console')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await harness.close();
  }
});
