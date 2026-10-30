import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

test.use({ actionTimeout: 10000 });

const course = 'msh-245-the-american-musical-experience-fall-2026-01';
const job = 'live-class-song';
const path = `/api/classroom/courses/${course}/jobs/${job}/live`;
const member = subject => 'stem-member-v1-' + createHash('sha256').update(`fixture:${course}:${subject}`).digest('hex');
function tone(frequency) {
  const rate = 8000, count = rate * 70, wav = Buffer.alloc(44 + count * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
  for (let index = 0; index < count; index++) wav.writeInt16LE(Math.round(1200 * Math.sin(index * 2 * Math.PI * frequency / rate)), 44 + index * 2);
  return wav;
}
async function setup(browser, count = 2) {
  const issuer = await createTestIdentityIssuer();
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)),
    vars: { TEST_JWKS: issuer.jwksJson, TEST_BROWSER: 'true', TEST_COURSE_OWNER_SUBJECT: TEST_SUBJECTS.alice } }] });
  const { url } = await server.listen();
  const subjects = [TEST_SUBJECTS.alice, ...Array.from({ length: count - 1 }, (_, index) => `cail-${String(index + 11).padStart(32, '0')}`)];
  const stems = ['vocals', 'bass'].map(name => ({ name, key: `stems/${job}/${name}.mp3` }));
  const sql = schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.push(`INSERT INTO app_users(subject) VALUES ${subjects.map(subject => `('${subject}')`).join(',')}`,
    `INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES('${job}','Synthetic class listening','uploads/fixture.wav','done','htdemucs_ft','${JSON.stringify(stems)}')`,
    `INSERT INTO job_owners VALUES('${job}','${subjects[0]}')`,
    `INSERT INTO job_courses(job_id,course_id,member_id,assigned_by,policy_version) VALUES('${job}','${course}','${member(subjects[0])}','${subjects[0]}','course-work-v1')`,
    `INSERT INTO course_folders(id,course_id,name,created_by,permission) VALUES('class-live-folder','${course}','Class listening','${subjects[0]}','comment')`,
    `INSERT INTO course_folder_items(folder_id,job_id,filename,model) VALUES('class-live-folder','${job}','Synthetic class listening','htdemucs_ft')`,
    ...[10, 20, 30].map(at => `INSERT INTO annotations(id,job_id,at_seconds,text,author_subject,author_name,provenance) VALUES('note-${at}','${job}',${at},'Section at ${at}','${subjects[0]}','Fixture Instructor','student')`));
  const seeded = await server.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(sql) });
  expect(seeded.status).toBe(200);
  const contexts = [], pages = [], identities = [], errors = [], writes = [], reads = [];
  for (let index = 0; index < count; index++) {
    const identity = await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: subjects[index] });
    const gatewayIdentity = await issuer.mintIdentityJwt({ audience: 'cail:gateway', subject: subjects[index] });
    identities.push(identity);
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-fixture-identity': identity, 'x-fixture-gateway-identity': gatewayIdentity } });
    contexts.push(context); const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (new URL(request.url()).pathname !== path) return;
      if (request.method() === 'PUT') writes.push({ actor: index, body: request.postDataJSON() });
      if (request.method() === 'GET') reads.push({ actor: index });
    });
    await page.route('**/api/song-samples', route => route.fulfill({ json: { enabled: false, tracks: [] } }));
    await page.route('**/api/music/search**', route => route.fulfill({ json: { results: [] } }));
    await page.route(`**/api/files/stems/${job}/*`, route => {
      const wav = tone(route.request().url().includes('vocals') ? 220 : 130);
      const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
      return route.fulfill({ status: range ? 206 : 200, contentType: 'audio/wav',
        headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` } : {}) }, body: wav.subarray(start, end + 1) });
    });
    await page.goto(new URL(`/?job=${job}`, url).href);
    await expect(page.locator('.channel')).toHaveCount(2);
    await expect.poll(() => page.evaluate(id => mixers.get(id).audios.every(audio => audio.duration > 69), job)).toBe(true);
  }
  return { server, pages, contexts, identities, errors, writes, reads, url,
    close: async () => { await Promise.allSettled(contexts.map(context => context.close())); await server.close(); } };
}
const state = page => page.evaluate(id => {
  const mixer = mixers.get(id);
  return { time: mixer.audios[0].currentTime, playing: mixer.playing, rate: mixer.rate, loop: mixer.loop,
    focus: mixer.soloState, following: mixer.classSession.following, leading: mixer.classSession.leading,
    revision: mixer.classSession.revision, blocked: mixer.classSession.audioBlocked };
}, job);
const convergence = async (pages, check) => expect.poll(async () => (await Promise.all(pages.map(state))).every(check), { timeout: 12000 }).toBe(true);

for (const failureMode of ['empty', 'incomplete']) test(`Listening Guide and chat recover ${failureMode} output during shared playback without a successful turn`, async ({ browser }) => {
  test.setTimeout(90000);
  const f = await setup(browser), [host, student] = f.pages;
  const gatewayCalls = async () => (await (await f.server.fetch('/__fixture/gateway-stats', { headers: { 'x-fixture': 'local-only' } })).json()).gatewayCalls;
  const usage = async () => (await host.request.get(new URL(`/api/jobs/${job}/listening-usage`, f.url).href)).json();
  try {
    await host.getByRole('button', { name: 'Start shared session', exact: true }).click();
    await student.getByRole('button', { name: 'Follow instructor', exact: true }).click();
    await host.locator('.play-btn').click();
    await expect.poll(async () => (await state(host)).playing).toBe(true);
    await host.locator('.coach-toggle').click();
    const before = await usage();
    let guideRequests = 0;
    await host.route(`**/api/jobs/${job}/guide`, route => {
      guideRequests++;
      return route.continue({ headers: { ...route.request().headers(), ...(guideRequests === 1 ? { 'x-fixture-gateway-mode': failureMode } : {}) } });
    });
    await host.locator('.coach-cue-btn').click();
    await expect(host.locator('.coach-hint')).toContainText('The Listening Guide is unavailable right now');
    await expect(host.locator('.coach-hint')).toContainText('It did not use a successful turn.');
    await expect(host.locator('.coach-hint')).toContainText('You can send it again as a new attempt.');
    await expect(host.locator('.coach-hint')).toContainText(`Reason: ${failureMode}_response.`);
    await expect(host.locator('.coach-hint')).toContainText('Support ID: 01900000-0000-7000-8000-000000000001');
    expect(await gatewayCalls()).toBe(1);
    const { serverTime: beforeTime, ...beforeAllowance } = before;
    const { serverTime: afterTime, ...afterAllowance } = await usage();
    expect(afterAllowance).toEqual(beforeAllowance);
    expect(Date.parse(afterTime)).toBeGreaterThanOrEqual(Date.parse(beforeTime));
    await expect(host.locator('.coach-cue-btn')).toBeEnabled();
    expect((await state(host)).leading).toBe(true);
    expect((await state(student)).following).toBe(true);
    await host.locator('.coach-cue-btn').click();
    await expect(host.locator('.coach-guide-text')).toContainText('Listen for the bass against the drums.');
    expect(await gatewayCalls()).toBe(2);
    await host.locator('.coach-form input').fill('What should we hear in this shared passage?');
    await host.locator('.coach-form input').press('Enter');
    await expect(host.getByRole('log').locator('.coach-row.coach')).toContainText('Listen for the bass against the drums.');
    await expect(host.locator('.coach-form input')).toBeEnabled();
    expect(await gatewayCalls()).toBe(3);
    expect((await state(host)).leading).toBe(true);
    expect((await state(student)).following).toBe(true);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('eight independent browsers opt into instructor playback, focus and section cues without sharing control', async ({ browser }) => {
  test.setTimeout(120000);
  const f = await setup(browser, 8), [host, ...students] = f.pages;
  try {
    await expect(host.getByRole('button', { name: 'Start shared session', exact: true })).toBeVisible();
    await students[0].locator('.seek').fill('400');
    await students[0].locator('.seek').dispatchEvent('change');
    expect((await state(host)).time).toBeLessThan(1);
    expect(f.writes).toEqual([]);
    await host.getByRole('button', { name: 'Start shared session', exact: true }).click();
    await expect.poll(async () => (await state(host)).leading).toBe(true);
    for (const page of students) {
      await expect(page.getByRole('button', { name: 'Follow instructor', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Follow instructor', exact: true }).click();
      await expect(page.locator('.seek')).toBeDisabled();
      await expect(page.locator('.note-btn')).toBeEnabled();
      await expect(page.locator('.mute-btn').first()).toBeEnabled();
    }
    await host.locator('.seek').fill('150'); await host.locator('.seek').dispatchEvent('change');
    await host.locator('.rate-opt[data-rate="0.75"]').click();
    await host.locator('.solo-btn').first().click();
    await host.locator('.note-loop[data-at="10"]').click();
    await convergence(students, current => Math.abs(current.time - 10.5) < .4 && current.rate === .75 && current.focus?.stem === 'vocals' && current.focus?.stage === 'behind' && current.loop?.start === 10 && current.loop?.end === 20);
    await host.locator('.play-btn').click();
    for (const page of students) {
      await expect.poll(async () => { const current = await state(page); return current.playing || current.blocked; }, { timeout: 10000 }).toBe(true);
      if ((await state(page)).blocked) await page.getByRole('button', { name: 'Join shared audio', exact: true }).click();
    }
    await convergence(f.pages, current => current.playing);
    await expect.poll(async () => {
      const times = (await Promise.all(f.pages.map(state))).map(current => current.time);
      return Math.max(...times) - Math.min(...times);
    }, { timeout: 12000 }).toBeLessThan(.75);
    await students[0].locator('.mute-btn').first().click();
    expect(await students[0].evaluate(id => mixers.get(id).userMuted.get('vocals'), job)).toBe(true);
    await host.locator('.play-btn').click();
    await convergence(f.pages, current => !current.playing);
    const denied = await students[0].request.put(new URL(path, f.url).href, { data: { action: 'end', expectedRevision: (await state(students[0])).revision } });
    expect(denied.status()).toBe(403);
    await students[0].getByRole('button', { name: 'Leave shared session', exact: true }).click();
    await expect(students[0].locator('.seek')).toBeEnabled();
    const independent = (await state(students[0])).time;
    await host.locator('.loop-clear').click();
    await host.locator('.seek').fill('500'); await host.locator('.seek').dispatchEvent('change');
    await convergence(students.slice(1), current => Math.abs(current.time - 35) < .4 && current.loop === null);
    expect(Math.abs((await state(students[0])).time - independent)).toBeLessThan(.1);
    await host.getByRole('button', { name: 'End shared session', exact: true }).click();
    await convergence(students.slice(1), current => !current.following);
    expect(f.writes.filter(write => write.actor !== 0)).toEqual([]); // request.put is intentionally outside browser UI
    expect(f.errors).toEqual([]);
    await mkdir('/tmp/stem-classroom-screenshots', { recursive: true });
    await host.screenshot({ path: '/tmp/stem-classroom-screenshots/live-class-host.png', fullPage: false });
  } finally { await f.close(); }
});

test('a failed class authority read pauses and conceals the course split', async ({ browser }) => {
  const f = await setup(browser), [host, student] = f.pages;
  try {
    await host.getByRole('button', { name: 'Start shared session', exact: true }).click();
    await student.getByRole('button', { name: 'Follow instructor', exact: true }).click();
    await f.contexts[1].setExtraHTTPHeaders({ 'x-fixture-identity': f.identities[1], 'x-fixture-course-state': 'revoked' });
    await expect(student.locator('.class-live-status')).toContainText('no longer available', { timeout: 10000 });
    expect((await state(student)).playing).toBe(false);
    expect((await state(student)).following).toBe(false);
    await expect(student.locator('.channels')).toBeHidden();
    await expect(student.locator('.notes')).toBeHidden();
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('autoplay rejection offers an explicit audio join and temporary outage requires a fresh opt-in', async ({ browser }) => {
  const f = await setup(browser), [host, student] = f.pages;
  try {
    await host.getByRole('button', { name: 'Start shared session', exact: true }).click();
    await host.locator('.play-btn').click();
    await student.evaluate(() => {
      const original = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () { return window.fixtureAllowAudio ? original.call(this) : Promise.reject(new DOMException('Fixture autoplay policy', 'NotAllowedError')); };
    });
    await student.getByRole('button', { name: 'Follow instructor', exact: true }).click();
    await expect(student.getByRole('button', { name: 'Join shared audio', exact: true })).toBeVisible();
    await student.evaluate(() => { window.fixtureAllowAudio = true; });
    await student.getByRole('button', { name: 'Join shared audio', exact: true }).click();
    await expect.poll(async () => (await state(student)).playing).toBe(true);
    await student.route(`**${path}`, route => route.fulfill({ status: 503, json: { error: 'fixture outage' } }));
    await expect(student.locator('.class-live-status')).toContainText('connection was lost', { timeout: 10000 });
    expect((await state(student)).playing).toBe(false);
    await student.unroute(`**${path}`);
    await student.getByRole('button', { name: 'Retry session connection', exact: true }).click();
    await expect(student.getByRole('button', { name: 'Follow instructor', exact: true })).toBeVisible();
    expect((await state(student)).following).toBe(false);
    expect((await state(student)).playing).toBe(false);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('page visibility lifecycle pauses leadership once and stops hidden polling', async ({ browser }) => {
  const f = await setup(browser), [host, student] = f.pages;
  try {
    await host.getByRole('button', { name: 'Start shared session', exact: true }).click();
    await host.locator('.play-btn').click();
    await student.getByRole('button', { name: 'Follow instructor', exact: true }).click();
    await expect.poll(async () => (await state(student)).playing).toBe(true);
    await host.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const hostReads = f.reads.filter(read => read.actor === 0).length;
    const studentReads = f.reads.filter(read => read.actor === 1).length;
    await expect.poll(() => f.reads.filter(read => read.actor === 1).length, { timeout: 10000 }).toBeGreaterThanOrEqual(studentReads + 2);
    expect(f.reads.filter(read => read.actor === 0).length).toBe(hostReads);
    expect((await state(student)).playing).toBe(false);
    expect((await state(host)).leading).toBe(false);
    await host.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await expect(host.getByRole('button', { name: 'Resume shared session', exact: true })).toBeVisible();
    expect((await state(host)).leading).toBe(false);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
