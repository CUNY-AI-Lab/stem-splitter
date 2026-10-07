import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

// Long, decodable, distinct tones exercise the actual media clocks past 0:43.
// No provider calls, user audio, or committed binary fixtures.
function tone(frequency) {
  const rate = 8000, samples = rate * 70;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(1200 * Math.sin(2 * Math.PI * frequency * i / rate)), 44 + i * 2);
  return wav;
}

async function fixture(page, names, { owned = false } = {}) {
  const issuer = await createTestIdentityIssuer();
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_BROWSER: 'true' } }] });
  const { url } = await server.listen();
  const stems = names.map(name => ({ name, key: `stems/remix-fixture/${name}.mp3` }));
  const sql = schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.push(`INSERT INTO jobs (id, filename, source_key, status, model, stems) VALUES ('remix-fixture', 'Playback review', 'uploads/fixture.wav', 'done', 'htdemucs_ft', '${JSON.stringify(stems)}')`,
    "INSERT INTO public_split_links (job_id) VALUES ('remix-fixture')");
  if (owned) {
    sql.push(`INSERT INTO app_users (subject) VALUES ('${TEST_SUBJECTS.alice}')`,
      `INSERT INTO job_owners (job_id, subject) VALUES ('remix-fixture', '${TEST_SUBJECTS.alice}')`);
    await page.context().setExtraHTTPHeaders({ 'x-fixture-identity': await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice }) });
  }
  await server.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(sql) });
  await page.route(owned ? '**/api/files/stems/remix-fixture/*' : '**/api/shared-jobs/remix-fixture/stems/*', route => {
    const filename = new URL(route.request().url()).pathname.split('/').pop();
    const index = owned ? names.indexOf(filename.replace(/\.mp3$/, '')) : Number(filename);
    const bytes = tone(180 + index * 100);
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: 'audio/wav',
      headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) },
      body: bytes.subarray(start, end + 1) });
  });
  await page.goto(new URL('/?job=remix-fixture', url).href);
  await expect(page.locator('.channel')).toHaveCount(names.length);
  await expect.poll(() => page.evaluate(() => mixers.get('remix-fixture').audios.every(a => a.duration > 69))).toBe(true);
  return server;
}

test('note entry clears the speed controls and stays usable on narrow and zoomed layouts', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const server = await fixture(page, ['vocals', 'drums', 'bass', 'other'], { owned: true });
  try {
    const input = page.getByRole('textbox', { name: 'Note text', exact: true });
    const receipts = process.env.STEM_SCREENSHOT_DIR;
    if (receipts) await mkdir(receipts, { recursive: true });
    for (const [width, zoom] of [[1440, 1], [768, 1], [540, 1], [414, 1], [390, 1], [360, 1], [320, 1], [1280, 2]]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(value => { document.documentElement.style.zoom = value; }, String(zoom));
      await page.locator('.note-btn').click();
      await expect(input).toBeFocused();
      await input.fill('A listening note with enough text to exercise the narrow input');
      const form = await page.locator('.note-form').boundingBox();
      const speed = await page.getByRole('group', { name: 'Playback speed' }).boundingBox();
      const field = await input.boundingBox();
      const save = await page.locator('.note-form button').boundingBox();
      const consoleBox = await page.locator('.console').boundingBox();
      if (receipts) await page.locator('.console').screenshot({ path: `${receipts}/annotation-${process.env.STEM_BROWSER || 'chrome'}-${width}-zoom${zoom}.png` });
      expect(speed.y, `${width}px at ${zoom}x: speed must clear note form`).toBeGreaterThanOrEqual(form.y + form.height + 4);
      expect(field.width).toBeGreaterThan(60);
      expect(field.x + field.width).toBeLessThanOrEqual(save.x - 3);
      expect(save.x + save.width).toBeLessThan(consoleBox.x + consoleBox.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.locator('.note-btn').click();
      await expect(page.locator('.note-form')).toHaveCount(1);
      await input.press('Escape');
      await expect(input).toHaveCount(0);
    }
    await page.evaluate(() => { document.documentElement.style.zoom = ''; });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const text of ['First saved note', 'Second saved note']) {
      await page.locator('.note-btn').click();
      await expect(input).toBeFocused();
      await input.fill(text);
      await page.locator('.note-form button').click();
      await expect(input).toHaveCount(0);
      await expect(page.locator('.notes')).toContainText(text);
    }
    await page.reload();
    await expect(page.locator('.note-row')).toHaveCount(2);
    await page.locator('.note-btn').click();
    for (const speed of [.5, .75, 1]) {
      await page.getByRole('button', { name: `Play at ${speed}× speed`, exact: true }).click();
      await expect.poll(() => page.evaluate(value => mixers.get('remix-fixture').audios.every(a => a.playbackRate === value), speed)).toBe(true);
    }
    await page.locator('.play-btn').click();
    await clockAdvances(page);
    await input.fill('Typing while listening');
    await input.press('Escape');
    await page.locator('.play-btn').click();
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});

