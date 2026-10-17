import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteD1 } from '../server/d1.ts';
import {
  DEFAULT_SEPARATION_STALL_MINUTES,
  STALLED_JOB_MESSAGE,
  expireStalledJob,
  separationStallMinutes,
  stallDeadlinePassed,
} from '../src/separation/deadline.ts';

test('the stall deadline defaults to an hour and 0 turns it off', () => {
  assert.equal(separationStallMinutes({}), DEFAULT_SEPARATION_STALL_MINUTES);
  assert.equal(separationStallMinutes({ SEPARATION_STALL_MINUTES: '5' }), 5);
  assert.equal(separationStallMinutes({ SEPARATION_STALL_MINUTES: '0' }), 0);
  for (const invalid of ['-1', '1.5', 'soon', ' ']) {
    assert.equal(
      separationStallMinutes({ SEPARATION_STALL_MINUTES: invalid }),
      DEFAULT_SEPARATION_STALL_MINUTES,
      invalid
    );
  }
  // A numeric Wrangler var arrives as a number; it must not throw on every poll.
  assert.equal(separationStallMinutes({ SEPARATION_STALL_MINUTES: 15 as never }), 15);
});

test('the deadline check reads jobs.created_at as UTC without touching the database', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  assert.equal(stallDeadlinePassed('2026-10-01 11:00:00', 60, now), true);
  assert.equal(stallDeadlinePassed('2026-10-01 11:00:01', 60, now), false);
  assert.equal(stallDeadlinePassed('2026-10-01 10:00:00', 0, now), false);
  assert.equal(stallDeadlinePassed('not a timestamp', 60, now), false);
});

test('only old pending or processing jobs are failed by the stall deadline', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stem-splitter-stall-'));
  try {
    const db = new SqliteD1(join(directory, 'stall.sqlite'));
    db.applySchema(readFileSync('schema.sql', 'utf8'));
    const rows: [string, string, string][] = [
      ['old-processing', 'processing', '2026-10-01 10:00:00'],
      ['old-pending', 'pending', '2026-10-01 10:00:00'],
      ['old-ingesting', 'ingesting', '2026-10-01 10:00:00'],
      ['old-done', 'done', '2026-10-01 10:00:00'],
      ['young-processing', 'processing', '2026-10-01 11:30:00'],
    ];
    for (const [id, status, createdAt] of rows) {
      await db
        .prepare(
          `INSERT INTO jobs (id, filename, source_key, status, model, created_at)
           VALUES (?, 'song.wav', 'uploads/x/source.wav', ?, 'htdemucs_ft', ?)`
        )
        .bind(id, status, createdAt)
        .run();
    }
    const now = new Date('2026-10-01T12:00:00Z');

    const expired: Record<string, boolean> = {};
    for (const [id] of rows) expired[id] = await expireStalledJob(db as never, id, 60, now);
    assert.deepEqual(expired, {
      'old-processing': true,
      'old-pending': true,
      'old-ingesting': false,
      'old-done': false,
      'young-processing': false,
    });

    const failed = await db
      .prepare("SELECT status, error FROM jobs WHERE id = 'old-processing'")
      .first<{ status: string; error: string }>();
    assert.deepEqual({ ...failed }, { status: 'failed', error: STALLED_JOB_MESSAGE });

    // Disabled: even an old processing row is left alone.
    await db.prepare("UPDATE jobs SET status = 'processing' WHERE id = 'old-processing'").run();
    assert.equal(await expireStalledJob(db as never, 'old-processing', 0, now), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
