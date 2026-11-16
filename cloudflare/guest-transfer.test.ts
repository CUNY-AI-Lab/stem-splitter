import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { SqliteD1 } from '../server/d1.ts';
import { guestTransfer, TRANSFER_COOKIE } from './guest-transfer.ts';
import { GUEST_COOKIE, readGuestSession, startGuestSession } from './guest.ts';
import worker, { type WorkerEnv } from './worker.ts';
import { claimGuestWork } from '../src/guest/claim.ts';

const legacy = 'https://stem-splitter.ailab-452.workers.dev';
const tools = 'https://tools.ailab.gc.cuny.edu';

test('stale transfer pages return home without account checks or restarting transfer', async () => {
  const script = readFileSync(new URL('../public/guest-transfer.js', import.meta.url), 'utf8');
  for (const hash of ['', '#transfer-failed']) for (const saved of [undefined, '/stem-splitter/?job=saved', 'https://attacker.test/']) {
    const stored = new Map<string,string>([['stem-transfer-member','cail-'+'a'.repeat(32)]]);
    if(saved)stored.set('stem-transfer-return',saved);
    const redirects:string[]=[];
    let calls=0;
    await runInNewContext(script,{
      sessionStorage:{getItem:(key:string)=>stored.get(key),setItem:(key:string,value:string)=>stored.set(key,value),removeItem:(key:string)=>stored.delete(key)},
      location:{hash,pathname:'/stem-splitter/guest-transfer.html',replace:(value:string)=>redirects.push(value)},
      history:{replaceState(){}},
      window:{StemFetch:async()=>{calls++;throw new Error('stale entry must not fetch');}},
    });
    assert.equal(calls,0);
    assert.deepEqual(redirects,[saved?.startsWith('/stem-splitter/?')?saved:'/stem-splitter/']);
    assert.equal(stored.has('stem-transfer-member'),false);
  }
});

