import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

test('reliability readout separates failures, explicit cancellations, cache and pending requests without provider-attempt inflation', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE app_operations(kind TEXT,state TEXT,error_code TEXT,created_at INTEGER);');
    const insert = db.prepare('INSERT INTO app_operations VALUES (?,?,?,?)');
    for (const [state, code, at] of [
      ['succeeded', null, 100], ['failed', 'empty_response', 100], ['partial', 'partial_response', 100],
      ['cancelled', 'conversation_reset', 100], ['cancelled', 'cached_response', 100],
      ['cancelled', 'unknown_abort', 100], ['running', null, 100], ['running', null, 199999],
      ['succeeded', null, 0], ['succeeded', null, 300000],
    ]) insert.run('guide', state, code, at);
    const sql = readFileSync(new URL('../scripts/listening-reliability.sql', import.meta.url), 'utf8')
      .replace(/^--.*$/gm, '').split(';')[0];
    const result = db.prepare(sql).get({ ':since_ms': 1, ':now_ms': 200000 });
    assert.deepEqual({ ...result }, { kind: 'guide', operations: 8, recorded_successes: 1,
      failures: 4, explicit_cancellations: 1, cached_operations: 1, pending: 1 });
  } finally { db.close(); }
});
