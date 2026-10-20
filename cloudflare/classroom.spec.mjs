import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';
const course='msh-245-the-american-musical-experience-fall-2026-01';
const member=subject=>'stem-member-v1-'+createHash('sha256').update(`fixture:${course}:${subject}`).digest('hex');
function tone(){const rate=8000,n=rate*35,buffer=Buffer.alloc(44+n*2);buffer.write('RIFF');buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(rate,24);buffer.writeUInt32LE(rate*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(n*2,40);for(let i=0;i<n;i++)buffer.writeInt16LE(Math.round(1200*Math.sin(i*2*Math.PI*220/rate)),44+i*2);return buffer;}
async function fulfillTone(route){
 const bytes=tone(),range=/^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range||'');
 const start=range?Number(range[1]):0,end=range?.[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1;
 await route.fulfill({status:range?206:200,contentType:'audio/wav',headers:{'Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}:{})},body:bytes.subarray(start,end+1)});
}
async function setup(page){
 const issuer=await createTestIdentityIssuer();const alice=await issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject:TEST_SUBJECTS.alice});const bob=await issuer.mintIdentityJwt({audience:'cail:stem-splitter',subject:TEST_SUBJECTS.bob});const gateway=await issuer.mintIdentityJwt({audience:'cail:gateway',subject:TEST_SUBJECTS.alice});
 const server=createTestHarness({workers:[{configPath:fileURLToPath(new URL('./test-wrangler.jsonc',import.meta.url)),vars:{TEST_JWKS:issuer.jwksJson,TEST_BROWSER:'true',TEST_ROSTER_SUBJECT:TEST_SUBJECTS.alice}}]});const {url}=await server.listen();
 const seed=async(sql)=>{const result=await server.fetch('/__fixture/schema',{method:'POST',headers:{'x-fixture':'local-only'},body:JSON.stringify(sql)});expect(result.status).toBe(200);};
 const sql=schemaStatements(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
 sql.push(`INSERT INTO app_users(subject) VALUES('${TEST_SUBJECTS.alice}'),('${TEST_SUBJECTS.bob}')`,
  `INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES('course-song','A long course recording title for responsive review','uploads/source.wav','done','htdemucs_ft','[{"name":"vocals","key":"stems/course-song/vocals.mp3"}]')`,
  `INSERT INTO job_owners VALUES('course-song','${TEST_SUBJECTS.alice}')`,
  `INSERT INTO job_courses(job_id,course_id,member_id,assigned_by,policy_version) VALUES('course-song','${course}','${member(TEST_SUBJECTS.alice)}','${TEST_SUBJECTS.alice}','course-work-v1')`,
  `INSERT INTO course_folders(id,course_id,name,created_by,permission) VALUES('course-folder','${course}','Listening together','${TEST_SUBJECTS.alice}','comment')`,
  `INSERT INTO course_folder_items(folder_id,job_id,filename,model) VALUES('course-folder','course-song','Course recording','htdemucs_ft')`,
  `INSERT INTO annotations(id,job_id,at_seconds,text,author_subject,author_name,provenance) VALUES('first-note','course-song',3,'First student note','${TEST_SUBJECTS.alice}','Alex Rivera','student')`);
 await seed(sql);
 await page.route('**/api/files/stems/course-song/*',fulfillTone);
 return {server,url,alice,bob,gateway,seed};
}
const get = async (page, path) => { const response = await page.request.get(new URL(path, page.url()).href); return { status: response.status(), body: await response.json() }; };
test('existing pages expose class workspace and feedback while course APIs retain owner authorization', async ({ page, context }) => {
  const f = await setup(page), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/classroom/')) requests.push({url:request.url(),method:request.method()}); });
  try {
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': f.alice, 'x-fixture-course-role': 'owner' });
    for (const path of ['/', '/account.html', '/teacher.html']) {
      await page.goto(new URL(path, f.url).href);
      await expect(page.locator('main')).toBeVisible();
      await expect(page.locator('a[href="/classroom.html"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Report a bug', exact: true })).toBeVisible();
    }
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    const roster = await get(page, `/api/classroom/courses/${course}/roster`);
    expect(roster.status).toBe(200);
    expect(roster.body.participants.some(person => person.splitCount === 0)).toBe(true);
    expect(roster.body.participants.some(person => person.splitCount === 1)).toBe(true);
    const folder = await get(page, `/api/classroom/courses/${course}/folders/course-folder`);
    expect(folder.status).toBe(200); expect(folder.body.items[0].jobId).toBe('course-song');
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': f.bob });
    expect((await get(page, `/api/classroom/courses/${course}/roster`)).status).toBe(403);
    expect((await get(page, `/api/classroom/courses/${course}/folders/course-folder`)).status).toBe(200);
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': f.bob, 'x-fixture-course-state': 'revoked' });
    expect((await get(page, `/api/classroom/courses/${course}/folders/course-folder`)).status).toBe(403);
    expect(errors).toEqual([]);
  } finally { await f.server.close(); }
});
test('existing mixer opens shared course work using its original controls and enforces revocation on reload', async ({ page, context }) => {
  const f = await setup(page), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': f.bob });
    await page.goto(new URL('/?job=course-song', f.url).href);
    await expect(page.locator('.console')).toBeVisible();
    await expect(page.locator('.note-text')).toContainText('First student note');
    await expect(page.locator('.seek')).toHaveCount(1);
    await expect(page.locator('.refresh-btn')).toBeVisible();
    await expect(page.locator('.waveform-seek')).toHaveCount(0);
    await page.locator('.play-btn').click();
    await expect.poll(() => page.evaluate(() => mixers.get('course-song').audios[0].currentTime)).toBeGreaterThan(.1);
    await page.locator('.play-btn').click();
    for (const width of [390, 768, 1280]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': f.bob, 'x-fixture-course-state': 'revoked' });
    await page.reload();
    await expect(page.locator('.console')).toHaveCount(0);
    expect((await get(page, '/api/jobs/course-song')).status).toBe(403);
    expect(errors).toEqual([]);
  } finally { await f.server.close(); }
});
test('an interrupted accepted course reply can be reset using its current server revision', async ({ page, context }) => {
  const f = await setup(page);
  try {
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': f.alice, 'x-fixture-gateway-identity': f.gateway });
    await page.route('**/api/jobs/course-song/chat', async route => {
      // The real local Worker accepts and completes the turn, but this browser
      // loses the final acknowledgement and still holds the earlier revision.
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"delta","text":"An interrupted reply"}\n\n' });
    });
    await page.goto(new URL('/?job=course-song', f.url).href);
    await page.locator('.coach-toggle').click();
    const input = page.getByRole('textbox', { name: 'Ask the Listening Guide' });
    await input.fill('Reset after this interrupted course reply.');
    await page.getByRole('button', { name: 'ASK', exact: true }).click();
    await expect(page.getByRole('button', { name: 'RETRY REPLY' })).toBeEnabled();
    const accepted = await get(page, '/api/jobs/course-song/listening-conversation');
    expect(accepted.body.entries).toHaveLength(2);
    const reset = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().includes('/listening-conversation'));
    await page.locator('.coach-reset').click();
    await page.locator('.coach-reset').click();
    const response = await reset;
    expect(response.request().postDataJSON().revision).toBe(accepted.body.revision);
    expect(response.status()).toBe(200);
    await expect(page.getByRole('button', { name: 'ASK', exact: true })).toBeEnabled();
    await expect(input).not.toHaveAttribute('readonly');
    await expect(page.locator('.coach-row')).toHaveCount(0);
    expect((await get(page, '/api/jobs/course-song/listening-conversation')).body.entries).toEqual([]);
  } finally { await f.server.close(); }
});

