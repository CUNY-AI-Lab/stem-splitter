import { test, expect } from '@playwright/test';
import { createTestHarness } from 'wrangler';
import { createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaStatements } from '../tests/e2e/schema-statements.mjs';

async function fixture(browser) {
  const issuer = await createTestIdentityIssuer();
  const server = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./test-wrangler.jsonc', import.meta.url)), vars: { TEST_JWKS: issuer.jwksJson, TEST_BROWSER: 'true' } }] });
  const { url } = await server.listen();
  const seed = [...schemaStatements(await readFile(new URL('../schema.sql', import.meta.url), 'utf8')),
    `INSERT INTO app_users(subject) VALUES('${TEST_SUBJECTS.alice}')`,
    `INSERT INTO jobs(id,filename,source_key,status,model,stems) VALUES('listening-fixture','Listening fixture','uploads/source.wav','done','htdemucs_ft','[{"name":"vocals","key":"stems/listening-fixture/vocals.mp3"}]')`,
    `INSERT INTO job_owners VALUES('listening-fixture','${TEST_SUBJECTS.alice}')`];
  expect((await server.fetch('/__fixture/schema', { method: 'POST', headers: { 'x-fixture': 'local-only' }, body: JSON.stringify(seed) })).status).toBe(200);
  const context = await browser.newContext({ extraHTTPHeaders: {
    'x-fixture-identity': await issuer.mintIdentityJwt({ audience: 'cail:stem-splitter', subject: TEST_SUBJECTS.alice }),
    'x-fixture-gateway-identity': await issuer.mintIdentityJwt({ audience: 'cail:gateway', subject: TEST_SUBJECTS.alice }),
  } });
  const page = await context.newPage();
  await page.route('**/api/files/stems/listening-fixture/*', route => route.fulfill({ contentType: 'audio/mpeg', body: Buffer.alloc(0) }));
  let currentUsage = usage(50);
  await page.route('**/api/listening-usage', route => route.fulfill({ json: currentUsage }));
  return { page, setUsage: value => { currentUsage = value; }, open: async () => {
    await page.goto(new URL('/?job=listening-fixture', url).href);
    await expect(page.locator('.console')).toBeVisible();
    await page.locator('.coach-toggle').click();
    await expect(page.locator('.coach-usage')).toContainText('50 of 50');
  }, close: async () => { await context.close(); await server.close(); } };
}
function usage(remainingTurns, seconds = 0) {
  const now = Date.now();
  return { ok: true, limit: 50, remainingTurns, inProgress: 0, serverTime: new Date(now).toISOString(), cooldownUntil: seconds ? new Date(now + seconds * 1000).toISOString() : null };
}
const reply = (text, state) => `data: ${JSON.stringify({ type: 'done', text, model: 'fixture', usage: state })}\n\n`;

test('authenticated accounts continue after five replies and preserve the next draft without a five-minute pause', async ({ browser }) => {
 const f=await fixture(browser);
 try {
  await f.page.clock.install();let calls=0;
  await f.page.route('**/api/jobs/listening-fixture/chat',async route=>{
   const state=usage(50-++calls);f.setUsage(state);
   await route.fulfill({contentType:'text/event-stream',body:reply(`Reply ${calls}.`,state)});
  });
  await f.open();const input=f.page.getByRole('textbox',{name:'Ask the Listening Guide'}),ask=f.page.getByRole('button',{name:'ASK',exact:true});
  for(let turn=1;turn<=5;turn++) {await input.fill(`Question ${turn}`);await ask.click();await expect(f.page.locator('.coach-row.coach').last()).toContainText(`Reply ${turn}.`);}
  await expect(ask).toBeEnabled();await expect(f.page.locator('.coach-usage-status')).toHaveText('45 of 50 chat turns left today.');
  await input.fill('My next question stays here.');await f.page.clock.fastForward(300100);
  await expect(input).toHaveValue('My next question stays here.');expect(calls).toBe(5);
  await ask.click();await expect.poll(()=>calls).toBe(6);await expect(ask).toBeEnabled();
 }finally{await f.close();}
});

