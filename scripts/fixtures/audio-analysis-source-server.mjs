#!/usr/bin/env node

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = 9090;
const SOURCE_PATH = '/fixture-audio/source.wav';
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const STREAM_CHUNK = Buffer.alloc(64 * 1024, 0x55);

function wavHeader({ sampleRate, seconds }) {
  const dataBytes = sampleRate * seconds;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return { header, dataBytes };
}

async function writeRepeated(response, bytes, value = 0x80) {
  let remaining = bytes;
  const chunk = value === STREAM_CHUNK[0] ? STREAM_CHUNK : Buffer.alloc(64 * 1024, value);
  while (remaining > 0 && !response.destroyed) {
    const part = chunk.subarray(0, Math.min(chunk.length, remaining));
    remaining -= part.length;
    if (!response.write(part)) await new Promise((resolve) => response.once('drain', resolve));
  }
  if (!response.destroyed) response.end();
}

function audioHeaders(response, contentLength) {
  response.statusCode = 200;
  response.setHeader('content-type', 'audio/wav');
  response.setHeader('cache-control', 'no-store');
  if (contentLength !== undefined) response.setHeader('content-length', String(contentLength));
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://fixture:9090');
  if (request.method !== 'GET') {
    response.statusCode = 405;
    return response.end();
  }
  if (url.pathname === '/healthz') {
    response.setHeader('content-type', 'application/json');
    return response.end('{"ok":true}');
  }
  if (!url.pathname.startsWith('/api/local-sources/uploads/')) {
    response.statusCode = 404;
    return response.end();
  }

  const fixture = url.pathname.slice('/api/local-sources/uploads/'.length);
  if (fixture === 'valid.wav') {
    const size = statSync(SOURCE_PATH).size;
    audioHeaders(response, size);
    return createReadStream(SOURCE_PATH).pipe(response);
  }
  if (fixture === 'max-duration.wav') {
    const generated = wavHeader({ sampleRate: 8_000, seconds: 900 });
    audioHeaders(response, generated.header.length + generated.dataBytes);
    response.write(generated.header);
    void writeRepeated(response, generated.dataBytes);
    return;
  }
  if (fixture === 'malformed.wav') {
    const body = Buffer.alloc(4 * 1024, 0x41);
    audioHeaders(response, body.length);
    return response.end(body);
  }
  if (fixture === 'declared-oversize.wav') {
    audioHeaders(response, MAX_SOURCE_BYTES + 1);
    return response.end(Buffer.from([0]));
  }
  if (fixture === 'streamed-oversize.wav') {
    audioHeaders(response);
    void writeRepeated(response, MAX_SOURCE_BYTES + 1, STREAM_CHUNK[0]);
    return;
  }
  if (fixture === 'slow.wav' || fixture === 'hold.wav') {
    setTimeout(() => {
      if (response.destroyed) return;
      const body = Buffer.alloc(4 * 1024, 0x41);
      audioHeaders(response, body.length);
      response.end(body);
    }, 3_000);
    return;
  }
  response.statusCode = 404;
  response.end();
});

server.listen(PORT, '0.0.0.0');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
