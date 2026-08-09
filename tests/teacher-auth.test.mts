import assert from 'node:assert/strict';
import test from 'node:test';
import { TeacherLoginThrottle } from '../src/teacher/auth.ts';
import { readBoundedTeacherJson, TeacherRequestError } from '../src/teacher/request.ts';

test('teacher JSON parsing enforces media type plus streamed byte and time limits', async () => {
  assert.deepEqual(
    await readBoundedTeacherJson(
      new Request('https://stem-splitter.test/api/teacher/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ username: 'teacher', password: 'secret' }),
      }),
      128
    ),
    { username: 'teacher', password: 'secret' }
  );

  await assert.rejects(
    readBoundedTeacherJson(
      new Request('https://stem-splitter.test/api/teacher/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ padding: 'x'.repeat(256) }),
      }),
      64
    ),
    (error: unknown) => error instanceof TeacherRequestError && error.status === 413
  );
  await assert.rejects(
    readBoundedTeacherJson(
      new Request('https://stem-splitter.test/api/teacher/login', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{}',
      })
    ),
    (error: unknown) => error instanceof TeacherRequestError && error.status === 415
  );

  let cancelled = false;
  const stalledBody = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const stalledRequest = new Request(
    'https://stem-splitter.test/api/teacher/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stalledBody,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }
  );
  await assert.rejects(
    readBoundedTeacherJson(stalledRequest, 128, 10),
    (error: unknown) => error instanceof TeacherRequestError && error.status === 408
  );
  assert.equal(cancelled, true);
});

test('teacher login throttle blocks a bounded failure burst and resets safely', () => {
  const throttle = new TeacherLoginThrottle({
    maximumFailures: 3,
    windowMs: 1_000,
    blockMs: 2_000,
    maximumEntries: 4,
  });
  assert.equal(throttle.check('Instructor', 0).allowed, true);
  throttle.recordFailure('Instructor', 0);
  throttle.recordFailure('instructor', 100);
  throttle.recordFailure('INSTRUCTOR', 200);
  assert.deepEqual(throttle.check('instructor', 500), {
    allowed: false,
    retryAfterSeconds: 2,
  });
  assert.equal(throttle.check('instructor', 2_201).allowed, true);
  throttle.recordFailure('instructor', 2_202);
  throttle.recordSuccess('instructor');
  assert.equal(throttle.check('instructor', 2_203).allowed, true);
});
