import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('./install-media-tools.sh', import.meta.url));

function install({ preinstalled = false, failure = 'none' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'stem-media-install-'));
  const bin = join(root, 'bin'), calls = join(root, 'calls');
  mkdirSync(bin); writeFileSync(calls, '');
  const script = (name, value) => writeFileSync(join(bin, name), `#!/bin/bash\n${value}`, { mode: 0o755 });
  script('timeout', 'shift 2\nexec "$@"\n');
  script('sudo', `printf '%s\\n' "$*" >> "$CALLS"
case " $* " in
  *" install "*)
    if [[ "$FAILURE" == always || ( "$FAILURE" == first && ! -f "$FIXTURE_BIN/attempted" ) ]]; then
      : > "$FIXTURE_BIN/attempted"
      exit 1
    fi
    printf '#!/bin/bash\\necho fixture-ffmpeg\\n' > "$FIXTURE_BIN/ffmpeg"
    /bin/chmod +x "$FIXTURE_BIN/ffmpeg"
    ;;
esac
`);
  if (preinstalled) script('ffmpeg', 'echo fixture-ffmpeg\n');
  try {
    const result = spawnSync('/bin/bash', [installer, 'ffmpeg'], { encoding: 'utf8', timeout: 3000,
      env: { PATH: bin, CALLS: calls, FIXTURE_BIN: bin, FAILURE: failure, GITHUB_ACTIONS: 'false' } });
    return { ...result, calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('an installed FFmpeg needs no package operations', () => {
  const result = install({ preinstalled: true });
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, []);
});

test('a usable runner package index avoids metadata refresh', () => {
  const result = install();
  assert.equal(result.status, 0);
  assert.equal(result.calls.length, 1);
  assert.match(result.calls[0], /install --yes --no-install-recommends ffmpeg/);
});

test('stale package metadata falls back to update and installation', () => {
  const result = install({ failure: 'first' });
  assert.equal(result.status, 0);
  assert.equal(result.calls.length, 3);
  assert.match(result.calls[1], / update$/);
  assert.match(result.calls[2], / install /);
});

test('exhausted installation attempts fail the job', () => {
  const result = install({ failure: 'always' });
  assert.equal(result.status, 1);
  assert.equal(result.calls.filter(call => / install /.test(call)).length, 3);
  assert.equal(result.calls.filter(call => / update$/.test(call)).length, 2);
  assert.match(result.stderr, /Required media dependency is unavailable/);
});