test('account-only source starts ordinary guest access without a recovery prompt', async () => {
  const script = readFileSync(new URL('../public/guest-transfer.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/guest-transfer.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /Continue as guest|Sign in with CUNY/);
  for (const startOk of [true, false]) {
    let redirect = '';
    const calls: string[] = [];
    const stored = new Map<string, string>();
    await runInNewContext(script, {
      document: {}, AbortSignal,
      sessionStorage: { getItem: (key: string) => stored.get(key), setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
      location: { hash: '#fixture-handoff', pathname: '/stem-splitter/guest-transfer', replace: (value: string) => { redirect = value; } },
      history: { replaceState() {} },
      window: { StemFetch: async (path: string) => {
        calls.push(path);
        return path.endsWith('/finish')
          ? { ok: false, status: 409, json: async () => ({ error: { code: 'member_workspace' } }) }
          : { ok: startOk };
      } },
    });
    assert.deepEqual(calls, ['/auth/guest-transfer/finish', '/auth/guest']);
    assert.equal(redirect, '/stem-splitter/');
    assert.equal(stored.get('stem-transfer-checked'), '1');
  }
  assert.doesNotMatch(html, /<h1|<p|button|transfer-status|transfer-retry|transfer-accounts/i);
});

test('signed-in existing-only completion preserves the member session without starting a guest session', async () => {
  const script = readFileSync(new URL('../public/guest-transfer.js', import.meta.url), 'utf8');
  const stored = new Map<string, string>();
  let redirect = '';
  const calls: string[] = [];
  await runInNewContext(script, {
    document: {}, AbortSignal,
    sessionStorage: { getItem: (key: string) => stored.get(key), setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
    location: { hash: '#fixture-handoff', pathname: '/stem-splitter/guest-transfer.html', replace: (value: string) => { redirect = value; } },
    history: { replaceState() {} },
    window: { StemFetch: async (path: string) => { calls.push(path); return { ok: true, json: async () => ({ restored: false }) }; } },
  });
  assert.deepEqual(calls, ['/auth/guest-transfer/finish']);
  assert.equal(redirect, '/stem-splitter/');
  assert.equal(stored.get('stem-transfer-checked'), '1');
});

test('a distinct guest workspace conflict preserves both cookies and returns to the current workspace quietly', async () => {
  const script = readFileSync(new URL('../public/guest-transfer.js', import.meta.url), 'utf8');
  const stored = new Map<string, string>([['stem-transfer-return', '/stem-splitter/?job=current-track']]);
  let redirect = '';
  await runInNewContext(script, {
    document: {}, AbortSignal,
    sessionStorage: { getItem: (key: string) => stored.get(key), setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
    location: { hash: '#fixture-handoff', pathname: '/stem-splitter/guest-transfer.html', replace: (value: string) => { redirect = value; } },
    history: { replaceState() {} },
    window: { StemFetch: async () => ({ ok: false, status: 409, json: async () => ({ error: { code: 'workspace_conflict' } }) }) },
  });
  assert.equal(redirect, '/stem-splitter/?job=current-track');
  assert.equal(stored.get('stem-transfer-checked'), '1');
  assert.equal(stored.has('stem-transfer-return'), false);
});

test('transient handoff failures return to normal guest startup with a one-shot loop fence', async () => {
  const script = readFileSync(new URL('../public/guest-transfer.js', import.meta.url), 'utf8');
  const stored = new Map<string, string>();
  let redirect = '';
  await runInNewContext(script, {
    document: {}, AbortSignal,
    sessionStorage: { getItem: (key: string) => stored.get(key), setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
    location: { hash: '#fixture-handoff', pathname: '/stem-splitter/guest-transfer.html', replace: (value: string) => { redirect = value; } },
    history: { replaceState() {} },
    window: { StemFetch: async () => ({ ok: false, status: 503, json: async () => ({}) }) },
  });
  assert.equal(redirect, '/stem-splitter/');
  assert.equal(stored.get('stem-transfer-checked'), '1');
});

test('stalled finish request times out and returns to ordinary app startup', async () => {
  const script = readFileSync(new URL('../public/guest-transfer.js', import.meta.url), 'utf8');
  const stored = new Map<string, string>();
  const signal = { timedOut: true };
  const timeouts: number[] = [];
  let redirect = '';
  await runInNewContext(script, {
    document: {},
    AbortSignal: { timeout: (milliseconds: number) => { timeouts.push(milliseconds); return signal; } },
    sessionStorage: { getItem: (key: string) => stored.get(key), setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
    location: { hash: '#fixture-handoff', pathname: '/stem-splitter/guest-transfer.html', replace: (value: string) => { redirect = value; } },
    history: { replaceState() {} },
    window: { StemFetch: async (path: string, options: { signal?: unknown }) => {
      assert.equal(path, '/auth/guest-transfer/finish');
      assert.equal(options.signal, signal);
      throw new Error('AbortError');
    } },
  });
  assert.deepEqual(timeouts, [8000]);
  assert.equal(redirect, '/stem-splitter/');
  assert.equal(stored.get('stem-transfer-checked'), '1');
});

test('application entry keeps ordinary guest startup without a transfer launcher', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source,/restorePreviousGuest|auth\/guest-transfer\/start/);
  assert.match(source,/await window\.StemGuest\.ensure\(runtime\.guest\)/);
});

function fixture() {
  const database = new SqliteD1(':memory:');
  database.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const env = {
    DB: database, PUBLIC_BASE_URL: legacy, GUEST_ENABLED: 'true',
    GUEST_COOKIE_SECRET: 'fixture-transfer-secret-'.repeat(3),
    GUEST_TURNSTILE_SITE_KEY: 'fixture-site-key', GUEST_TURNSTILE_SECRET: 'fixture-turnstile-secret-only',
    REQUEST_LIMIT: { limit: async () => ({ success: true }) },
  } as unknown as WorkerEnv;
  const cookie = (response: Response, name = GUEST_COOKIE) => response.headers.getSetCookie().find(value => value.startsWith(name + '='))?.split(';')[0] ?? '';
  const begin = async () => cookie(await startGuestSession(new Request(legacy + '/auth/guest', {
    method: 'POST', headers: { origin: legacy, 'content-type': 'application/json' }, body: '{}',
  }), env));
  // Authentic tokens issued before retirement exercise the unchanged finish boundary.
  const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
  const start = async (existingOnly = false) => {
    const nonce=encode(crypto.getRandomValues(new Uint8Array(32)));
    return { nonce, cookie: `${TRANSFER_COOKIE}=${nonce}`, existingOnly };
  };
  const handoff = async (source = '', existingOnly = false, nonce?: string) => {
    const initiated = await start(existingOnly);
    if(nonce){initiated.nonce=nonce;initiated.cookie=`${TRANSFER_COOKIE}=${nonce}`;}
    if(!source&&!existingOnly)source=await begin();
    const session=await readGuestSession(new Request(legacy,{headers:{cookie:source}}),env);
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('stem-guest-transfer-v1\n'+env.GUEST_COOKIE_SECRET));
    const key=await crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt']);
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const payload=JSON.stringify({nonce:initiated.nonce,expires:Date.now()+300000,subject:session?.subject??null,existingOnly});
    const sealed=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(tools)},key,new TextEncoder().encode(payload)));
    return {...initiated,token:`${encode(iv)}.${encode(sealed)}`,sourceCookie:source};
  };
  const finish = (token: string, cookies: string, origin = tools) => guestTransfer(new Request(tools + '/auth/guest-transfer/finish', {
    method: 'POST', headers: { origin, cookie: cookies, 'content-type': 'application/json' }, body: JSON.stringify({ token }),
  }), env);
  return { database, env, cookie, begin, start, handoff, finish };
}

test('retired transfer entry links return to the same host without cookies, configuration or storage', async () => {
  for(const enabled of ['true','false']) {
    const f=fixture();
    Object.assign(f.env,{GUEST_ENABLED:enabled,REQUEST_LIMIT:{limit:async()=>{throw new Error('must not rate-limit retired entry');}},DB:new Proxy({}, {get(){throw new Error('must not touch guest storage');}})});
    for(const [url,destination] of [
      [tools+'/auth/guest-transfer/start',tools+'/stem-splitter/'],
      [tools+'/auth/guest-transfer/start?existingOnly=1',tools+'/stem-splitter/'],
      [legacy+'/auth/guest-transfer?state=invalid',legacy+'/'],
      [legacy+'/auth/guest-transfer/continue?state='+ 'A'.repeat(43),legacy+'/'],
    ]) {
      const response=await guestTransfer(new Request(url,{headers:{cookie:'__Host-stem-guest=unchanged; __Host-stem-session=member'}}),f.env);
      assert.equal(response.status,303);assert.equal(response.headers.get('location'),destination);
      assert.equal(response.headers.get('cache-control'),'private, no-store');
      assert.equal(response.headers.get('set-cookie'),null);
    }
    if(enabled==='false')assert.equal((await f.finish('bad','')).status,503);
  }
});

test('existing guest transfer keeps the same owner, expiry, verification and stored work', async () => {
  const f = fixture(), original = await f.begin();
  const before = await readGuestSession(new Request(legacy, { headers: { cookie: original } }), f.env);
  assert.ok(before);
  await f.database.prepare("INSERT INTO jobs(id,filename,source_key,status,model) VALUES('saved-track','Original','uploads/source.wav','done','htdemucs_ft')").run();
  await f.database.prepare("INSERT INTO guest_job_owners(job_id,subject) VALUES('saved-track',?)").bind(before.subject).run();
  const transfer = await f.handoff(original);
  const response = await f.finish(transfer.token, transfer.cookie);
  assert.equal(response.status, 200);
  const target = f.cookie(response);
  assert.match(target, /^__Host-stem-guest=/);
  const after = await readGuestSession(new Request(tools, { headers: { cookie: target } }), f.env);
  assert.deepEqual(after, before, 'handoff never extends expiry or resets limits');
  assert.equal(await readGuestSession(new Request(legacy, { headers: { cookie: target } }), f.env), null, 'cookie remains origin-bound');
  assert.equal((await f.database.prepare('SELECT subject FROM guest_job_owners').first())?.subject, before.subject);
  assert.match(response.headers.getSetCookie().find(value => value.startsWith(TRANSFER_COOKIE + '='))!, /Max-Age=0/);
  assert.equal((await f.finish(transfer.token, transfer.cookie)).status, 403, 'single-use handoff');
});

test('an in-flight handoff preserves a previously created guest at both addresses', async () => {
  const f = fixture(), transfer = await f.handoff();
  assert.ok(transfer.sourceCookie);
  const response = await f.finish(transfer.token, transfer.cookie);
  assert.equal(response.status, 200);
  const source = await readGuestSession(new Request(legacy, { headers: { cookie: transfer.sourceCookie } }), f.env);
  const target = await readGuestSession(new Request(tools, { headers: { cookie: f.cookie(response) } }), f.env);
  assert.deepEqual(source, target);
  assert.equal((await f.database.prepare('SELECT count(*) AS n FROM guest_sessions').first())?.n, 1);
});

test('source context distinguishes a proven guest from a coexisting member and retains claimed-cookie proof until continuation', async () => {
  const f = fixture(), original = await f.begin();
  const guest = await readGuestSession(new Request(legacy, { headers: { cookie: original } }), f.env);
  assert.ok(guest);
  const context = (cookie: string, extra: Record<string, string> = {}, origin = legacy) => guestTransfer(new Request(origin + '/auth/guest-transfer/context', { headers: { cookie, ...extra } }), f.env);
  for (const cookie of [original, original + '; __Host-stem-session=member-fixture']) {
    const result = await context(cookie);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('X-Stem-Account'), guest.subject);
    assert.deepEqual(await result.json(), { guest: { subject: guest.subject, expiresAt: guest.expiresAt } });
  }
  await f.database.prepare('INSERT INTO app_users(subject) VALUES(?)').bind('cail-' + 'a'.repeat(32)).run();
  await f.database.prepare('INSERT INTO guest_account_claims(guest_subject,member_subject) VALUES(?,?)').bind(guest.subject, 'cail-' + 'a'.repeat(32)).run();
  const source = await guestTransfer(new Request(legacy + '/auth/guest-transfer', { headers: { cookie: original } }), f.env);
  assert.equal(source.status, 303);
  assert.equal(source.headers.get('set-cookie'), null, 'retired entry preserves proof for in-flight source writes');
  assert.deepEqual(await (await context(original)).json(), { guest: { subject: guest.subject, expiresAt: guest.expiresAt } });
  assert.deepEqual(await (await context('__Host-stem-session=member-fixture')).json(), { guest: null });
  for (const extra of [{ 'x-cail-identity-jwt': 'partial' }, { 'x-cail-gateway-identity-jwt': 'partial' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await context(original, extra)).status, 403);
  }
  assert.equal((await context(original, {}, tools)).status, 403);
  assert.deepEqual(await (await context(original + 'x')).json(), { guest: null });
  assert.deepEqual(await (await context(original + '; ' + original)).json(), { guest: null });
  await f.database.prepare('UPDATE guest_sessions SET revoked_at=? WHERE subject=?').bind(Date.now(), guest.subject).run();
  assert.deepEqual(await (await context(original)).json(), { guest: null });
});

