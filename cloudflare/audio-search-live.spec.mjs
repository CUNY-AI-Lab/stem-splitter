import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { setupServer } from 'msw/node';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
import { preserveWorkerRequestInit } from './test-outbound-request.mjs';

test('live unified search offers real audio through the existing controls without separate metadata buttons', async ({ page, context }, testInfo) => {
  test.skip(process.env.STEM_LIVE_AUDIO !== '1', 'Explicit public metadata check; no paid providers.');
  const issuer = await createTestIdentityIssuer(), upstream = [], writes = [], queries = [], errors = [];
  const query = process.env.STEM_LIVE_MUSIC_QUERY || 'jazz baby';
  const expectedSource = process.env.STEM_EXPECTED_AUDIO_SOURCE || 'loc';
  const observedHosts = ['api.openverse.org', 'www.loc.gov', 'data.labs.loc.gov'];
  // Observe real catalog responses; identity is the only fixture.
  const network = setupServer();
  network.events.on('request:start', ({ request }) => {
    if (observedHosts.includes(new URL(request.url).hostname)) upstream.push({ event: 'request', at: Date.now(),
      path: new URL(request.url).pathname, userAgent: request.headers.get('user-agent') });
  });
  network.events.on('response:bypass', ({ request, response }) => {
    const url = new URL(request.url);
    if (observedHosts.includes(url.hostname)) upstream.push({ path: url.pathname, status: response.status,
      retryAfter: response.headers.get('retry-after'), userAgent: request.headers.get('user-agent') });
  });
  const harness = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_ADMIN: TEST_SUBJECTS.carol, TEST_BROWSER: 'true', TEST_NO_COURSES: 'true' } }] });
  let receipt, response, routeBody, restoreFetch;
  try {
    const { url } = await harness.listen();
    // Wrangler initializes its outbound fetch bridge while listening. Install
    // the observer afterward so its real provider calls remain observable.
    network.listen({ onUnhandledRequest: 'bypass' });
    restoreFetch = preserveWorkerRequestInit();
    await harness.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' },
      body: JSON.stringify(schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'))) });
    const identity = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice });
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': identity });
    await page.addInitScript(() => {
      const original = window.fetch;
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (new URL(response.url).pathname === '/api/music/search') {
          const record = window.__liveMusicSearch = { status: response.status };
          void response.clone().text().then(body => { record.body = body; }, error => { record.error = error.message; });
        }
        return response;
      };
    });
    // Disable background instructor suggestions so the proof makes one deliberate search.
    await page.route('**/api/song-samples', route => route.fulfill({ json: { enabled: false, revision: 0, tracks: [] } }));
    await page.route('**/api/jobs', route => {
      if (route.request().method() === 'POST') { writes.push('POST /api/jobs'); return route.abort(); }
      return route.continue();
    });
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/music/search') queries.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url.href);
    await expect(page.locator('#yt-url')).toBeEnabled();
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/music/search');
    await page.locator('#yt-url').fill(query);
    response = await responsePromise;
    expect(response.status()).toBe(200);
    await expect.poll(() => page.evaluate(() => window.__liveMusicSearch?.body), { timeout: 35000 }).toBeTruthy();
    routeBody = await page.evaluate(() => window.__liveMusicSearch.body);
    const final = JSON.parse(routeBody.trim().split('\n').at(-1));
    expect(final.results.length).toBeGreaterThan(0);
    expect(final.results.some(track => track.openAudio?.provider === expectedSource)).toBe(true);
    expect(final.providers[expectedSource]).toBe('ready');
    await expect(page.locator('#song-search-label, #split-picker-label')).toHaveCount(0);
    await expect(page.locator('#recording-references')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Related pages', exact: true })).toHaveCount(0);
    const references = final.references;
    const choices = page.locator('#source-songs [role="option"]');
    await expect(choices).toHaveCount(final.results.length);
    // Keep the provider boundary visible when both sources are present.
    await page.locator('#source-songs').evaluate(list => {
      const boundary = [...list.querySelectorAll('[role="option"]')].find(option => option.textContent.includes('Internet Archive'));
      if (boundary) list.scrollTop = Math.max(0, boundary.offsetTop - list.clientHeight / 2);
    });
    const sourceBounds = await page.locator('#yt-disclosure').boundingBox();
    const listBounds = await page.locator('#source-songs').boundingBox();
    const resultsTop = Math.min(sourceBounds.y, listBounds.y);
    await page.screenshot({ path: testInfo.outputPath('live-audio-results.png'), animations: 'disabled',
      clip: { x: sourceBounds.x, y: resultsTop, width: sourceBounds.width,
        height: Math.max(sourceBounds.y + sourceBounds.height, listBounds.y + listBounds.height) - resultsTop } });
    await choices.nth(final.results.findIndex(track => track.openAudio?.provider === expectedSource)).click();
    await expect(page.getByRole('button', { name: 'FETCH', exact: true })).toBeEnabled();
    expect(await page.locator('audio').count()).toBe(0);
    expect(writes).toEqual([]); expect(queries).toHaveLength(1);
    const jobs = await (await harness.fetch('/api/jobs', { headers: { 'x-fixture-identity': identity } })).json();
    expect(jobs.jobs).toEqual([]);
    const { DB } = await harness.getWorker().getEnv();
    const totalJobs = (await DB.prepare('SELECT COUNT(*) AS count FROM jobs').first()).count;
    expect(totalJobs).toBe(0);
    const outbound = upstream.filter(event => event.event === 'request');
    expect(outbound.length).toBeGreaterThan(0); expect(outbound.length).toBeLessThanOrEqual(12);
    expect(outbound.every(event => event.userAgent?.includes('StemSplitter/0.1'))).toBe(true);
    expect(upstream.some(event => event.status === 200)).toBe(true);
    receipt = { checkedAt: new Date().toISOString(), query, expectedSource, localRouteStatus: response.status(), surface: 'Real local Workerd/D1 route and Chromium browser, fixture identity only',
      success: true, audioResults: final.results, references, upstream, routeBody, errors, searchRequests: queries.length, importWrites: writes.length, jobs: totalJobs, audioElements: 0, productionDeployed: false };
    const splitBounds = await page.locator('#stem-choice').boundingBox();
    await page.screenshot({ path: testInfo.outputPath('live-audio-selected.png'), animations: 'disabled',
      clip: { x: sourceBounds.x, y: sourceBounds.y, width: sourceBounds.width,
        height: splitBounds.y + splitBounds.height - sourceBounds.y } });
  } finally {
    const browserResponse = await page.evaluate(() => window.__liveMusicSearch).catch(() => null);
    const output = process.env.STEM_AUDIO_RECEIPT;
    if (output) { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(receipt ?? { checkedAt: new Date().toISOString(), query, success: false,
      localRouteStatus: response?.status(), routeBody, browserResponse, upstream, writes, errors, runtimeLogs: harness.getLogs(),
      resultText: await page.locator('#source-songs').textContent().catch(() => null), searchRequests: queries.length }, null, 2) + '\n'); }
    await page.close(); await harness.close(); restoreFetch?.(); network.close();
  }
});
