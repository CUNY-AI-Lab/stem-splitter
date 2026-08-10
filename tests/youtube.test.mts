import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInnertubeFetch,
  fetchViaReplicate,
  parseYouTubeVideoId,
  YouTubeError,
} from '../src/youtube.ts';

const TEST_TOKEN = 'test-replicate-token';
const TEST_VERSION = 'a'.repeat(64);
const TEST_ENV = {
  REPLICATE_API_TOKEN: TEST_TOKEN,
  REPLICATE_YT_MODEL: 'test/yt-audio',
  REPLICATE_YT_MODEL_VERSION: TEST_VERSION,
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
  assert.equal(parseYouTubeVideoId(`https://user:password@youtube.com/watch?v=${videoId}`), null);
  assert.equal(parseYouTubeVideoId(`javascript:alert('${videoId}')`), null);
});

test('Innertube fetch refuses unapproved endpoints before network access', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('must not fetch');
  };

  try {
    const providerFetch = createInnertubeFetch(Date.now() + 1_000);
    for (const url of [
      'http://www.youtube.com/youtubei/v1/player',
      'https://youtube.com.evil/youtubei/v1/player',
      'https://127.0.0.1/youtubei/v1/player',
      'https://user:password@www.youtube.com/youtubei/v1/player',
      'https://www.youtube.com:444/youtubei/v1/player',
      'https://www.youtube.com/account',
      'https://storage.googleapis.com/arbitrary-object',
      'https://i.ytimg.com/vi/example/default.jpg',
    ]) {
      await assert.rejects(
        () => providerFetch(url),
        (error: unknown) =>
          error instanceof YouTubeError && error.code === 'youtube_fetch_unavailable'
      );
    }
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Innertube fetch validates redirects and strips credentials across origins', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    assert.equal(init?.redirect, 'manual');
    if (requests.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://r1---sn.googlevideo.com/videoplayback' },
      });
    }
    return new Response(makeM4a(), { headers: { 'Content-Type': 'audio/mp4' } });
  };

  try {
    const response = await createInnertubeFetch(Date.now() + 1_000)(
      'https://www.youtube.com/youtubei/v1/player',
      {
        headers: {
          Authorization: 'Bearer must-not-cross-origins',
          Cookie: 'session=must-not-cross-origins',
          'Proxy-Authorization': 'Basic must-not-cross-origins',
          'X-Goog-AuthUser': 'must-not-cross-origins',
          'X-Goog-PageId': 'must-not-cross-origins',
          'X-Goog-Visitor-Id': 'must-not-cross-origins',
          'X-Origin': 'https://must-not-cross-origins.invalid',
          'X-Youtube-Identity-Token': 'must-not-cross-origins',
        },
      }
    );
    assert.equal((await response.arrayBuffer()).byteLength, 2048);
    assert.equal(requests.length, 2);
    for (const header of [
      'authorization',
      'cookie',
      'proxy-authorization',
      'x-goog-authuser',
      'x-goog-pageid',
      'x-goog-visitor-id',
      'x-origin',
      'x-youtube-identity-token',
    ]) {
      assert.equal(requests[1].headers.get(header), null, `${header} crossed origins`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Innertube fetch rejects unapproved redirect targets', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { Location: 'https://example.com/not-youtube' },
    });
  };

  try {
    await assert.rejects(
      () =>
        createInnertubeFetch(Date.now() + 1_000)(
          'https://www.youtube.com/youtubei/v1/player'
        ),
      (error: unknown) =>
        error instanceof YouTubeError && error.code === 'youtube_fetch_unavailable'
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Innertube fetch follows no more than three approved redirects', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: {
        Location: `https://www.youtube.com/youtubei/v1/player?redirect=${calls}`,
      },
    });
  };

  try {
    await assert.rejects(
      () =>
        createInnertubeFetch(Date.now() + 1_000)(
          'https://www.youtube.com/youtubei/v1/player'
        ),
      (error: unknown) =>
        error instanceof YouTubeError && error.code === 'youtube_fetch_unavailable'
    );
    assert.equal(calls, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Innertube redirects cannot reset the shared request deadline', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = originalNow();
  const deadline = now + 1_000;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    now = deadline;
    return new Response(null, {
      status: 302,
      headers: { Location: 'https://www.youtube.com/youtubei/v1/player?redirect=1' },
    });
  };
  Date.now = () => now;

  try {
    await assert.rejects(
      () =>
        createInnertubeFetch(deadline)(
          'https://www.youtube.com/youtubei/v1/player'
        ),
      (error: unknown) =>
        error instanceof YouTubeError && error.code === 'youtube_fetch_timeout'
    );
    assert.equal(calls, 1);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});