test('source seeding rejects foreign origins, changed actors, ambiguous proof and malformed bounds before writes', async () => {
  const f = fixture(), cookie = await f.begin();
  const session = await readGuestSession(new Request(legacy, { headers: { cookie } }), f.env);
  assert.ok(session);
  const call = (body: unknown, extra: Record<string, string> = {}, origin = legacy) => guestTransfer(new Request(origin + '/auth/guest-transfer/seed', {
    method: 'POST', headers: { origin: legacy, cookie, 'Content-Type': 'application/json', 'X-Stem-Account': session.subject, ...extra }, body: JSON.stringify(body),
  }), f.env);
  const body = { requestId: crypto.randomUUID(), records: [{ jobId: 'missing', kind: 'listeningDraft', value: 'private fixture' }] };
  assert.equal((await call(body, { origin: 'https://attacker.test' })).status, 403);
  assert.equal((await call(body, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await call(body, { 'x-cail-identity-jwt': 'partial' })).status, 403);
  assert.equal((await call(body, { 'x-cail-gateway-identity-jwt': 'partial' })).status, 403);
  assert.equal((await call(body, {}, tools)).status, 403);
  assert.equal((await call(body, { 'X-Stem-Account': 'guest-' + '0'.repeat(64) })).status, 409);
  assert.equal((await call(body, { cookie: cookie + '; ' + cookie })).status, 401);
  assert.equal((await call(body, { cookie: cookie + 'x' })).status, 401);
  for (const malformed of [null, [], {}, { ...body, subject: session.subject }, { ...body, records: [] },
    { ...body, records: Array.from({ length: 65 }, () => body.records[0]) },
    { ...body, records: [body.records[0], body.records[0]] },
    { ...body, records: [{ ...body.records[0], kind: 'arbitraryKey' }] },
    { ...body, records: [{ ...body.records[0], member: 'forged' }] }]) {
    assert.equal((await call(malformed)).status, 400);
  }
  assert.equal((await call({ ...body, records: [{ ...body.records[0], value: 'x'.repeat(512 * 1024) }] })).status, 413);
  await f.database.prepare('UPDATE guest_sessions SET revoked_at=? WHERE subject=?').bind(Date.now(), session.subject).run();
  assert.equal((await call(body)).status, 401);
});

test('the original adapter serves the silent source scripts without entering account authorization', async () => {
  const f = fixture();
  const served: string[] = [];
  Object.assign(f.env, { AUTH_MODE: 'cail', ASSETS: { fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    served.push(path);
    return new Response(readFileSync(new URL('../public' + path, import.meta.url), 'utf8'), { headers: { 'Content-Type': 'application/javascript' } });
  } }, IDENTITY: { identities: () => assert.fail('source assets require no member session') } });
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  for (const name of ['guest-claim.js', 'workspace-continuity.js', 'preferences.js', 'guest-transfer-source.js']) {
    const response = await worker.fetch(new Request(legacy + '/' + name), f.env, ctx);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Security-Policy')!, /script-src 'self'/);
    assert.equal(await response.text(), readFileSync(new URL('../public/' + name, import.meta.url), 'utf8'));
  }
  assert.deepEqual(served, ['/guest-claim.js', '/workspace-continuity.js', '/preferences.js', '/guest-transfer-source.js']);
});

