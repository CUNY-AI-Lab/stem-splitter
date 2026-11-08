import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

test('a YouTube link imports its audio through the video importer, not an Archive search', async ({ page, context }) => {
  const sourceUrl = 'https://youtu.be/jNQXAC9IVRw';
  const issuer = await createTestIdentityIssuer();
  const harness = createTestHarness({ workers: [{
    configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_BROWSER: 'true' },
  }] });
  const { url } = await harness.listen();
  const canonicalUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  const metadataRequests = [], searchQueries = [], jobs = [], blockedMutations = [], errors = [];
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
      if (target.pathname === '/api/usage-events' && request.method() === 'POST') return route.continue();
      if (target.pathname === '/api/import-options') return route.fulfill({ json: { linkRouter: true, urlImport: true } });
      if (target.pathname === '/api/link-info') {
        metadataRequests.push({ method: request.method(), body: request.postDataJSON() });
        return route.fulfill({ json: {
          kind: 'youtube', videoId: 'jNQXAC9IVRw', canonicalUrl,
          title: 'Fixture classroom recording', author: 'Fixture ensemble', query: 'Fixture ensemble Fixture classroom recording',
        } });
      }
      if (target.pathname === '/api/song-samples') return route.fulfill({ json: { enabled: false, tracks: [] } });
      if (target.pathname === '/api/account/claim-guest') return route.fulfill({
        headers: { 'X-Stem-Account': request.headers()['x-stem-claim-actor'] }, json: { claimedJobIds: [] },
      });
      if (target.pathname === '/api/music/search') {
        searchQueries.push(target.searchParams.get('q'));
        return route.fulfill({ json: { results: [] } });
      }
      // Record the job request, then refuse it: no import or provider work may start here.
      if (target.pathname === '/api/jobs' && request.method() === 'POST') {
        jobs.push(request.postDataJSON());
        return route.fulfill({ status: 409, json: { error: 'Fixture blocks all work creation.' } });
      }
      if (target.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) {
        blockedMutations.push({ path: target.pathname, method: request.method() });
        return route.fulfill({ status: 409, json: { error: 'Fixture blocks all work creation.' } });
      }
      return route.continue();
    });
    const recordedVisit = page.waitForResponse(response => new URL(response.url()).pathname === '/api/usage-events' && response.request().method() === 'POST');
    await page.goto(url.href);
    const input = page.getByRole('combobox', { name: 'Song or link' });
    await page.getByLabel('Share with').selectOption('personal');
    // A recognizable link is a link to import, not a search.
    await input.fill(sourceUrl);
    await page.locator('#yt-form .yt-go').click();
    await expect(page.locator('#upload-message')).toContainText('Fixture blocks all work creation.');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].videoUrl).toBe(sourceUrl);
    expect(['sourceUrl', 'archiveId', 'openAudio'].filter(key => key in jobs[0])).toEqual([]);
    // The link router is never asked, so no metadata lookup can turn the link into a search.
    expect(metadataRequests).toEqual([]);
    expect(searchQueries).toEqual([]);
    await expect(page.locator('#upload-message')).not.toContainText('YouTube');
    await expect(input).toBeEnabled();
    expect((await recordedVisit).ok()).toBe(true);
    expect(blockedMutations).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await harness.close();
  }
});

test('a YouTube search result is listed with its channel and imports as a video link', async ({ page, context }) => {
  const issuer = await createTestIdentityIssuer();
  const harness = createTestHarness({ workers: [{
    configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_BROWSER: 'true' },
  }] });
  const { url } = await harness.listen();
  const videoUrl = 'https://www.youtube.com/watch?v=Yxep-gS-Btg';
  const jobs = [], blockedMutations = [], errors = [];
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
      if (target.origin !== url.origin) return route.abort();
      if (target.pathname === '/api/usage-events' && request.method() === 'POST') return route.continue();
      if (target.pathname === '/api/song-samples') return route.fulfill({ json: { enabled: false, tracks: [] } });
      if (target.pathname === '/api/account/claim-guest') return route.fulfill({
        headers: { 'X-Stem-Account': request.headers()['x-stem-claim-actor'] }, json: { claimedJobIds: [] },
      });
      if (target.pathname === '/api/music/search') return route.fulfill({ json: {
        providers: { archive: 'ready', commons: 'ready', freesound: 'ready', youtube: 'ready' },
        results: [{ id: 'youtube:Yxep-gS-Btg', provider: 'youtube', videoUrl, sourceUrl: videoUrl, title: 'Rydeen (Official Music Video)',
          channel: 'Fixture Channel', itemCreator: 'Fixture Channel', durationSec: 258, providerName: 'YouTube' }],
      } });
      if (target.pathname === '/api/jobs' && request.method() === 'POST') {
        jobs.push(request.postDataJSON());
        return route.fulfill({ status: 409, json: { error: 'Fixture blocks all work creation.' } });
      }
      if (target.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) {
        blockedMutations.push({ path: target.pathname, method: request.method() });
        return route.fulfill({ status: 409, json: { error: 'Fixture blocks all work creation.' } });
      }
      return route.continue();
    });
    await page.goto(url.href);
    const input = page.getByRole('combobox', { name: 'Song or link' });
    await page.getByLabel('Share with').selectOption('personal');
    await input.fill('rydeen');
    const option = page.getByRole('option', { name: /Rydeen \(Official Music Video\) — YouTube: Fixture Channel/ });
    await expect(option).toBeVisible();
    await expect(option).toContainText('4:18 · YouTube video');
    await option.click();
    await page.locator('#yt-form .yt-go').click();
    await expect(page.locator('#upload-message')).toContainText('Fixture blocks all work creation.');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].videoUrl).toBe(videoUrl);
    expect(['sourceUrl', 'archiveId', 'openAudio', 'displayTitle'].filter(key => key in jobs[0])).toEqual([]);
    expect(blockedMutations).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await harness.close();
  }
});
