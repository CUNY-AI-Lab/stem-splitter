import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
import { preserveWorkerRequestInit } from './test-outbound-request.mjs';

for (const provider of ['archive', 'commons', 'freesound', 'loc']) for (const count of [2, 4, 6]) {
  test(`${provider} search audio uses the standard Fetch and ${count}-stem split flow`, async ({ page, context }) => {
    const issuer = await createTestIdentityIssuer();
    const source = await readFile(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0',
      fileURLToPath(new URL('../tests/fixtures/audio/vocals.mp3', import.meta.url))], { encoding: 'utf8' });
    expect(probe.status).toBe(0); const seconds = Number(probe.stdout.trim());
    const commons = { query: { pages: [{ ns: 6, pageid: 123, title: 'File:Fixture song.mp3', imageinfo: [{
      mediatype: 'AUDIO', mime: 'audio/mpeg', size: source.length, duration: seconds,
      url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Fixture_song.mp3', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Fixture_song.mp3',
      extmetadata: Object.fromEntries(Object.entries({ LicenseUrl: 'https://creativecommons.org/licenses/by/4.0/', License: 'cc-by-4.0',
        Artist: 'Fixture ensemble', Attribution: 'Fixture recording credit', ObjectName: 'Fixture song' }).map(([key, value]) => [key, { value }])),
    }] }] } };
    const channels = count === 2 ? ['vocals', 'no_vocals'] : count === 4 ? ['vocals', 'drums', 'bass', 'other'] : ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'];
    const model = count === 2 ? 'vocals_instrumental' : count === 4 ? 'htdemucs_ft' : 'htdemucs_6s';
    let starts = 0, imports = 0; const queries = [], submitted = [];
    const network = setupServer(
      http.get('https://musicbrainz.org/ws/2/recording/*', () => { queries.push('unexpected metadata'); return HttpResponse.json({ recordings: [] }); }),
      http.get('https://archive.org/advancedsearch.php', () => HttpResponse.json({ response: { docs: provider === 'archive' ? [{ identifier: 'fixture-linked', title: 'Fixture song', creator: 'Fixture ensemble' }] : [] } })),
      http.get('https://archive.org/metadata/fixture-linked', () => HttpResponse.json({ metadata: { title: 'Fixture album', creator: 'Fixture ensemble', mediatype: 'audio', subject: 'Music', licenseurl: 'https://creativecommons.org/licenses/by/4.0/' },
        files: [{ name: 'song.mp3', title: 'Fixture song', artist: 'Fixture ensemble', format: 'VBR MP3', source: 'original', length: String(seconds), size: String(source.length) }] })),
      http.get('https://archive.org/download/fixture-linked/song.mp3', ({ request }) => {
        if (!request.headers.has('range')) imports++;
        return new HttpResponse(source, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(source.length) } });
      }),
      http.get('https://commons.wikimedia.org/w/api.php', () => HttpResponse.json(provider === 'commons' ? commons : { query: { pages: [] } })),
      http.get('https://upload.wikimedia.org/wikipedia/commons/a/ab/Fixture_song.mp3', () => {
        imports++; return new HttpResponse(source, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(source.length) } });
      }),
      http.get('https://api.openverse.org/v1/audio/*', ({ request }) => {
        const row = { id: '0046330f-daa1-4d39-8e0d-11172d151be8', title: 'Fixture song', creator: 'Artist',
          foreign_landing_url: 'https://freesound.org/people/Artist/sounds/415186/', url: 'https://cdn.freesound.org/previews/415/415186_1658799-hq.mp3',
          source: 'freesound', provider: 'freesound', filetype: 'mp3', filesize: source.length, duration: seconds * 1000,
          license: 'by', license_version: '4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/' };
        return HttpResponse.json(new URL(request.url).pathname === '/v1/audio/' ? { results: provider === 'freesound' ? [row] : [] } : row);
      }),
      http.get('https://freesound.org/people/Artist/sounds/415186/', () => new HttpResponse(`<meta property="og:url" content="https://freesound.org/people/Artist/sounds/415186/"><meta property="og:audio:artist" content="Artist"><meta property="og:audio:title" content="Fixture song"><a title="Go to the full license text" href="https://creativecommons.org/licenses/by/4.0/">Attribution 4.0</a><div id="share-link" data-static-file-url="https://cdn.freesound.org/previews/415/415186_1658799-hq.mp3"></div>`, { headers: { 'Content-Type': 'text/html' } })),
      http.get('https://cdn.freesound.org/previews/415/415186_1658799-hq.mp3', () => { imports++; return new HttpResponse(source, { headers: { 'Content-Type': 'audio/mpeg' } }); }),
      http.get('https://data.labs.loc.gov/jukebox/manifest.json', () => HttpResponse.json({ cols: ['filename','item_id','md5','size','object_key'], rows: [['jukebox-31920_1.mp3','http://www.loc.gov/item/jukebox-31920/','30427eff83451a81d276935b19c7918f',source.length,'data.labs.loc.gov/jukebox/audio/jukebox-31920_1.mp3']] })),
      http.get('https://www.loc.gov/collections/national-jukebox/', () => HttpResponse.json({ results: provider === 'loc' ? [{ id: 'http://www.loc.gov/item/jukebox-31920/' }] : [] })),
      http.get('https://www.loc.gov/item/jukebox-31920/', () => HttpResponse.json({ item: { id: 'http://www.loc.gov/item/jukebox-31920/', title: 'Fixture song', date: '1919-04-18', profile: 'jukebox', access_restricted: false, location: ['united states'], item: { recording_repository: 'Recorded Sound Section, Library of Congress' }, rights: ['All recordings published prior to 1923 will enter the public domain.'], contributor_names: ['Fixture ensemble'] }, resources: [{ files: [[{ mediaType: 'A', canDownload: true, duration: seconds }]] }] })),
      http.get('https://data.labs.loc.gov/jukebox/audio/jukebox-31920_1.mp3', () => { imports++; return new HttpResponse(source, { headers: { 'Content-Type': 'binary/octet-stream' } }); }),
      http.post('https://api.replicate.com/v1/predictions', async ({ request }) => {
        const body = await request.json(); starts++;
        expect(body.input.model).toBe(count === 6 ? 'htdemucs_6s' : 'htdemucs_ft');
        expect(body.input.stem).toBe(count === 2 ? 'vocals' : undefined);
        return HttpResponse.json({ id: 'fixture-split', status: 'starting' });
      }),
      http.get('https://api.replicate.com/v1/predictions/fixture-split', () => HttpResponse.json({ id: 'fixture-split', status: 'succeeded',
        output: Object.fromEntries(channels.map(name => [name, `https://fixture.replicate.delivery/${name}.mp3`])) })),
      http.get('https://fixture.replicate.delivery/:name.mp3', () => new HttpResponse(source, { headers: { 'Content-Type': 'audio/mpeg' } })),
    );
    const harness = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
      vars: { TEST_JWKS: issuer.jwksJson, TEST_ADMIN: TEST_SUBJECTS.carol, TEST_BROWSER: 'true' },
      secrets: { REPLICATE_API_TOKEN: 'fixture-only', REPLICATE_MODEL_VERSION: 'fixture-pin', WEBHOOK_SECRET: 'fixture-only' } }] });
    let restoreFetch;
    try {
      const { url } = await harness.listen();
      network.listen({ onUnhandledRequest(request, print) { if (['127.0.0.1', 'localhost'].includes(new URL(request.url).hostname)) return; print.error(); } });
      restoreFetch = preserveWorkerRequestInit();
      await harness.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' },
        body: JSON.stringify(schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'))) });
      const jwt = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice });
      await context.setExtraHTTPHeaders({ 'x-fixture-identity': jwt });
      await page.route('**/api/song-samples', route => route.fulfill({ json: { enabled: false, tracks: [] } }));
      page.on('request', request => { if (new URL(request.url()).pathname === '/api/jobs' && request.method() === 'POST') submitted.push(request.postDataJSON()); });
      await page.goto(url.href); await page.getByLabel('Share with').selectOption('personal');
      await page.locator(`input[name="stem-model"][value="${model}"]`).check();
      await page.locator('#yt-url').fill('Fixture song');
      const choice = page.locator('#source-songs [role="option"]');
      await expect(choice).toHaveCount(1, { timeout: 18000 });
      await expect(choice).toContainText({ archive: 'Internet Archive', commons: 'Wikimedia Commons', freesound: 'Freesound', loc: 'Library of Congress' }[provider]);
      await expect(page.locator('#song-search-label, #split-picker-label')).toHaveCount(0);
      await expect(page.locator('.music-search-help')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Related pages', exact: true })).toHaveCount(0);
      await expect(page.locator('#recording-references')).toHaveCount(0);
      expect(queries).toEqual([]);
      await choice.click();
      if (process.env.STEM_SCREENSHOT_DIR && count === 4) {
        await mkdir(process.env.STEM_SCREENSHOT_DIR, { recursive: true });
        const sourceBounds = await page.locator('#yt-disclosure').boundingBox();
        const splitBounds = await page.locator('#stem-choice').boundingBox();
        await page.screenshot({ path: `${process.env.STEM_SCREENSHOT_DIR}/${provider}-audio-selected.png`, animations: 'disabled',
          clip: { x: sourceBounds.x, y: sourceBounds.y, width: sourceBounds.width,
            height: splitBounds.y + splitBounds.height - sourceBounds.y } });
      }
      const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/jobs' && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'FETCH', exact: true }).click();
      const result = await created, job = await result.json(); expect(result.status(), JSON.stringify(job)).toBe(202);
      const mixer = page.locator('.console').first();
      await expect(mixer.getByText('READY', { exact: true })).toBeVisible({ timeout: 25000 });
      await expect(mixer.locator('.ch-name')).toHaveText(channels.map(name => name === 'no_vocals' ? 'instrumental' : name));
      expect(submitted).toHaveLength(1); expect(submitted[0].model).toBe(model);
      if (provider === 'commons') expect(submitted[0].openAudio).toEqual({ provider: 'commons', itemId: '123', fileId: 'original' });
      else if (provider === 'freesound') expect(submitted[0].openAudio).toEqual({ provider, itemId: '0046330f-daa1-4d39-8e0d-11172d151be8', fileId: '415186' });
      else if (provider === 'loc') expect(submitted[0].openAudio).toEqual({ provider, itemId: '31920', fileId: '1' });
      else expect(submitted[0]).toMatchObject({ archiveId: 'fixture-linked', archiveFile: 'song.mp3', archiveSearch: true });
      const { DB, AUDIO } = await harness.getWorker().getEnv();
      const stored = await DB.prepare('SELECT source_key,source_type FROM jobs WHERE id=?').bind(job.id).first();
      expect(stored.source_type).toBe(provider);
      expect(Buffer.from(await (await AUDIO.get(stored.source_key)).arrayBuffer())).toEqual(source);
      const attribution = JSON.parse((await DB.prepare('SELECT attribution FROM job_attributions WHERE job_id=?').bind(job.id).first()).attribution);
      expect(attribution.sourceUrl).toContain({ archive: 'archive.org/details/fixture-linked', commons: 'commons.wikimedia.org/wiki/File:Fixture_song.mp3', freesound: 'freesound.org/people/Artist/sounds/415186', loc: 'www.loc.gov/item/jukebox-31920' }[provider]);
      expect(starts).toBe(1); expect(imports).toBeGreaterThan(0);
      // The app imported and ingested real MP3 bytes. Model responses above are
      // fixtures; this test does not claim a paid provider or model-quality run.
    } finally { await harness.close(); restoreFetch?.(); network.close(); }
  });
}