test('source preference seed and writes use only the exact live guest namespace',async()=>{
  const f=fixture(),cookie=await f.begin(),session=await readGuestSession(new Request(legacy,{headers:{cookie}}),f.env);
  assert.ok(session);
  const headers={origin:legacy,cookie,'content-type':'application/json','X-Stem-Account':session.subject};
  const seed=await guestTransfer(new Request(legacy+'/auth/guest-transfer/preferences/seed',{method:'POST',headers,body:JSON.stringify({requestId:'00000000-0000-4000-8000-000000000040',records:[{kind:'benchTab',value:'splitter'},{kind:'classChoice',value:'msh-245'}]})}),f.env);
  assert.equal(seed.status,200);assert.equal(seed.headers.get('X-Stem-Account'),session.subject);
  const mismatch=await guestTransfer(new Request(legacy+'/auth/guest-transfer/preferences/seed',{method:'POST',headers:{...headers,'X-Stem-Account':'guest-'+'d'.repeat(64)},body:JSON.stringify({requestId:'00000000-0000-4000-8000-000000000041',records:[{kind:'modelChoice',value:'auto'}]})}),f.env);
  assert.equal(mismatch.status,409);
  assert.equal((await f.database.prepare('SELECT COUNT(*) AS n FROM account_preferences WHERE subject=?').bind('guest-'+'d'.repeat(64)).first<any>()).n,0);
  const write=await guestTransfer(new Request(legacy+'/auth/guest-transfer/preferences/write',{method:'POST',headers,body:JSON.stringify({kind:'benchTab',requestId:'00000000-0000-4000-8000-000000000042',baseRevision:1,value:'remixer'})}),f.env);
  assert.equal(write.status,200);assert.equal((await write.json() as any).revision,2);
  const stale=await guestTransfer(new Request(legacy+'/auth/guest-transfer/preferences/write',{method:'POST',headers,body:JSON.stringify({kind:'benchTab',requestId:'00000000-0000-4000-8000-000000000043',baseRevision:1,value:'splitter'})}),f.env);
  assert.equal(stale.status,409);assert.equal((await stale.json() as any).outcome,'conflict');
  assert.equal((await f.database.prepare("SELECT payload_json FROM account_preferences WHERE subject=? AND kind='benchTab'").bind(session.subject).first<any>()).payload_json,'"remixer"');
  assert.equal((await f.database.prepare("SELECT payload_json FROM account_preference_versions WHERE subject=? AND kind='benchTab'").bind(session.subject).first<any>()).payload_json,'"splitter"');
  const badOrigin=await guestTransfer(new Request(legacy+'/auth/guest-transfer/preferences/write',{method:'POST',headers:{...headers,origin:'https://attacker.invalid'},body:JSON.stringify({kind:'benchTab',requestId:'00000000-0000-4000-8000-000000000044',baseRevision:2,value:'splitter'})}),f.env);
  assert.equal(badOrigin.status,403);
});