test('an interrupted reply keeps one question and retries its exact request without a second local turn', async ({ browser }) => {
  const f = await fixture(browser);
  try {
    const requests = [];
    await f.page.route('**/api/jobs/listening-fixture/chat', route => {
      requests.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
      return route.fulfill({ contentType: 'text/event-stream', body: requests.length === 1
        ? 'data: {"type":"delta","text":"An incomplete reply"}\n\n' : reply('The recovered reply.', usage(49)) });
    });
    await f.open();
    const input = f.page.getByRole('textbox', { name: 'Ask the Listening Guide' });
    await input.fill('Where does the bass enter?');
    await f.page.getByRole('button', { name: 'ASK', exact: true }).click();
    await expect(f.page.getByRole('button', { name: 'RETRY REPLY' })).toBeEnabled();
    await expect(input).toHaveValue('Where does the bass enter?');
    await expect(input).toHaveAttribute('readonly', '');
    await f.page.getByRole('button', { name: 'RETRY REPLY' }).click();
    await expect(f.page.locator('.coach-row.coach')).toHaveText('The recovered reply.');
    expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
    await expect(f.page.locator('.coach-row.you')).toHaveCount(1);
    await expect(input).toHaveValue(''); await expect(input).not.toHaveAttribute('readonly');
  } finally { await f.close(); }
});

test('confirmed failure permits a fresh attempt while a sign-in failure retains the pending question', async ({ browser }) => {
  const f = await fixture(browser);
  try {
    const keys = [];
    await f.page.route('**/api/jobs/listening-fixture/chat', route => {
      keys.push(route.request().headers()['idempotency-key']);
      return route.fulfill(keys.length === 1
        ? { status: 503, json: { error: 'This attempt did not finish. You can retry.', code: 'listening_attempt_failed', newAttemptAllowed: true, usage: usage(50) } }
        : { status: 401, json: { error: 'Sign in with CUNY Login to continue.' } });
    });
    await f.open();
    const input = f.page.getByRole('textbox', { name: 'Ask the Listening Guide' });
    await input.fill('Keep my question after a failed attempt.');
    await f.page.getByRole('button', { name: 'ASK', exact: true }).click();
    await expect(input).toBeEnabled(); await expect(input).not.toHaveAttribute('readonly');
    await expect(input).toHaveValue('Keep my question after a failed attempt.');
    await f.page.getByRole('button', { name: 'ASK', exact: true }).click();
    await expect(f.page.locator('.coach-row.error').last()).toContainText('Sign in with CUNY Login');
    expect(keys).toHaveLength(2); expect(keys[1]).not.toBe(keys[0]);
    await expect(input).toHaveValue('Keep my question after a failed attempt.');
  } finally { await f.close(); }
});

test('a lost fifth-reply acknowledgement remains readable during cooldown with the same request ID', async ({ browser }) => {
  const f = await fixture(browser);
  try {
    const keys = [], state = usage(0, 300);
    await f.page.route('**/api/jobs/listening-fixture/chat', route => {
      keys.push(route.request().headers()['idempotency-key']);
      f.setUsage(state);
      return route.fulfill({ contentType: 'text/event-stream', body: keys.length === 1
        ? 'data: {"type":"delta","text":"A saved fifth reply"}\n\n'
        : reply('A saved fifth reply.', state) });
    });
    await f.open();
    await f.page.getByRole('textbox', { name: 'Ask the Listening Guide' }).fill('Recover the fifth reply.');
    await f.page.getByRole('button', { name: 'ASK', exact: true }).click();
    await expect(f.page.locator('.coach-usage-status')).toContainText('Five turns used');
    await expect(f.page.getByRole('button', { name: 'RETRY REPLY' })).toBeEnabled();
    await f.page.getByRole('button', { name: 'RETRY REPLY' }).click();
    await expect(f.page.locator('.coach-row.coach')).toHaveText('A saved fifth reply.');
    expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
    await expect(f.page.getByRole('button', { name: 'ASK', exact: true })).toBeDisabled();
  } finally { await f.close(); }
});

test('cue retry keeps its original key and uses the same cooldown display as chat', async ({ browser }) => {
  const f = await fixture(browser);
  try {
    const keys = [];
    await f.page.route('**/api/jobs/listening-fixture/guide', route => {
      keys.push(route.request().headers()['idempotency-key']);
      const state = usage(0, 300); if (keys.length > 1) f.setUsage(state);
      return route.fulfill(keys.length === 1 ? { status: 503, json: { error: 'Temporary cue outage.' } }
        : { contentType: 'text/event-stream', body: reply('Listen to this entrance.', state) });
    });
    await f.open();
    await f.page.locator('.coach-cue-btn').click();
    await expect(f.page.locator('.coach-hint')).toContainText('Temporary cue outage');
    await f.page.locator('.coach-cue-btn').click();
    await expect(f.page.locator('.coach-guide-text')).toContainText('Listen to this entrance.');
    expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
    await expect(f.page.getByRole('button', { name: 'ASK', exact: true })).toBeDisabled();
    await expect(f.page.locator('.coach-usage-status')).toContainText('Five turns used');
  } finally { await f.close(); }
});
