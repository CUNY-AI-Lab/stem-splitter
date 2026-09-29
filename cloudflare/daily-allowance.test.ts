import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';
import { SqliteD1 } from '../server/d1.ts';
import { dailyWindow, reserveDailyRequest, splitAllowance } from '../src/daily-allowance.ts';

async function setup() {
  const db = new SqliteD1(':memory:');
  db.applySchema(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  for (const subject of Object.values(TEST_SUBJECTS)) {
    await db.prepare('INSERT OR IGNORE INTO app_users (subject) VALUES (?)').bind(subject).run();
  }
  return db as unknown as D1Database;
}

test('ten signed-in requests each, with no shared split cap and no client-selected reset', async () => {
  const db = await setup();
  const today = new Date('2026-09-29T20:00:00Z');
  for (const subject of [TEST_SUBJECTS.alice, TEST_SUBJECTS.bob, TEST_SUBJECTS.carol]) {
    const reservations = await Promise.all(Array.from({ length: 30 }, () => reserveDailyRequest(db, subject, 'split', today)));
    assert.equal(reservations.filter(result => result.allowed).length, 10);
    assert.deepEqual(await splitAllowance(db, subject, today), { limit: 10, used: 10, remaining: 0, resetsAt: '2026-09-30T00:00:00.000Z' });
  }
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM app_request_reservations WHERE scope = 'split'").first<{ n: number }>())?.n, 30);
});

test('resets at UTC midnight, independently of DST, month/year boundaries and old reservations', async () => {
  const db = await setup();
  const before = new Date('2026-12-31T23:59:59.999Z');
  assert.deepEqual(dailyWindow(before), { day: '2026-12-31', resetsAt: '2027-01-01T00:00:00.000Z', retryAfter: 1 });
  assert.equal(dailyWindow(new Date('2026-11-01T00:00:00Z')).retryAfter, 86400);
  await Promise.all(Array.from({ length: 10 }, () => reserveDailyRequest(db, TEST_SUBJECTS.alice, 'split', before)));
  assert.equal((await reserveDailyRequest(db, TEST_SUBJECTS.alice, 'split', before)).allowed, false);
  const after = new Date('2027-01-01T00:00:00Z');
  assert.equal((await splitAllowance(db, TEST_SUBJECTS.alice, after)).remaining, 10);
  assert.equal((await reserveDailyRequest(db, TEST_SUBJECTS.alice, 'split', after)).allowed, true);
  assert.equal((await splitAllowance(db, TEST_SUBJECTS.alice, after)).remaining, 9);
});

test('legacy guide guards remain independent of splits, including its shared ceiling', async () => {
  const db = await setup();
  const now = new Date('2026-09-29T20:00:00Z');
  const day = dailyWindow(now).day;
  for (let i = 0; i < 499; i++) {
    await db.prepare('INSERT INTO app_request_reservations (id, subject, scope, day) VALUES (?, ?, ?, ?)')
      .bind(`fixture-${i}`, TEST_SUBJECTS.bob, 'guide', day).run();
  }
  assert.equal((await reserveDailyRequest(db, TEST_SUBJECTS.bob, 'guide', now)).allowed, false);
  assert.equal((await reserveDailyRequest(db, TEST_SUBJECTS.alice, 'guide', now)).allowed, true);
  assert.equal((await reserveDailyRequest(db, TEST_SUBJECTS.alice, 'guide', now)).allowed, false);
  assert.equal((await reserveDailyRequest(db, TEST_SUBJECTS.alice, 'split', now)).allowed, true);
  assert.equal((await splitAllowance(db, TEST_SUBJECTS.alice, now)).remaining, 9);
});

test('counter/storage failures never grant or report unused requests', async () => {
  const db = { prepare: () => { throw new Error('fixture unavailable'); } } as unknown as D1Database;
  await assert.rejects(reserveDailyRequest(db, TEST_SUBJECTS.alice, 'split'));
  await assert.rejects(splitAllowance(db, TEST_SUBJECTS.alice));
});