test('guest seed and claim preserve private drafts and accept late seeds only for exact claimed jobs', async () => {
  const f = fixture(), cookie = await f.begin();
  const session = await readGuestSession(new Request(legacy, { headers: { cookie } }), f.env);
  assert.ok(session);
  const alice = 'cail-' + 'a'.repeat(32), bob = 'cail-' + 'b'.repeat(32);
  for (const subject of [alice, bob]) await f.database.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
  await f.database.prepare('INSERT INTO guest_sessions(subject,created_at,expires_at,verified_day) VALUES(?,?,?,?)')
    .bind('guest-' + 'f'.repeat(64), Date.now(), session.expiresAt, session.verifiedDay).run();
  for (const id of ['before-claim', 'late-seed', 'foreign']) {
    await f.database.prepare("INSERT INTO jobs(id,filename,source_key,status,model) VALUES(?,'Synthetic','uploads/source.wav','done','htdemucs_ft')").bind(id).run();
    await f.database.prepare('INSERT INTO guest_job_owners(job_id,subject) VALUES(?,?)').bind(id, id === 'foreign' ? 'guest-' + 'f'.repeat(64) : session.subject).run();
  }
  const seed = (jobId: string, text: string, requestId = crypto.randomUUID()) => guestTransfer(new Request(legacy + '/auth/guest-transfer/seed', {
    method: 'POST', headers: { origin: legacy, cookie: cookie + '; __Host-stem-session=different-member-cookie', 'X-Stem-Account': session.subject, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, records: [{ jobId, kind: 'listeningDraft', value: text }] }),
  }), f.env);
  const initial = await seed('before-claim', 'Guest draft before claim');
  assert.equal(initial.status, 200);
  assert.deepEqual((await initial.json() as any).accepted, [{ jobId: 'before-claim', kind: 'listeningDraft' }]);
  const state = (subject: string, jobId: string) => f.database.prepare("SELECT payload_json FROM job_ui_state_records WHERE subject=? AND job_id=? AND kind='listeningDraft'").bind(subject, jobId).first<{ payload_json: string }>();
  assert.equal(JSON.parse((await state(session.subject, 'before-claim'))!.payload_json), 'Guest draft before claim');
  const claimed = await claimGuestWork({ ...f.env, guestClaimSession: session }, {
    subject: alice, role: 'member', quotaClass: 'member', displayName: 'Synthetic', course: null, courseId: null,
  });
  assert.deepEqual(claimed.claimedJobIds, ['before-claim', 'late-seed']);
  assert.equal(JSON.parse((await state(alice, 'before-claim'))!.payload_json), 'Guest draft before claim');
  assert.ok(await state(session.subject, 'before-claim'), 'guest original remains intact');
  const requestId = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const late = await seed('late-seed', 'Late old-address draft', requestId);
    assert.equal(late.status, 200);
    assert.deepEqual((await late.json() as any).accepted, [{ jobId: 'late-seed', kind: 'listeningDraft' }]);
  }
  assert.equal(JSON.parse((await state(alice, 'late-seed'))!.payload_json), 'Late old-address draft');
  assert.equal(await state(bob, 'late-seed'), null, 'coexisting member cookie never chooses the destination');
  const denied = await seed('foreign', 'Must remain only in browser');
  assert.equal(denied.status, 200);
  assert.deepEqual((await denied.json() as any).denied, [{ jobId: 'foreign', kind: 'listeningDraft' }]);
  assert.equal(await state(session.subject, 'foreign'), null);
  await f.database.prepare("UPDATE job_owners SET subject=? WHERE job_id='late-seed'").bind(bob).run();
  assert.deepEqual((await (await seed('late-seed', 'No longer the recorded owner')).json() as any).denied, [{ jobId: 'late-seed', kind: 'listeningDraft' }]);
  assert.equal(await state(bob, 'late-seed'), null);
});