async function clockAdvances(page) {
  const start = await page.evaluate(() => mixers.get('remix-fixture').audios[0].currentTime);
  await expect.poll(() => page.evaluate(() => {
    const m = mixers.get('remix-fixture');
    return m.audios[0].currentTime > 0 && m.tcNow.textContent === fmt(m.audios[0].currentTime)
      && !m.scrubbing ? m.audios[0].currentTime : -1;
  }), { intervals: [80, 120, 160] }).toBeGreaterThan(start + 1);
}

test('compact controls never obscure the short full-track waveform and omit the duplicate instrument list', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const server = await fixture(page, ['vocals', 'drums', 'bass', 'other']);
  try {
    await expect(page).toHaveTitle('Stem Splitter');
    await expect(page.locator('#split-legend')).toBeHidden();
    await page.getByRole('radio', { name: /^auto/i }).check();
    await expect(page.locator('#split-legend')).toBeVisible();
    await page.getByRole('radio', { name: /^4 splits/i }).check();
    await expect(page.locator('#split-legend')).toBeHidden();
    for (const width of [320, 360, 375, 390, 430, 540, 541, 600, 768, 834, 1024, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const row of await page.locator('.channel').all()) {
        const name = await row.locator('.ch-name').boundingBox();
        const meter = await row.locator('.meter').boundingBox();
        const box = await row.boundingBox();
        const controls = await row.locator('.ch-actions').boundingBox();
        expect(name.height).toBeLessThan(25);
        expect(meter.height).toBeCloseTo(width <= 540 ? 24 : 28, 1);
        expect(meter.x).toBeGreaterThan(name.x + name.width);
        expect(meter.x + meter.width).toBeCloseTo(box.x + box.width - 1.6, 0);
        expect(controls.y + controls.height).toBeLessThanOrEqual(meter.y - 2);
        expect(box.height).toBeLessThan(71);
        expect(controls.x).toBeGreaterThanOrEqual(meter.x - 1);
        expect(controls.x + controls.width).toBeLessThanOrEqual(box.x + box.width);
      }
      if ([320, 540, 768, 1440].includes(width)) {
        await page.locator('.console').screenshot({ path: `/tmp/stem-viewport-${process.env.STEM_BROWSER || 'chrome'}-${width}.png` });
      }
    }
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const row = page.locator('.channel').first();
      const name = await row.locator('.ch-name').boundingBox();
      expect(name.height).toBeLessThan(25);
      const meter = await row.locator('.meter').boundingBox();
      const rowBox = await row.boundingBox();
      expect(meter.x).toBeGreaterThan(name.x + name.width);
      expect(meter.x + meter.width).toBeCloseTo(rowBox.x + rowBox.width - 1.6, 0);
      if (width < 540) expect(meter.width).toBeGreaterThan(width - 200);
      for (const label of ['SOLO', 'FRONT', 'ONLY']) {
        await expect(row.locator('.solo-btn')).toHaveText(label);
        const solo = await row.locator('.solo-btn').boundingBox();
        const mute = await row.locator('.mute-btn').boundingBox();
        expect(solo.width).toBeCloseTo(mute.width, 2);
        expect(solo.height).toBeCloseTo(mute.height, 2);
        expect(mute.height).toBeLessThanOrEqual(33);
        expect(mute.width).toBeLessThanOrEqual(69);
        const currentMeter = await row.locator('.meter').boundingBox();
        expect(solo.y + solo.height).toBeLessThanOrEqual(currentMeter.y - 2);
        expect(mute.height).toBeGreaterThanOrEqual(24);
        await row.locator('.solo-btn').click();
      }
      await row.locator('.mute-btn').click();
      await expect(row.locator('.mute-btn')).toHaveAttribute('aria-pressed', 'true');
      await row.locator('.mute-btn').click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.locator('.play-btn').click();
      await clockAdvances(page);
      await expect(row.locator('.waveform')).toBeVisible();
      await expect.poll(() => page.evaluate(() => mixers.get('remix-fixture').channelsByName.get('vocals').waveformStatus)).toBe('ready');
      expect(await page.evaluate(() => {
        const c = mixers.get('remix-fixture').channelsByName.get('vocals');
        return c.waveformPeaks.some(sample => Math.abs(sample) > 0.03) &&
          c.waveformDuration > 69 && c.waveform.width >= c.waveform.clientWidth;
      })).toBe(true);
      await page.locator('.console').screenshot({ path: `/tmp/stem-layout-${process.env.STEM_BROWSER || 'chrome'}-${width}.png` });
      await page.locator('.play-btn').click();
      expect(await page.evaluate(() => {
        const c = mixers.get('remix-fixture').channelsByName.get('vocals');
        return c.waveformStatus === 'ready' && c.waveformPeaks.some(sample => Math.abs(sample) > 0.03);
      })).toBe(true);
    }
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});

