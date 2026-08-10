import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ArchiveError,
  fetchArchiveAudio,
  fetchArchiveItem,
  isArchiveScope,
  parseArchiveIdentifier,
} from '../src/archive.ts';

const IDENTIFIER = 'open-audio-test';
const FILE_NAME = 'track.mp3';
const OPEN_LICENSE = 'https://creativecommons.org/licenses/by/4.0/';

function metadataResponse(
  overrides: Record<string, unknown> = {},
  files: Array<Record<string, unknown>> = [
    { name: FILE_NAME, title: 'Track', size: '2048', length: '20' },
  ]
): Response {
  return Response.json({
    metadata: {
      title: 'Open item',
      creator: 'Classroom artist',
      licenseurl: OPEN_LICENSE,
      ...overrides,
    },
    files,
  });
}

function makeMp3(size = 2048): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xfb, 0x90, 0x64]);
  return bytes;
}

test('Archive parsers refuse malformed identifiers and inherited scope names', () => {
  assert.equal(parseArchiveIdentifier('https://archive.org/details/%E0%A4%A'), null);
  assert.equal(isArchiveScope('toString'), false);
  assert.equal(isArchiveScope('music'), true);
});

test('Archive direct import enforces the same open-license floor as search', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return metadataResponse({ licenseurl: 'https://example.com/custom-terms' });
  };

  try {
    await assert.rejects(
      () => fetchArchiveAudio(IDENTIFIER, FILE_NAME, {} as never),
      (error: unknown) =>
        error instanceof ArchiveError && error.code === 'license_not_open'
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Archive import follows only bounded HTTPS redirects inside archive.org', async () => {
  const originalFetch = globalThis.fetch;
  const audio = makeMp3();
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal instanceof AbortSignal);
    if (url === `https://archive.org/metadata/${IDENTIFIER}`) {
      return metadataResponse();
    }
    if (url === `https://archive.org/download/${IDENTIFIER}/${FILE_NAME}`) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `https://dn.example.archive.org/0/items/${IDENTIFIER}/${FILE_NAME}`,
        },
      });
    }
    if (url === `https://dn.example.archive.org/0/items/${IDENTIFIER}/${FILE_NAME}`) {
      return new Response(audio, {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(audio.byteLength),
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await fetchArchiveAudio(IDENTIFIER, FILE_NAME, {} as never);
    assert.deepEqual(new Uint8Array(result.data), audio);
    assert.deepEqual(requests, [
      `https://archive.org/metadata/${IDENTIFIER}`,
      `https://archive.org/download/${IDENTIFIER}/${FILE_NAME}`,
      `https://dn.example.archive.org/0/items/${IDENTIFIER}/${FILE_NAME}`,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Archive import refuses a cross-origin provider redirect', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    if (String(input).includes('/metadata/')) return metadataResponse();
    return new Response(null, {
      status: 302,
      headers: { Location: 'https://example.com/not-archive.mp3' },
    });
  };

  try {
    await assert.rejects(
      () => fetchArchiveAudio(IDENTIFIER, FILE_NAME, {} as never),
      (error: unknown) =>
        error instanceof ArchiveError && error.code === 'archive_untrusted_redirect'
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Archive retry attempts share one request deadline', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_000;
  let calls = 0;
  Date.now = () => now;
  globalThis.fetch = async () => {
    calls += 1;
    now += 20 * 1000;
    return new Response(null, { status: 503 });
  };

  try {
    await assert.rejects(
      () => fetchArchiveItem(IDENTIFIER),
      (error: unknown) =>
        error instanceof ArchiveError && error.code === 'archive_busy'
    );
    assert.equal(calls, 1);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});

test('Archive import rejects mislabeled non-audio bytes', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes('/metadata/')) return metadataResponse();
    return new Response(new Uint8Array(2048), {
      headers: { 'Content-Type': 'audio/mpeg' },
    });
  };

  try {
    await assert.rejects(
      () => fetchArchiveAudio(IDENTIFIER, FILE_NAME, {} as never),
      (error: unknown) =>
        error instanceof ArchiveError && error.code === 'invalid_audio_response'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Archive metadata picks the best-ranked derivative independent of API order', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    metadataResponse({}, [
      { name: 'track.ogg', title: 'Track Ogg', size: '2048', length: '20' },
      { name: 'track.mp3', title: 'Track MP3', size: '2048', length: '20' },
    ]);

  try {
    const item = await fetchArchiveItem(IDENTIFIER);
    assert.equal(item.tracks.length, 1);
    assert.equal(item.tracks[0].name, 'track.mp3');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Archive metadata does not let an incomplete preferred format hide a usable derivative', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    metadataResponse({}, [
      { name: 'track.mp3', title: 'Incomplete MP3', size: '2048', length: '' },
      { name: 'track.ogg', title: 'Usable Ogg', size: '2048', length: '20' },
    ]);

  try {
    const item = await fetchArchiveItem(IDENTIFIER);
    assert.equal(item.tracks.length, 1);
    assert.equal(item.tracks[0].name, 'track.ogg');
    assert.equal(item.tracks[0].importable, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Archive direct import refuses missing duration metadata', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return metadataResponse({}, [
      { name: FILE_NAME, title: 'Track', size: '2048', length: '' },
    ]);
  };

  try {
    await assert.rejects(
      () => fetchArchiveAudio(IDENTIFIER, FILE_NAME, {} as never),
      (error: unknown) =>
        error instanceof ArchiveError && error.code === 'track_metadata_incomplete'
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