test('source journal writes preserve explicit clears through claim, reject stale drafts and fence actor authority', async () => {
  const f = fixture(), cookie = await f.begin();
  const session = await readGuestSession(new Request(legacy, { headers: { cookie } }), f.env);
  assert.ok(session);
  const member = 'cail-' + 'a'.repeat(32), other = 'cail-' + 'b'.repeat(32);
  for (const subject of [member, other]) await f.database.prepare('INSERT INTO app_users(subject) VALUES(?)').bind(subject).run();
  for (const id of ['journal-clear', 'journal-late', 'unowned']) {
    await f.database.prepare("INSERT INTO jobs(id,filename,source_key,status,model) VALUES(?,'Synthetic','uploads/source.wav','done','htdemucs_ft')").bind(id).run();
    if (id !== 'unowned') await f.database.prepare('INSERT INTO guest_job_owners(job_id,subject) VALUES(?,?)').bind(id, session.subject).run();
  }
  const call = (body: unknown, extra: Record<string,string> = {}, origin = legacy) => guestTransfer(new Request(origin + '/auth/guest-transfer/write', {
    method: 'POST', headers: { origin: legacy, cookie: cookie + '; __Host-stem-session=other-member', 'Content-Type': 'application/json', 'X-Stem-Account': session.subject, ...extra }, body: JSON.stringify(body),
  }), f.env);
  const initial = { jobId: 'journal-clear', requestId: crypto.randomUUID(), kind: 'listeningDraft', baseRevision: 0, value: 'Old draft' };
  assert.equal((await call(initial)).status, 200);
  const clear = { ...initial, requestId: crypto.randomUUID(), baseRevision: 1, value: null };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await call(clear);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Stem-Account'), session.subject);
    assert.deepEqual(await response.json(), { jobId: 'journal-clear', kind: 'listeningDraft', outcome: 'applied', revision: 2 });
  }
  const stale = await call({ ...initial, requestId: crypto.randomUUID(), baseRevision: 1, value: 'Stale draft' });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as any).outcome, 'conflict');
  const state = (actor: string, jobId: string) => f.database.prepare("SELECT revision,payload_json FROM job_ui_state_records WHERE subject=? AND job_id=? AND kind='listeningDraft'").bind(actor, jobId).first<{ revision: number; payload_json: string }>();
  assert.deepEqual({ ...await state(session.subject, initial.jobId) }, { revision: 2, payload_json: 'null' });
  assert.equal((await call({ ...initial, jobId: 'unowned' })).status, 404);
  for (const extra of [{ origin: tools }, { 'sec-fetch-site': 'cross-site' }, { 'x-cail-identity-jwt': 'partial' }, { 'x-cail-gateway-identity-jwt': 'partial' }]) assert.equal((await call(clear, extra)).status, 403);
  assert.equal((await call(clear, {}, tools)).status, 403);
  assert.equal((await call(clear, { 'X-Stem-Account': member })).status, 409);
  assert.equal((await call(clear, { cookie: cookie + '; ' + cookie })).status, 401);
  for (const body of [{ ...clear, kind: 'pendingChat' }, { ...clear, baseRevision: -1 }, { ...clear, subject: member }, { ...clear, requestId: 'bad' }]) assert.equal((await call(body)).status, 400);
  assert.equal((await call({ ...clear, value: 'x'.repeat(32768) })).status, 413);
  await claimGuestWork({ ...f.env, guestClaimSession: session }, { subject: member, role: 'member', quotaClass: 'member', displayName: 'Synthetic', course: null, courseId: null });
  assert.equal((await state(member, initial.jobId))?.payload_json, 'null', 'claim carries the explicit clear, never the older draft');
  assert.equal((await call({ ...initial, jobId: 'journal-late', requestId: crypto.randomUUID(), value: 'Late retained draft' })).status, 200);
  assert.equal((await state(member, 'journal-late'))?.payload_json, '"Late retained draft"');
  assert.equal(await state(other, 'journal-late'), null, 'coexisting member cookie does not redirect a late write');
  await f.database.prepare("UPDATE job_owners SET subject=? WHERE job_id='journal-late'").bind(other).run();
  assert.equal((await call({ ...initial, jobId: 'journal-late', requestId: crypto.randomUUID(), baseRevision: 1 })).status, 404);
  await f.database.prepare('UPDATE guest_sessions SET revoked_at=? WHERE subject=?').bind(Date.now(), session.subject).run();
  assert.equal((await call(clear)).status, 401);
});