test('waveforms preserve source amplitude and stereo peaks; mute, pause and seek move no peaks', async ({ page }) => {
  const server = await fixture(page, ['vocals', 'drums', 'bass', 'other']);
  try {
    const results = await page.evaluate(async () => {
      const buffer = (...channels) => ({ length: channels[0].length, numberOfChannels: channels.length,
        getChannelData: c => Float32Array.from(channels[c]) });
      const silence = await waveformPeaks(buffer([0, 0, 0, 0]));
      const quiet = await waveformPeaks(buffer([0.001, -0.001, 0.001, -0.001]));
      const stereo = await waveformPeaks(buffer([0.5, 0.5, 0.5, 0.5], [-0.5, -0.5, -0.5, -0.5]));
      const invalid = await waveformPeaks(buffer([NaN, Infinity, 2, -2]));
      const arranged = await waveformPeaks(buffer([...Array(1024).fill(0), ...Array(1024).fill(0.75)]));
      return { silent: silence.every(v => v === 0), quiet: Math.max(...quiet),
        stereoLow: stereo[0], stereoHigh: stereo[1], bounded: invalid.every(v => Number.isFinite(v) && Math.abs(v) <= 1),
        early: arranged.slice(0, 2048).every(v => v === 0), later: Math.max(...arranged.slice(2048)) };
    });
    expect(results).toEqual({ silent: true, quiet: expect.closeTo(.001, 5), stereoLow: -.5, stereoHigh: .5,
      bounded: true, early: true, later: .75 });
    await page.locator('.play-btn').click();
    await clockAdvances(page);
    await expect.poll(() => page.evaluate(() => [...mixers.get('remix-fixture').channelsByName.values()].every(c => c.waveformStatus === 'ready'))).toBe(true);
    const sourcePeaks = await page.evaluate(() => [...mixers.get('remix-fixture').channelsByName.get('vocals').waveformPeaks]);
    const vocals = page.locator('.channel').filter({ hasText: 'vocals' });
    await vocals.locator('.mute-btn').click();
    await expect(vocals).toHaveClass(/muted/);
    expect(await page.evaluate(() => [...mixers.get('remix-fixture').channelsByName.get('vocals').waveformPeaks])).toEqual(sourcePeaks);
    await vocals.locator('.mute-btn').click();
    await page.locator('.play-btn').click();
    await page.evaluate(() => mixers.get('remix-fixture').seekTo(43));
    await expect(page.locator('.tc-now')).toHaveText('0:43');
    expect(await page.evaluate(() => [...mixers.get('remix-fixture').channelsByName.get('vocals').waveformPeaks])).toEqual(sourcePeaks);
    expect(await page.evaluate(() => {
      const c = mixers.get('remix-fixture').channelsByName.get('vocals');
      return Number(c.waveformFrame.split(':')[3]) / c.waveform.clientWidth;
    })).toBeCloseTo(43 / 70, 2);
    await page.locator('.play-btn').click();
    await clockAdvances(page);
    await page.locator('.play-btn').click();
  } finally { await server.close(); }
});

test('failed waveform decoding leaves normal playback and the transport intact', async ({ page }) => {
  await page.addInitScript(() => {
    window.OfflineAudioContext = class { decodeAudioData() { return Promise.reject(new Error('fixture decoder unavailable')); } };
  });
  const server = await fixture(page, ['vocals', 'drums', 'bass', 'other']);
  try {
    await page.locator('.play-btn').click();
    await clockAdvances(page);
    await expect.poll(() => page.evaluate(() => [...mixers.get('remix-fixture').channelsByName.values()].every(c => c.waveformStatus === 'unavailable'))).toBe(true);
    expect(await page.evaluate(() => [...mixers.get('remix-fixture').channelsByName.values()].every(c => c.waveformPeaks === null))).toBe(true);
    await page.evaluate(() => mixers.get('remix-fixture').seekTo(43));
    await clockAdvances(page);
    await page.locator('.channel').first().locator('.solo-btn').click();
    await clockAdvances(page);
    await page.locator('.play-btn').click();
  } finally { await server.close(); }
});

