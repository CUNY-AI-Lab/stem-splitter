#!/usr/bin/env node
// Produce a TEACHER_SEED entry without ever writing a plaintext password to
// disk. The password is read from stdin (not argv, so it stays out of the
// shell history and the process table).
//
//   printf 'the-password' | node scripts/hash-teacher-password.mjs acheca "Agustina Checa"
//
// Collect the printed JSON objects into an array and set it as the
// TEACHER_SEED secret. The app upserts these rows on boot, so rotating a
// password means re-running this and updating the secret — no SQL, and the
// accounts survive a wiped database or a lost Railway volume.
import { pbkdf2Sync, randomBytes } from 'node:crypto';

const ITERATIONS = 210_000; // must match PBKDF2_ITERATIONS in src/teacher/auth.ts
const KEY_BYTES = 32;
const SALT_BYTES = 16;

const [username, displayName] = process.argv.slice(2);
if (!username) {
  console.error('usage: printf \'<password>\' | node scripts/hash-teacher-password.mjs <username> [display name]');
  process.exit(1);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');

if (!password) {
  console.error('No password on stdin.');
  process.exit(1);
}

const salt = randomBytes(SALT_BYTES).toString('hex');
const hash = pbkdf2Sync(password, Buffer.from(salt, 'hex'), ITERATIONS, KEY_BYTES, 'sha256').toString('hex');

console.log(
  JSON.stringify({
    username: username.toLowerCase(),
    name: displayName || username,
    salt,
    hash,
    iterations: ITERATIONS,
  })
);
