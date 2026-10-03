import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer } from '@cuny-ai-lab/cail-identity/testing';
import { readFile } from 'node:fs/promises';
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

async function fixture(page, names) {
  const issuer = await createTestIdentityIssuer();
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_BROWSER: 'true' } }] });
  const { url } = await server.listen();
  const stems = names.map(name => ({ name, key: `stems/remix-fixture/${name}.mp3` }));
  const sql = schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.push(`INSERT INTO jobs (id, filename, source_key, status, model, stems) VALUES ('remix-fixture', 'Playback review', 'uploads/fixture.wav', 'done', 'htdemucs_ft', '${JSON.stringify(stems)}')`,
    "INSERT INTO public_split_links (job_id) VALUES ('remix-fixture')");
  await server.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(sql) });
  await page.route('**/api/shared-jobs/remix-fixture/stems/*', route => {
    const index = Number(new URL(route.request().url()).pathname.split('/').pop());
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

async function clockAdvances(page) {
  const start = await page.evaluate(() => mixers.get('remix-fixture').audios[0].currentTime);
  await expect.poll(() => page.evaluate(() => {
    const m = mixers.get('remix-fixture');
    return m.audios[0].currentTime > 0 && m.tcNow.textContent === fmt(m.audios[0].currentTime)
      && !m.scrubbing ? m.audios[0].currentTime : -1;
  })).toBeGreaterThan(start + 1);
}

test('compact controls overlay a full-height signal and omit the duplicate instrument list', async ({ page }) => {
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
        expect(meter.height).toBeCloseTo(width <= 540 ? 76 : 84, 1);
        expect(meter.x).toBeGreaterThan(name.x + name.width);
        expect(meter.x + meter.width).toBeCloseTo(box.x + box.width - 1.6, 0);
        expect(controls.y).toBeGreaterThanOrEqual(meter.y);
        expect(controls.y + controls.height).toBeCloseTo(meter.y + meter.height, 0);
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
        expect(solo.y + solo.height).toBeCloseTo(currentMeter.y + currentMeter.height, 0);
        await row.locator('.solo-btn').click();
      }
      await row.locator('.mute-btn').click();
      await expect(row.locator('.mute-btn')).toHaveAttribute('aria-pressed', 'true');
      await row.locator('.mute-btn').click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.locator('.play-btn').click();
      expect(await page.evaluate(() => {
        const c = mixers.get('remix-fixture').channelsByName.get('vocals');
        return c.waveformSignal.level === 0 && c.waveformSignal.history.every(level => level === 0);
      })).toBe(true);
      await clockAdvances(page);
      await expect(row.locator('.waveform')).toBeVisible();
      expect(await page.evaluate(() => {
        const c = mixers.get('remix-fixture').channelsByName.get('vocals');
        return c.samples.some(sample => Math.abs(sample) > 0.001) &&
          c.waveformSignal.history.some(level => level > 0.1) && c.waveform.width >= c.waveform.clientWidth;
      })).toBe(true);
      await page.locator('.console').screenshot({ path: `/tmp/stem-layout-${process.env.STEM_BROWSER || 'chrome'}-${width}.png` });
      await page.locator('.play-btn').click();
    }
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});

test('waveform modulation is phase-independent, bounded, smoothed and cleared on mute or seek', async ({ page }) => {
  const server = await fixture(page, ['vocals', 'drums', 'bass', 'other']);
  try {
    const results = await page.evaluate(() => {
      const tone = (amplitude, phase = 0) => Float32Array.from({ length: 1024 },
        (_, i) => amplitude * Math.sin(i / 1024 * Math.PI * 32 + phase));
      const quiet = waveformAmplitude(tone(0.0001));
      const normal = waveformAmplitude(tone(0.04));
      const shifted = waveformAmplitude(tone(0.04, Math.PI / 3));
      const loud = waveformAmplitude(tone(1));
      const signal = createWaveformSignal();
      updateWaveformSignal(signal, tone(0.04), 0, 1, true);
      const attack = signal.level;
      const first = [...signal.history];
      updateWaveformSignal(signal, tone(0.8), 16, 1.016, true);
      const throttled = first.every((v, i) => v === signal.history[i]);
      updateWaveformSignal(signal, tone(0), 50, 1.05, true);
      const release = signal.level;
      for (let i = 2; i <= 40; i++) updateWaveformSignal(signal, tone(0.04), i * 50, 1 + i * 0.05, true);
      const settled = signal.level;
      updateWaveformSignal(signal, tone(0), 2050, 43, true);
      const seekCleared = signal.history.every(v => v === 0);
      updateWaveformSignal(signal, tone(0.04), 2100, 43.05, true);
      updateWaveformSignal(signal, tone(0.04), 2150, 43.1, false);
      const muted = signal.level === 0 && signal.history.every(v => v === 0);
      return { quiet, normal, shifted, loud, attack, throttled, release, settled, seekCleared, muted };
    });
    expect(results.quiet).toBe(0);
    expect(results.normal).toBeGreaterThan(0.4);
    expect(results.normal).toBeLessThan(0.65);
    expect(results.shifted).toBeCloseTo(results.normal, 3);
    expect(results.loud).toBe(1);
    expect(results.attack).toBeGreaterThan(0);
    expect(results.attack).toBeLessThan(results.normal);
    expect(results.throttled).toBe(true);
    expect(results.release).toBeGreaterThan(results.attack * 0.7);
    expect(results.release).toBeLessThan(results.attack);
    expect(results.settled).toBeCloseTo(results.normal, 3);
    expect(results.seekCleared).toBe(true);
    expect(results.muted).toBe(true);
    await page.locator('.play-btn').click();
    await clockAdvances(page);
    await expect.poll(() => page.evaluate(() => mixers.get('remix-fixture').channelsByName.get('vocals').waveformSignal.level)).toBeGreaterThan(0.4);
    const vocals = page.locator('.channel').filter({ hasText: 'vocals' });
    await vocals.locator('.mute-btn').click();
    await expect.poll(() => page.evaluate(() => mixers.get('remix-fixture').channelsByName.get('vocals').waveformSignal.history.every(level => level === 0))).toBe(true);
    await vocals.locator('.mute-btn').click();
    await expect.poll(() => page.evaluate(() => mixers.get('remix-fixture').channelsByName.get('vocals').waveformSignal.level)).toBeGreaterThan(0.4);
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
