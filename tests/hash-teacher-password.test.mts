import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SCRIPT = 'scripts/hash-teacher-password.mjs';

function runHelper(password: string | Buffer, ...arguments_: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...arguments_], {
    cwd: process.cwd(),
    input: password,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
}

test('teacher password helper emits a valid normalized PBKDF2 seed record', () => {
  const password = 'fixture-only-password';
  const result = runHelper(password, ' Instructor ', ' Course Instructor ');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const record = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(record).sort(), ['hash', 'iterations', 'name', 'salt', 'username']);
  assert.equal(record.username, 'instructor');
  assert.equal(record.name, 'Course Instructor');
  assert.equal(record.iterations, 210_000);
  assert.match(record.salt, /^[a-f0-9]{32}$/);
  assert.match(record.hash, /^[a-f0-9]{64}$/);
  assert.equal(
    record.hash,
    pbkdf2Sync(password, Buffer.from(record.salt, 'hex'), 210_000, 32, 'sha256').toString('hex')
  );
});

test('teacher password helper rejects invalid seed identities without output', () => {
  for (const arguments_ of [
    ['not allowed', 'Teacher'],
    ['teacher', ''],
    ['teacher', 'x'.repeat(121)],
  ]) {
    const result = runHelper('fixture-only-password', ...arguments_);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
});

test('teacher password helper bounds and validates stdin before PBKDF2 work', () => {
  for (const password of [
    '',
    'x'.repeat(513),
    'line one\nline two',
    'contains\0null',
    Buffer.from([0xc3, 0x28]),
    Buffer.alloc(4097, 0x61),
  ]) {
    const result = runHelper(password, 'teacher', 'Teacher');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
});
