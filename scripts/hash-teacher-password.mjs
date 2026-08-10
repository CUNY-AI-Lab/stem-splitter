#!/usr/bin/env node
// Produce a TEACHER_SEED entry without ever writing a plaintext password to
// disk. The password is read from stdin (not argv, so it stays out of the
// shell history and the process table).
//
//   bash -c '
//     IFS= read -r -s -p "Teacher password: " teacher_password
//     printf "\n"
//     printf "%s" "$teacher_password" | \
//       node scripts/hash-teacher-password.mjs acheca "Agustina Checa"
//     unset teacher_password
//   '
//
// Collect the printed JSON objects into an array and set it as the
// TEACHER_SEED secret. The app upserts these rows on boot, so rotating a
// password means re-running this and updating the secret — no SQL, and the
// accounts survive a wiped database or a lost Railway volume.
import { pbkdf2Sync, randomBytes } from 'node:crypto';

const ITERATIONS = 210_000; // must match PBKDF2_ITERATIONS in src/teacher/auth.ts
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const MAX_PASSWORD_CHARS = 512; // must match the teacher login boundary
const MAX_PASSWORD_BYTES = 4096;

const [username, displayName] = process.argv.slice(2);
if (!username) {
  console.error('usage: printf \'<password>\' | node scripts/hash-teacher-password.mjs <username> [display name]');
  process.exit(1);
}
const normalizedUsername = username.trim().toLowerCase();
const normalizedName = displayName === undefined ? normalizedUsername : displayName.trim();
if (!/^[a-z0-9._-]{1,64}$/.test(normalizedUsername)) {
  console.error('Username must contain 1-64 letters, numbers, dots, underscores, or hyphens.');
  process.exit(1);
}
if (!normalizedName || normalizedName.length > 120) {
  console.error('Display name must contain 1-120 characters.');
  process.exit(1);
}

const chunks = [];
let passwordBytes = 0;
for await (const rawChunk of process.stdin) {
  const chunk = Buffer.from(rawChunk);
  passwordBytes += chunk.byteLength;
  if (passwordBytes > MAX_PASSWORD_BYTES) {
    console.error('Password input is too large.');
    process.exit(1);
  }
  chunks.push(chunk);
}
const passwordBuffer = Buffer.concat(chunks);
let password;
try {
  password = new TextDecoder('utf-8', { fatal: true }).decode(passwordBuffer).replace(/\r?\n$/, '');
} catch {
  console.error('Password input must be valid UTF-8.');
  process.exit(1);
}

if (!password || password.length > MAX_PASSWORD_CHARS || /[\r\n\0]/.test(password)) {
  console.error('Password input must contain 1-512 characters on one line.');
  process.exit(1);
}

const salt = randomBytes(SALT_BYTES).toString('hex');
const hash = pbkdf2Sync(password, Buffer.from(salt, 'hex'), ITERATIONS, KEY_BYTES, 'sha256').toString('hex');
passwordBuffer.fill(0);
for (const chunk of chunks) chunk.fill(0);
password = '';

console.log(
  JSON.stringify({
    username: normalizedUsername,
    name: normalizedName,
    salt,
    hash,
    iterations: ITERATIONS,
  })
);