test('nonce, origin, duplicate cookies, tampering and expiration reject the handoff', async () => {
  const f = fixture(), transfer = await f.handoff();
  const other = await f.start();
  for (const [token, cookies, origin] of [
    [transfer.token, other.cookie, tools], [transfer.token, '', tools],
    [transfer.token, transfer.cookie + '; ' + transfer.cookie, tools],
    [transfer.token, transfer.cookie, 'https://attacker.test'],
    ['A' + transfer.token, transfer.cookie, tools],
    [transfer.token.slice(0, -10) + 'AAAAAAAAAA', transfer.cookie, tools],
  ]) assert.equal((await f.finish(token, cookies, origin)).status, 403);
  const now = Date.now;
  try {
    Date.now = () => now() + 300001;
    assert.equal((await f.finish(transfer.token, transfer.cookie)).status, 403);
  } finally { Date.now = now; }
  assert.equal((await f.finish(transfer.token, transfer.cookie)).status, 200, 'rejected requests do not consume valid nonce');
});

test('revocation and account claim between handoff and completion fail closed', async () => {
  for (const mode of ['revoked', 'claimed']) {
    const f = fixture(), transfer = await f.handoff();
    const session = await readGuestSession(new Request(legacy, { headers: { cookie: transfer.sourceCookie } }), f.env);
    assert.ok(session);
    if (mode === 'revoked') await f.database.prepare('UPDATE guest_sessions SET revoked_at=? WHERE subject=?').bind(Date.now(), session.subject).run();
    else {
      await f.database.prepare("INSERT INTO app_users(subject) VALUES(?)").bind('cail-' + 'a'.repeat(32)).run();
      await f.database.prepare('INSERT INTO guest_account_claims(guest_subject,member_subject) VALUES(?,?)').bind(session.subject, 'cail-' + 'a'.repeat(32)).run();
    }
    assert.equal((await f.finish(transfer.token, transfer.cookie)).status, 403, mode);
  }
});

