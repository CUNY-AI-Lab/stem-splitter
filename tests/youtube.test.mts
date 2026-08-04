import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchViaReplicate,
  parseYouTubeVideoId,
  YouTubeError,
} from '../src/youtube.ts';

const TEST_TOKEN = 'test-replicate-token';
const TEST_ENV = {
  REPLICATE_API_TOKEN: TEST_TOKEN,
  REPLICATE_YT_MODEL: 'test/yt-audio',
};

test('YouTube URL parsing accepts video routes and rejects malformed IDs', () => {
  const videoId = 'jNQXAC9IVRw';
  assert.equal(parseYouTubeVideoId(`https://www.youtube.com/watch?v=${videoId}`), videoId);
  assert.equal(parseYouTubeVideoId(`https://youtu.be/${videoId}?feature=shared`), videoId);
  assert.equal(parseYouTubeVideoId(`https://youtube.com/shorts/${videoId}`), videoId);
  assert.equal(parseYouTubeVideoId(`https://youtube.com/embed/${videoId}`), videoId);
  assert.equal(parseYouTubeVideoId(`https://youtube.com/live/${videoId}`), videoId);
  assert.equal(parseYouTubeVideoId('https://youtube.com/watch?v=too-short'), null);
  assert.equal(parseYouTubeVideoId(`https://youtube.com.evil/watch?v=${videoId}`), null);
  assert.equal(parseYouTubeVideoId(`javascript:alert('${videoId}')`), null);
});

test('Replicate fallback authenticates the output download and validates M4A bytes', async () => {
  const originalFetch = globalThis.fetch;
  const audio = makeM4a();
  const requests: Array<{ url: string; headers: Headers }> = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, headers });

    if (url.endsWith('/models/test/yt-audio')) {
      return Response.json({ latest_version: { id: 'yt-version' } });
    }
    if (url.endsWith('/predictions')) {
      assert.equal(headers.get('prefer'), 'wait=60');
      assert.equal(headers.get('cancel-after'), '4m');
      return Response.json({
        id: 'yt-prediction',
        status: 'succeeded',
        output: {
          audio: 'https://audio.replicate.delivery/fetched.m4a',
          title: '  Test track  ',
          duration: 19,
        },
      });
    }
    if (url === 'https://audio.replicate.delivery/fetched.m4a') {
      assert.equal(headers.get('authorization'), `Bearer ${TEST_TOKEN}`);
      return new Response(audio, {
        headers: {
          'Content-Type': 'audio/mp4',
          'Content-Length': String(audio.byteLength),
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await fetchViaReplicate(
      'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      TEST_ENV as never
    );
    assert.equal(result.title, 'Test track');
    assert.equal(result.durationSec, 19);
    assert.deepEqual(new Uint8Array(result.data), audio);
    assert.equal(requests.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate fallback rejects a successful prediction that returns HTML', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/models/test/yt-audio')) {
      return Response.json({ latest_version: { id: 'yt-version' } });
    }
    if (url.endsWith('/predictions')) {
      return Response.json({
        id: 'yt-prediction',
        status: 'succeeded',
        output: {
          audio: 'https://audio.replicate.delivery/not-audio.m4a',
          title: 'Blocked',
          duration: 19,
        },
      });
    }
    return new Response('<html>provider error</html>', {
      headers: { 'Content-Type': 'text/html' },
    });
  };

  try {
    await assert.rejects(
      () =>
        fetchViaReplicate(
          'https://www.youtube.com/watch?v=jNQXAC9IVRw',
          TEST_ENV as never
        ),
      (error: unknown) =>
        error instanceof YouTubeError && error.code === 'invalid_audio_response'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate rate limits become a retryable student-facing error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 429 });

  try {
    await assert.rejects(
      () =>
        fetchViaReplicate(
          'https://www.youtube.com/watch?v=jNQXAC9IVRw',
          TEST_ENV as never
        ),
      (error: unknown) =>
        error instanceof YouTubeError &&
        error.code === 'youtube_fetch_busy' &&
        error.retryable
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function makeM4a(size = 2048): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
  return bytes;
}
