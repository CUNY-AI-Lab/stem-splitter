import assert from 'node:assert/strict';
import test from 'node:test';

import { JsonRequestError, readBoundedJsonRequest } from '../src/http/bounded-request.ts';

function streamingRequest(headers: Record<string, string>, onCancel: () => void): Request {
  const body = new ReadableStream<Uint8Array>({
    pull() {
      // Early header checks should reject before reading this stream.
    },
    cancel() {
      onCancel();
    },
  });
  return new Request('https://stem-splitter.test/api/jobs', {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

test('bounded JSON request cancels a body whose declared length crosses the cap', async () => {
  let canceled = false;
  const request = streamingRequest(
    { 'Content-Type': 'application/json', 'Content-Length': '11' },
    () => {
      canceled = true;
    }
  );

  await assert.rejects(
    () => readBoundedJsonRequest(request, 10),
    (error: unknown) => error instanceof JsonRequestError && error.status === 413
  );
  assert.equal(canceled, true);
});

test('bounded JSON request cancels an encoded body before reading it', async () => {
  let canceled = false;
  const request = streamingRequest(
    { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    () => {
      canceled = true;
    }
  );

  await assert.rejects(
    () => readBoundedJsonRequest(request, 10),
    (error: unknown) => error instanceof JsonRequestError && error.status === 415
  );
  assert.equal(canceled, true);
});