test('conflicting Tools workspace is not overwritten or consumed', async () => {
  const f = fixture(), first = await f.handoff();
  const firstResult = await f.finish(first.token, first.cookie);
  const originalTarget = f.cookie(firstResult);
  const second = await f.handoff();
  const conflict = await f.finish(second.token, second.cookie + '; ' + originalTarget);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.headers.get('set-cookie'), null);
  assert.equal((await conflict.json() as any).error.code, 'workspace_conflict');
  assert.equal((await f.finish(second.token, second.cookie)).status, 200);
});

test('legacy member session is preserved and directs the visitor to sign in', async () => {
  const f = fixture(), transfer = await f.handoff('__Host-stem-session=member-fixture');
  const response = await f.finish(transfer.token, transfer.cookie);
  assert.equal(response.status, 409);
  assert.equal((await response.json() as any).error.code, 'member_workspace');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await f.database.prepare('SELECT count(*) AS n FROM guest_sessions').first())?.n, 0);
});

test('existing-only recovery checks never create a guest or overwrite an existing target cookie', async () => {
  for (const sourceCookie of ['', '__Host-stem-session=member-fixture']) {
    const f = fixture(), transfer = await f.handoff(sourceCookie, true);
    const response = await f.finish(transfer.token, transfer.cookie);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { restored: false });
    assert.equal(f.cookie(response), '');
    assert.equal((await f.database.prepare('SELECT count(*) AS n FROM guest_sessions').first())?.n, 0);
    assert.equal((await f.finish(transfer.token, transfer.cookie)).status, 403);
  }
});

test('existing-only recovery preserves an old guest for the normal signed-in claim flow', async () => {
  const f = fixture(), original = await f.begin(), transfer = await f.handoff(original, true);
  const response = await f.finish(transfer.token, transfer.cookie);
  assert.equal(response.status, 200);
  assert.deepEqual(await readGuestSession(new Request(tools, { headers: { cookie: f.cookie(response) } }), f.env),
    await readGuestSession(new Request(legacy, { headers: { cookie: original } }), f.env));
});

test('concurrent completion consumes a handoff once', async () => {
  const f = fixture(), transfer = await f.handoff();
  const responses = await Promise.all(Array.from({ length: 20 }, () => f.finish(transfer.token, transfer.cookie)));
  assert.equal(responses.filter(response => response.status === 200).length, 1);
  assert.equal(responses.filter(response => response.status === 403).length, 19);
  assert.equal((await f.database.prepare('SELECT count(*) AS n FROM guest_sessions').first())?.n, 1);
});

test('alternate encodings and separately issued tokens cannot reuse an accepted nonce', async () => {
  const f = fixture(), transfer = await f.handoff();
  const secondToken = (await f.handoff(transfer.sourceCookie, false, transfer.nonce)).token;
  assert.notEqual(secondToken, transfer.token);
  assert.equal((await f.finish(transfer.token, transfer.cookie)).status, 200);
  assert.equal((await f.finish(secondToken, transfer.cookie)).status, 403);
  const [iv, sealed] = transfer.token.split('.');
  const decoded = Buffer.from(sealed, 'base64url');
  for (const last of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_') {
    const variant = sealed.slice(0, -1) + last;
    if (variant !== sealed && Buffer.from(variant, 'base64url').equals(decoded)) {
      assert.equal((await f.finish(iv + '.' + variant, transfer.cookie)).status, 403);
    }
  }
});