test('Innertube fetch bounds internal control responses before library parsing', async () => {
  const originalFetch = globalThis.fetch;
  let canceled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          throw new Error('oversized provider body must not be read');
        },
        cancel() {
          canceled = true;
        },
      }),
      { headers: { 'Content-Length': String(16 * 1024 * 1024 + 1) } }
    );

  try {
    await assert.rejects(
      () =>
        createInnertubeFetch(Date.now() + 1_000)(
          'https://youtubei.googleapis.com/youtubei/v1/player'
        ),
      (error: unknown) =>
        error instanceof YouTubeError && error.code === 'youtube_fetch_unavailable'
    );
    assert.equal(canceled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate fallback authenticates the output download and validates M4A bytes', async () => {
  const originalFetch = globalThis.fetch;
  const audio = makeM4a();
  const requests: Array<{ url: string; headers: Headers }> = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, headers });
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal instanceof AbortSignal);

    if (url.endsWith('/predictions')) {
      assert.equal(headers.get('prefer'), 'wait=60');
      assert.equal(headers.get('cancel-after'), '4m');
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.version, TEST_VERSION);
      assert.equal(payload.input.url, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
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
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate fallback rejects a successful prediction that returns HTML', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = String(input);
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

test('Replicate fallback refuses redirects without forwarding its bearer token', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { Location: 'https://example.com/steal-token' },
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
        error instanceof YouTubeError && error.code === 'youtube_fetch_unavailable'
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate fallback rejects an oversized prediction response before parsing it', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('{}', {
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(64 * 1024 + 1),
      },
    });

  try {
    await assert.rejects(
      () =>
        fetchViaReplicate(
          'https://www.youtube.com/watch?v=jNQXAC9IVRw',
          TEST_ENV as never
        ),
      (error: unknown) =>
        error instanceof YouTubeError && error.code === 'youtube_fetch_unavailable'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate fallback rejects malformed prediction identity', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      id: '../another-endpoint',
      status: 'succeeded',
      output: {
        audio: 'https://audio.replicate.delivery/fetched.m4a',
        title: 'Track',
        duration: 19,
      },
    });

  try {
    await assert.rejects(
      () =>
        fetchViaReplicate(
          'https://www.youtube.com/watch?v=jNQXAC9IVRw',
          TEST_ENV as never
        ),
      (error: unknown) =>
        error instanceof YouTubeError && error.code === 'youtube_fetch_unavailable'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate fallback rejects an oversized declared audio body before buffering', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('/predictions')) {
      return Response.json({
        id: 'yt-prediction',
        status: 'succeeded',
        output: {
          audio: 'https://audio.replicate.delivery/fetched.m4a',
          title: 'Track',
          duration: 19,
        },
      });
    }
    return new Response(null, {
      headers: {
        'Content-Type': 'audio/mp4',
        'Content-Length': String(100 * 1024 * 1024 + 1),
      },
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
        error instanceof YouTubeError && error.code === 'audio_too_large'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Replicate four-minute budget includes the output download', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_000;
  let calls = 0;
  Date.now = () => now;
  globalThis.fetch = async () => {
    calls += 1;
    now += 4 * 60 * 1000 + 1;
    return Response.json({
      id: 'yt-prediction',
      status: 'succeeded',
      output: {
        audio: 'https://audio.replicate.delivery/fetched.m4a',
        title: 'Track',
        duration: 19,
      },
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
        error instanceof YouTubeError && error.code === 'youtube_fetch_timeout'
    );
    assert.equal(calls, 1);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});

test('Replicate output headers and body share the remaining four-minute budget', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const audio = makeM4a();
  let now = 1_000;
  let calls = 0;
  Date.now = () => now;
  globalThis.fetch = async (input) => {
    calls += 1;
    if (String(input).endsWith('/predictions')) {
      now += 3 * 60 * 1000;
      return Response.json({
        id: 'yt-prediction',
        status: 'succeeded',
        output: {
          audio: 'https://audio.replicate.delivery/fetched.m4a',
          title: 'Track',
          duration: 19,
        },
      });
    }
    now += 60 * 1000 + 1;
    return new Response(audio, {
      headers: {
        'Content-Type': 'audio/mp4',
        'Content-Length': String(audio.byteLength),
      },
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
        error instanceof YouTubeError && error.code === 'youtube_fetch_timeout'
    );
    assert.equal(calls, 2);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});

test('Replicate four-minute budget includes a stalled prediction response body', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_000;
  let calls = 0;
  Date.now = () => now;
  globalThis.fetch = async () => {
    calls += 1;
    now += 4 * 60 * 1000 - 10;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => undefined);
        },
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  };

  try {
    await assert.rejects(
      () =>
        fetchViaReplicate(
          'https://www.youtube.com/watch?v=jNQXAC9IVRw',
          TEST_ENV as never
        ),
      (error: unknown) =>
        error instanceof YouTubeError && error.code === 'youtube_fetch_timeout'
    );
    assert.equal(calls, 1);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});

test('Replicate YouTube fetch refuses an unpinned model without making a provider request', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('must not fetch');
  };
  try {
    for (const version of [undefined, 'latest', 'pinned-version-id', `${TEST_VERSION} `]) {
      await assert.rejects(
        () =>
          fetchViaReplicate('https://www.youtube.com/watch?v=jNQXAC9IVRw', {
            REPLICATE_API_TOKEN: TEST_TOKEN,
            REPLICATE_YT_MODEL: 'test/yt-audio',
            REPLICATE_YT_MODEL_VERSION: version,
          } as never),
        (error: unknown) =>
          error instanceof YouTubeError && error.code === 'youtube_fetch_unavailable'
      );
    }
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function makeM4a(size = 2048): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
  return bytes;
}