test('waveform downloads are bounded and disposed sessions cancel queued work', async ({ page }) => {
  const server = await fixture(page, ['vocals', 'drums', 'bass', 'other']);
  try {
    const results = await page.evaluate(async () => {
      const oversized = await waveformBytes(new Response('', { headers: { 'Content-Length': String(WAVEFORM_MAX_BYTES + 1) } })).then(() => false, () => true);
      const streaming = await waveformBytes(new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(WAVEFORM_MAX_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      } }))).then(() => false, () => true);
      const bytes = await waveformBytes(new Response(new Uint8Array([1, 2, 3])));
      const m = mixers.get('remix-fixture');
      m.disposeWaveforms();
      const cancelled = await waveformFor(m.audios[0], m.waveformAbort.signal).then(() => false, () => true);
      return { oversized, streaming, bytes: [...new Uint8Array(bytes)], cancelled };
    });
    expect(results).toEqual({ oversized: true, streaming: true, bytes: [1, 2, 3], cancelled: true });
    await page.locator('.play-btn').click();
    await clockAdvances(page);
    await page.locator('.play-btn').click();
  } finally { await server.close(); }
});

for (const names of [['vocals', 'instrumental'], ['vocals', 'drums', 'bass', 'other'], ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']]) {
  test(`${names.length} stems: seek to 0:43 and switch ONLY to FRONT without freezing`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const server = await fixture(page, names);
    try {
      const focus = page.locator('.channel').filter({ hasText: names.includes('bass') ? 'bass' : 'instrumental' });
      const vocals = page.locator('.channel').filter({ hasText: 'vocals' });
      await focus.locator('.solo-btn').click();
      await focus.locator('.solo-btn').click();
      await expect(focus.locator('.solo-btn')).toHaveText('ONLY');
      await page.locator('.play-btn').click();
      await clockAdvances(page);
      const seek = page.locator('.seek');
      await seek.scrollIntoViewIfNeeded();
      const box = await seek.boundingBox();
      await page.mouse.move(box.x + box.width * 0.05, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * (43 / 70), box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
      await expect.poll(() => page.evaluate(() => mixers.get('remix-fixture').audios[0].currentTime)).toBeGreaterThan(41);
      await vocals.locator('.solo-btn').click();
      await expect(vocals.locator('.solo-btn')).toHaveText('FRONT');
      await clockAdvances(page);
      await expect.poll(() => page.evaluate(() => {
        const a = mixers.get('remix-fixture').audios;
        return Math.max(...a.map(a => a.currentTime)) - Math.min(...a.map(a => a.currentTime));
      })).toBeLessThan(0.2);
      await page.locator('.console').screenshot({ path: `/tmp/stem-playback-${process.env.STEM_BROWSER || 'chrome'}-${names.length}.png` });
      if (names.length === 6) {
        await page.setViewportSize({ width: 390, height: 844 });
        await clockAdvances(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.locator('.console').screenshot({ path: `/tmp/stem-playback-${process.env.STEM_BROWSER || 'chrome'}-mobile.png` });
      }
      await page.locator('.play-btn').click();
      expect(errors).toEqual([]);
    } finally { await server.close(); }
  });
}

test('late slider input and a failed meter cannot strand the transport display', async ({ page }) => {
  const server = await fixture(page, ['vocals', 'drums', 'bass', 'other']);
  try {
    await page.locator('.play-btn').click();
    await clockAdvances(page);
    // A late input without change must not leave an unbounded preview latch.
    await page.locator('.seek').evaluate(seek => {
      seek.value = String(43 / 70 * 1000);
      seek.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clockAdvances(page);
    await page.evaluate(() => {
      const m = mixers.get('remix-fixture');
      const channel = m.channelsByName.get('vocals');
      channel.analyser = { getByteFrequencyData() { throw new Error('fixture meter unavailable'); } };
    });
    await clockAdvances(page);
    // Media time updates still refresh the display when animation is suspended.
    await page.evaluate(() => cancelAnimationFrame(mixers.get('remix-fixture').raf));
    await clockAdvances(page);
    await page.locator('.play-btn').click();
  } finally { await server.close(); }
});

test('a pending stem startup stops safely, can be cancelled, and can be retried', async ({ page }) => {
  const server = await fixture(page, ['vocals', 'drums', 'bass', 'other']);
  try {
    await page.clock.install();
    await page.evaluate(() => {
      const m = mixers.get('remix-fixture');
      m.audios[1].originalPlay = m.audios[1].play;
      m.audios[1].play = () => new Promise(() => {});
      void m.play();
    });
    await page.clock.fastForward(15_001);
    await expect(page.locator('.transport-notice')).toHaveText('Playback could not start. Press play to try again.');
    expect(await page.evaluate(() => {
      const m = mixers.get('remix-fixture');
      return !m.playing && !m.starting && m.audios.every(a => a.paused);
    })).toBe(true);
    // Cancelling a pending start settles play() rather than retaining a hung task.
    expect(await page.evaluate(async () => {
      const m = mixers.get('remix-fixture');
      const pending = m.play();
      m.pause();
      await pending;
      m.audios[1].play = m.audios[1].originalPlay;
      return !m.playing && !m.starting;
    })).toBe(true);
    await page.clock.resume();
    await page.locator('.play-btn').click();
    await clockAdvances(page);
    await expect(page.locator('.transport-notice')).toBeHidden();
    await page.locator('.collapse-btn').click();
    expect(await page.evaluate(() => mixers.get('remix-fixture').audios.every(a => a.paused))).toBe(true);
  } finally { await server.close(); }
});

for (const graph of [true, false]) test(`mute and focus transitions preserve the mix (${graph ? 'Web Audio' : 'element fallback'})`, async ({ page }) => {
  if (!graph) await page.addInitScript(() => { window.AudioContext = undefined; window.webkitAudioContext = undefined; });
  const server = await fixture(page, ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']);
  try {
    await page.locator('.play-btn').click();
    await clockAdvances(page);
    if (graph) await expect.poll(() => page.evaluate(() => mixers.get('remix-fixture').graphWired)).toBe(true);
    const vocals = page.locator('.channel').filter({ hasText: 'vocals' });
    const drums = page.locator('.channel').filter({ hasText: 'drums' });
    const bass = page.locator('.channel').filter({ hasText: 'bass' });
    await drums.locator('.mute-btn').click();
    await bass.locator('.solo-btn').click();
    await bass.locator('.solo-btn').click();
    await vocals.locator('.solo-btn').click();
    await vocals.locator('.mute-btn').click();
    await expect(vocals).toHaveClass(/muted/);
    await expect(vocals.locator('.solo-btn')).toHaveText('SOLO');
    await expect(drums).toHaveClass(/muted/);
    await expect(bass).not.toHaveClass(/muted|behind|focused/);
    await expect.poll(() => page.evaluate(() => [...mixers.get('remix-fixture').channelsByName.values()].map(c => c.mixGain))).toEqual([0, 0, 1, 1, 1, 1]);
    // Focusing a muted channel is still intentional audition; MUTE ends it.
    await vocals.locator('.solo-btn').click();
    await vocals.locator('.solo-btn').click();
    await vocals.locator('.mute-btn').click();
    await expect(vocals).toHaveClass(/muted/);
    await expect(vocals.locator('.solo-btn')).toHaveText('SOLO');
    for (const name of ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']) {
      const channel = page.locator('.channel').filter({ hasText: name });
      for (const stage of ['FRONT', 'ONLY', 'SOLO']) {
        await channel.locator('.solo-btn').click();
        await expect(channel.locator('.solo-btn')).toHaveText(stage);
        // Assert actual applied gain, not merely a button or CSS state.
        await expect.poll(() => page.evaluate(() => [...mixers.get('remix-fixture').channelsByName.values()].every(c =>
          c.gainNode ? Math.abs(c.gainNode.gain.value - c.mixGain) < 0.02
            : c.audio.muted === (c.mixGain === 0) && c.audio.volume === (c.mixGain || 1)))).toBe(true);
      }
    }
    await clockAdvances(page);
    await page.locator('.play-btn').click();
    if (graph) {
      await page.evaluate(() => audioCtx.suspend());
      await page.locator('.play-btn').click();
      await expect.poll(() => page.evaluate(() => audioCtx.state)).toBe('running');
      await clockAdvances(page);
      await page.locator('.play-btn').click();
    }
  } finally { await server.close(); }
});

test('seek cancellation, missing release, keyboard and repeated seeks remain bounded', async ({ page }) => {
  const server = await fixture(page, ['vocals', 'drums', 'bass', 'other']);
  try {
    const seek = page.locator('.seek');
    await page.evaluate(() => {
      const m = mixers.get('remix-fixture'), original = m.seekTo.bind(m);
      m.seekCalls = 0;
      m.seekTo = t => { m.seekCalls++; return original(t); };
    });
    await seek.dispatchEvent('pointerdown', { pointerId: 9 });
    await seek.evaluate(seek => {
      for (const value of [100, 300, 500, 614]) {
        seek.value = String(value);
        seek.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    expect(await page.evaluate(() => mixers.get('remix-fixture').seekCalls)).toBe(0);
    // Release outside the slider without change: exactly one multi-stem seek.
    await page.locator('body').dispatchEvent('pointerup', { pointerId: 9 });
    await expect.poll(() => page.evaluate(() => mixers.get('remix-fixture').seekCalls)).toBe(1);
    await expect(page.locator('.tc-now')).toHaveText('0:42');
    for (const event of ['pointercancel', 'lostpointercapture', 'blur']) {
      await seek.dispatchEvent('pointerdown', { pointerId: 9 });
      await seek.dispatchEvent(event, { pointerId: 9 });
      await expect.poll(() => page.evaluate(() => mixers.get('remix-fixture').scrubbing)).toBe(false);
    }
    await seek.dispatchEvent('pointerdown', { pointerId: 9 });
    await seek.evaluate(seek => { seek.value = '900'; seek.dispatchEvent(new Event('input', { bubbles: true })); });
    await seek.dispatchEvent('pointercancel', { pointerId: 9 });
    await expect(page.locator('.tc-now')).toHaveText('0:42');
    // Moving to another control resolves a missing pointer-up.
    await seek.dispatchEvent('pointerdown', { pointerId: 9 });
    await page.locator('.mute-btn').first().click();
    expect(await page.evaluate(() => mixers.get('remix-fixture').scrubbing)).toBe(false);
    await seek.focus();
    await seek.press('ArrowRight');
    await expect.poll(() => page.evaluate(() => mixers.get('remix-fixture').scrubbing)).toBe(false);
    await page.evaluate(() => {
      const m = mixers.get('remix-fixture');
      for (const t of [5, 60, 12, 43]) m.seekTo(t);
    });
    await page.locator('.play-btn').click();
    await clockAdvances(page);
    for (const rate of [0.5, 0.75, 1]) {
      await page.locator(`.rate-opt[data-rate="${rate}"]`).click();
      expect(await page.evaluate(() => mixers.get('remix-fixture').audios.map(a => a.playbackRate))).toEqual([rate, rate, rate, rate]);
    }
    await page.locator('.play-btn').click();
    await page.evaluate(() => mixers.get('remix-fixture').seekTo(-5));
    await expect(page.locator('.tc-now')).toHaveText('0:00');
    await page.evaluate(() => mixers.get('remix-fixture').seekTo(500));
    await expect(page.locator('.tc-now')).toHaveText('1:10');
    await page.evaluate(() => mixers.get('remix-fixture').seekTo(NaN));
    await expect(page.locator('.tc-now')).toHaveText('1:10');
    // Ordinary end-of-playback still rewinds and pauses every stem.
    await page.evaluate(() => mixers.get('remix-fixture').seekTo(69.5));
    await page.locator('.play-btn').click();
    await expect(page.locator('.tc-now')).toHaveText('0:00');
    expect(await page.evaluate(() => mixers.get('remix-fixture').audios.every(a => a.paused))).toBe(true);
  } finally { await server.close(); }
});

test('a frozen media clock parks every stem rather than leaving a half-playing mix', async ({ page }) => {
  const server = await fixture(page, ['vocals', 'drums', 'bass', 'other']);
  try {
    await page.locator('.play-btn').click();
    await clockAdvances(page);
    await page.evaluate(() => {
      const m = mixers.get('remix-fixture');
      const time = m.audios[0].currentTime;
      Object.defineProperty(m.audios[0], 'currentTime', { configurable: true, get: () => time });
      m.clockProgress = m.audios.map(a => ({ time: a.currentTime, advancedAt: performance.now() - 6000 }));
      m.resync();
      delete m.audios[0].currentTime;
    });
    await expect(page.locator('.transport-notice')).toHaveText('Playback stalled. Press play to try again.');
    expect(await page.evaluate(() => mixers.get('remix-fixture').audios.every(a => a.paused))).toBe(true);
    await page.locator('.play-btn').click();
    await clockAdvances(page);
    await expect(page.locator('.transport-notice')).toBeHidden();
    await page.locator('.play-btn').click();
  } finally { await server.close(); }
});

test('every waveform uses the shared seek commit for mouse, keyboard and playing stems', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const names = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
  const server = await fixture(page, names);
  try {
    await page.evaluate(() => {
      const m = mixers.get('remix-fixture'), original = m.seekTo.bind(m);
      m.seekCalls = 0; m.seekTo = time => { m.seekCalls++; return original(time); };
    });
    for (let index = 0; index < names.length; index++) {
      await page.setViewportSize({ width: index % 2 ? 320 : 1280, height: 1000 });
      const range = page.getByRole('slider', { name: `${names[index]} waveform position in Playback review`, exact: true });
      await expect(range).toBeEnabled();
      await expect(range).toHaveAccessibleName(`${names[index]} waveform position in Playback review`);
      await range.scrollIntoViewIfNeeded(); const box = await range.boundingBox();
      const before = await page.evaluate(() => { const m = mixers.get('remix-fixture'); return { time: m.audios[0].currentTime, calls: m.seekCalls }; });
      await page.mouse.move(box.x + box.width * .2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width * .6, box.y + box.height / 2, { steps: 8 });
      const preview = await page.evaluate(() => { const m = mixers.get('remix-fixture'); return { time: m.audios[0].currentTime, calls: m.seekCalls, scrubbing: m.scrubbing, values: m.seekControls.map(c => c.value) }; });
      expect(preview.time).toBeCloseTo(before.time, 2); expect(preview.calls).toBe(before.calls);
      expect(preview.scrubbing).toBe(true); expect(new Set(preview.values).size).toBe(1);
      await page.mouse.up();
      await expect.poll(() => page.evaluate(() => mixers.get('remix-fixture').seekCalls)).toBe(before.calls + 1);
      await expect.poll(() => page.evaluate(() => mixers.get('remix-fixture').audios.every(a => Math.abs(a.currentTime - 42) < .5 && a.paused))).toBe(true);
      await expect(range).toHaveAttribute('aria-valuetext', /0:4[12] of 1:10/);
      await range.press('Home'); await expect(page.locator('.tc-now')).toHaveText('0:00');
      await range.press('ArrowRight');
      await expect.poll(() => page.evaluate(() => mixers.get('remix-fixture').audios.every(a => a.currentTime > 0 && a.currentTime < .2))).toBe(true);
    }
    const range = page.locator('.waveform-seek').last();
    await range.press('End'); await expect(page.locator('.tc-now')).toHaveText('1:10');
    await range.press('Home');
    await mkdir('/tmp/stem-classroom-screenshots', { recursive: true });
    await page.locator('.console').screenshot({ path: `/tmp/stem-classroom-screenshots/waveform-seek-focus-${process.env.STEM_BROWSER || 'chrome'}.png` });
    await page.locator('.rate-opt[data-rate="0.75"]').click(); await page.locator('.play-btn').click(); await clockAdvances(page);
    const box = await range.boundingBox();
    await page.mouse.move(box.x + box.width * .2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .5, box.y + box.height / 2, { steps: 6 });
    expect(await page.evaluate(() => mixers.get('remix-fixture').playing)).toBe(true);
    await page.mouse.up(); await clockAdvances(page);
    await expect.poll(() => page.evaluate(() => { const m = mixers.get('remix-fixture'); return m.audios.every(a => !a.paused && a.playbackRate === .75 && Math.abs(a.currentTime - m.audios[0].currentTime) < .2); })).toBe(true);
    await page.locator('.play-btn').click();
    expect(await page.evaluate(() => mixers.get('remix-fixture').audios.every(a => a.paused))).toBe(true);
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});

test('waveform seeking fences cancellation, stale track input, missing metadata and disposed songs', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const server = await fixture(page, ['vocals', 'drums', 'bass', 'other']);
  const preview = async (range, pointerId, value) => {
    await range.dispatchEvent('pointerdown', { pointerId });
    await range.evaluate((control, value) => { control.value = String(value); control.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  };
  try {
    const first = page.locator('.waveform-seek').first(), second = page.locator('.waveform-seek').nth(1);
    await page.evaluate(() => mixers.get('remix-fixture').seekTo(14));
    for (const event of ['pointercancel', 'blur', 'Escape']) {
      await preview(first, 41, 800);
      if (event === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      else if (event === 'Escape') await first.press('Escape');
      else await first.dispatchEvent(event, { pointerId: 41 });
      await expect.poll(() => page.evaluate(() => mixers.get('remix-fixture').scrubbing)).toBe(false);
      await expect(page.locator('.tc-now')).toHaveText('0:14');
    }
    await preview(first, 41, 300);
    await first.dispatchEvent('lostpointercapture', { pointerId: 41 });
    await expect(page.locator('.tc-now')).toHaveText('0:21');
    await preview(first, 41, 400);
    await preview(second, 42, 700);
    // Late change from the former track cannot overwrite the active gesture.
    await first.evaluate(control => { control.value = '100'; control.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.locator('body').dispatchEvent('pointerup', { pointerId: 41 });
    expect(await page.evaluate(() => mixers.get('remix-fixture').scrubbing)).toBe(true);
    await page.locator('body').dispatchEvent('pointerup', { pointerId: 42 });
    await expect(page.locator('.tc-now')).toHaveText('0:49');
    for (const duration of [0, NaN, Infinity]) {
      await page.evaluate(duration => { const m = mixers.get('remix-fixture'); Object.defineProperty(m.audios[1], 'duration', { configurable: true, value: duration }); m.paint(); m.seekTo(5); }, duration);
      await expect(first).toBeDisabled(); await expect(page.locator('.seek')).toBeDisabled();
      expect(await page.evaluate(() => mixers.get('remix-fixture').audios.every(a => Math.abs(a.currentTime - 49) < .1))).toBe(true);
      await page.evaluate(() => { const m = mixers.get('remix-fixture'); delete m.audios[1].duration; m.paint(); });
    }
    await expect(first).toBeEnabled();
    await page.evaluate(() => {
      const old = mixers.get('remix-fixture'), next = new Mixer({ ...old.job, id: 'second-song', filename: 'Second song' });
      mixers.set('second-song', next); jobList.appendChild(next.el);
    });
    const other = page.locator('.console').last().locator('.waveform-seek').first();
    await expect(other).toBeEnabled();
    await preview(first, 51, 200);
    await preview(other, 52, 600);
    await page.locator('body').dispatchEvent('pointerup', { pointerId: 51 });
    expect(await page.evaluate(() => mixers.get('second-song').scrubbing)).toBe(true);
    await page.locator('body').dispatchEvent('pointerup', { pointerId: 52 });
    await expect.poll(() => page.evaluate(() => mixers.get('second-song').audios.every(a => Math.abs(a.currentTime - 42) < .1))).toBe(true);
    expect(await page.evaluate(() => mixers.get('remix-fixture').audios.every(a => Math.abs(a.currentTime - 14) < .1))).toBe(true);
    await preview(first, 61, 900);
    await page.evaluate(() => { const m = mixers.get('remix-fixture'); m.disposeWaveforms(); m.el.remove(); });
    await page.locator('body').dispatchEvent('pointerup', { pointerId: 61 });
    expect(await page.evaluate(() => { const m = mixers.get('remix-fixture'); return !m.scrubbing && m.audios.every(a => Math.abs(a.currentTime - 14) < .1); })).toBe(true);
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});

test('waveforms support native touch input without moving the narrow page or controls', async ({ browser, browserName }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  const server = await fixture(page, ['vocals', 'instrumental']);
  try {
    for (const range of await page.locator('.waveform-seek').all()) {
      await range.scrollIntoViewIfNeeded(); const box = await range.boundingBox();
      await page.touchscreen.tap(box.x + box.width * .5, box.y + box.height / 2);
      await expect.poll(() => page.evaluate(() => mixers.get('remix-fixture').audios.every(a => Math.abs(a.currentTime - 35) < .5 && a.paused))).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    if (browserName === 'chromium') {
      const range = page.locator('.waveform-seek').last(), box = await range.boundingBox();
      const client = await context.newCDPSession(page);
      const touch = x => ({ x, y: box.y + box.height / 2, id: 1 });
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(box.x + box.width * .5)] });
      for (const fraction of [.55, .6, .7, .8]) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(box.x + box.width * fraction)] });
      expect(await page.evaluate(() => mixers.get('remix-fixture').scrubbing)).toBe(true);
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(() => page.evaluate(() => mixers.get('remix-fixture').audios.every(a => Math.abs(a.currentTime - 56) < .5))).toBe(true);
      await client.detach();
    }
    expect(errors).toEqual([]);
  } finally { await server.close(); await context.close(); }
});

test('usage observations retry once with stable IDs and exclude private content and clock ticks',async({page})=>{
 const batches=[],actors=[];
 await page.route('**/api/usage-events',async route=>{batches.push(route.request().postDataJSON());actors.push(route.request().headers()['x-stem-usage-actor']);await route.fulfill({status:batches.length===1?503:200,contentType:'application/json',body:'{"accepted":true}'});});
 const server=await fixture(page,['vocals','drums','bass','other'],{owned:true});
 try {
  await expect.poll(()=>batches.length).toBeGreaterThanOrEqual(2);
  expect(batches[0]).toEqual(batches[1]);
  expect(actors[0]).toBe(TEST_SUBJECTS.alice);expect(actors[1]).toBe(actors[0]);
  await page.locator('.play-btn').click();
  await expect.poll(()=>page.evaluate(()=>mixers.get('remix-fixture').playing)).toBe(true);
  await page.evaluate(()=>{const m=mixers.get('remix-fixture');m.seekTo(42);m.seekTo(8,'loop');});
  await page.locator('.play-btn').click();
  await page.evaluate(()=>mixers.get('remix-fixture').pause());
  await expect.poll(()=>batches.flatMap(b=>b.events).filter(e=>e.type==='playback_stop').length).toBe(1);
  const events=batches.slice(1).flatMap(b=>b.events);
  expect(events.filter(e=>e.type==='seek')).toHaveLength(1);
  expect(events.find(e=>e.type==='seek').positionBucket).toBe(4);
  expect(events.filter(e=>e.type==='playback_start')).toHaveLength(1);
  expect(JSON.stringify(batches)).not.toContain('Playback review');
  expect(JSON.stringify(batches)).not.toContain(TEST_SUBJECTS.alice);
  expect(events.every(e=>Object.keys(e).every(k=>['id','type','jobId','durationMs','positionBucket'].includes(k)))).toBe(true);
  const before=batches.length;
  await page.evaluate(()=>{window.StemUsage.record('seek',{jobId:'remix-fixture',position:40});window.StemUsage.clear();});
  await page.waitForTimeout(1500);expect(batches.length).toBe(before);
 }finally{await server.close();}
});