test('original Listening Guy archive loads every durable course page and keeps peer conversations private', async ({ page, context }) => {
  const f = await setup(page), errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/listening-conversation')) writes.push(request.url()); });
  try {
    await f.seed([`INSERT INTO course_conversations(job_id,subject,revision,expires_at) VALUES('course-song','${TEST_SUBJECTS.alice}',1,datetime('now','+1 day'))`,
      ...Array.from({ length: 70 }, (_, i) => `INSERT INTO course_messages(id,job_id,subject,turn_id,kind,provenance,text) VALUES('page-${i}','course-song','${TEST_SUBJECTS.alice}','turn-${i}','${i % 2 ? 'coach' : 'you'}','${i % 2 ? 'server-assistant' : 'student'}','Saved message ${i}')`)]);
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': f.alice, 'x-fixture-gateway-identity': f.gateway });
    await page.goto(new URL('/?job=course-song', f.url).href);
    await page.locator('.coach-toggle').click();
    await expect.poll(() => page.evaluate(() => mixers.get('course-song').conversationEntries.length)).toBe(70);
    await expect(page.locator('.coach-archive-toggle')).toBeVisible();
    await page.locator('.coach-archive-toggle').click();
    await expect(page.locator('.coach-archive-log')).toContainText('Saved message 0');
    await expect(page.locator('.coach-archive-log')).toContainText('Saved message 69');
    await expect(page.getByRole('button', { name: 'More messages', exact: true })).toHaveCount(0);
    expect(writes).toEqual([]);
    const sent = page.waitForRequest(request => new URL(request.url()).pathname === '/api/jobs/course-song/chat');
    await page.getByRole('textbox', { name: 'Ask the Listening Guide' }).fill('How does the bass relate to the drums?');
    await page.getByRole('button', { name: 'ASK', exact: true }).click();
    const chat = await sent;
    expect(chat.postDataJSON().revision).toBe(1);
    expect(chat.postDataJSON().messageId).toBeTruthy();
    expect(chat.headers()['idempotency-key']).toBe(chat.postDataJSON().messageId);
    await expect(page.locator('.coach-log')).toContainText('Listen for the bass against the drums.');
    await expect.poll(() => page.evaluate(() => mixers.get('course-song').conversationEntries.length)).toBe(72);
    expect(writes).toEqual([]);
    await page.reload(); await page.locator('.coach-toggle').click();
    await expect.poll(() => page.evaluate(() => mixers.get('course-song').conversationEntries.length)).toBe(72);
    const reset = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().includes('/listening-conversation'));
    await page.locator('.coach-reset').click();
    await expect(page.locator('.coach-reset')).toHaveText('SURE?');
    await page.locator('.coach-reset').click(); expect((await reset).status()).toBe(200);
    await expect(page.locator('.coach-archive')).toBeHidden();
    expect((await get(page, '/api/jobs/course-song/listening-conversation')).body.entries).toEqual([]);
    await context.setExtraHTTPHeaders({ 'x-fixture-identity': f.bob });
    const peer = await get(page, '/api/jobs/course-song/listening-conversation');
    expect(peer.status).toBe(404); expect(JSON.stringify(peer.body)).not.toContain('Saved message');
    expect(errors).toEqual([]);
  } finally { await f.server.close(); }
});
