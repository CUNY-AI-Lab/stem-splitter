import assert from 'node:assert/strict';
import test from 'node:test';

import { readBoundedResponse } from '../src/http/bounded-response.ts';

function errors() {
  return {
    tooLarge: () => new Error('too-large'),
    timedOut: () => new Error('timed-out'),
    unreadable: () => new Error('unreadable'),
  };
}

test('bounded response reads a streamed body below the cap', async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    })
  );
  const body = await readBoundedResponse(response, {
    maximumBytes: 4,
    timeoutMs: 100,
    errors: errors(),
  });
  assert.deepEqual(new Uint8Array(body), new Uint8Array([1, 2, 3, 4]));
});

test('bounded response stops a streamed body that crosses the cap', async () => {
  let pull = 0;
  let canceled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pull += 1;
        if (pull <= 2) controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      cancel() {
        canceled = true;
      },
    })
  );

  await assert.rejects(
    () =>
      readBoundedResponse(response, {
        maximumBytes: 6,
        timeoutMs: 100,
        errors: errors(),
      }),
    /too-large/
  );
  assert.equal(canceled, true);
});

test('bounded response cancels a body whose declared length crosses the cap', async () => {
  let canceled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        // The declared boundary should reject before the first read.
      },
      cancel() {
        canceled = true;
      },
    }),
    { headers: { 'Content-Length': '11' } }
  );

  await assert.rejects(
    () =>
      readBoundedResponse(response, {
        maximumBytes: 10,
        timeoutMs: 100,
        errors: errors(),
      }),
    /too-large/
  );
  assert.equal(canceled, true);
});

test('bounded response cancels a body that stalls after headers', async () => {
  let canceled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        // Deliberately leave the pending read unresolved.
      },
      cancel() {
        canceled = true;
      },
    })
  );

  await assert.rejects(
    () =>
      readBoundedResponse(response, {
        maximumBytes: 10,
        timeoutMs: 10,
        errors: errors(),
      }),
    /timed-out/
  );
  assert.equal(canceled, true);
});

test('bounded response does not reflect a provider stream error', async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('provider reflected secret');
      },
    })
  );

  await assert.rejects(
    () =>
      readBoundedResponse(response, {
        maximumBytes: 10,
        timeoutMs: 100,
        errors: errors(),
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'unreadable' &&
      !error.message.includes('provider reflected secret')
  );
});
