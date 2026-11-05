import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { options, validateDev, deployment, activeVersion, verify, release } from './deploy.mjs';
const sha = 'a'.repeat(40), tree = 'b'.repeat(40), version = '11111111-1111-1111-1111-111111111111';
test('defaults to Dev and rejects ambiguous/unknown deployment options', () => {
  assert.deepEqual(options([]), { target: 'dev', mode: 'deploy' });
  assert.equal(options(['production', '--check']).mode, 'check');
  for (const args of [['prod'], ['--dev-receipt'], ['--plan', '--check'], ['--force']]) assert.throws(() => options(args));
});
test('production requires exact verified Dev project, commit and tree', () => {
  const r = { project: 'stem-splitter', target: 'dev', source: sha, tree, status: 'verified', version };
  validateDev(r, r.project, sha, tree);
  for (const change of [{ source: 'c'.repeat(40) }, { tree: 'c'.repeat(40) }, { status: 'checked' }, { target: 'production' }, { project: 'systems-mapping' }, { version: null }]) assert.throws(() => validateDev({ ...r, ...change }, r.project, sha, tree));
});
test('requires a structured upload receipt for the intended Worker', () => {
  const row = JSON.stringify({ type: 'deploy', worker_name: 'stem-splitter-dev', version_id: version });
  assert.equal(deployment(row, 'stem-splitter-dev'), version);
  assert.throws(() => deployment(row, 'cail-stem-splitter-preview'));
  assert.throws(() => deployment('{"type":"command-failed"}', 'stem-splitter-dev'));
});
test('requires latest deployment to send all traffic to the uploaded version', () => {
  const row = { created_on: '2026-11-05T00:00:00Z', versions: [{ version_id: version, percentage: 100 }] };
  activeVersion([row], version);
  assert.throws(() => activeVersion([], version));
  assert.throws(() => activeVersion([{ ...row, versions: [{ version_id: version, percentage: 50 }] }], version));
  assert.throws(() => activeVersion([row, { ...row, created_on: '2026-11-06T00:00:00Z', versions: [{ version_id: 'other', percentage: 100 }] }], version));
});
test('health mismatch and anonymous access both fail closed', async () => {
  const policy = { project: 'stem-splitter', health: '/healthz', protected: '/api/account' };
  const request = (body, status = 401, cache = 'private, no-store') => async url => url.endsWith('/healthz') ? Response.json(body) : new Response('', { status, headers: { 'cache-control': cache } });
  const good = { ok: true, release: sha, authMode: 'cail' };
  await verify(policy, 'https://example.invalid', sha, request(good));
  for (const body of [{ ...good, release: 'old' }, { ...good, authMode: 'none' }, { ...good, ok: false }]) await assert.rejects(verify(policy, 'https://example.invalid', sha, request(body)));
  await assert.rejects(verify(policy, 'https://example.invalid', sha, request(good, 200)));
  await assert.rejects(verify(policy, 'https://example.invalid', sha, request(good, 401, 'public')));
});
function fixture(t, mutate = false) {
  const root = mkdtempSync(join(tmpdir(), 'local-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q'); git('config', 'user.name', 'zmuhls'); git('config', 'user.email', '42992492+zmuhls@users.noreply.github.com');
  mkdirSync(join(root, 'scripts/local-release'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.local-releases/\n.env\n');
  writeFileSync(join(root, 'app.txt'), 'committed source');
  writeFileSync(join(root, '.env'), 'ignored fixture, not credentials');
  writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ name: 'fixture-dev', account_id: process.env.CLOUDFLARE_ACCOUNT_ID || 'test-account' }));
  const fake = '#!/bin/sh\ncase "$*" in *--dry-run*) exit 0;; *) exit 99;; esac\n';
  const install = `require('fs').mkdirSync('node_modules/.bin',{recursive:true});require('fs').writeFileSync('node_modules/.bin/wrangler', ${JSON.stringify(fake)}, {mode:0o755});`;
  const config = { project: 'fixture', account: process.env.CLOUDFLARE_ACCOUNT_ID || 'test-account', targets: { dev: { worker: 'fixture-dev', cwd: '.', config: 'wrangler.jsonc' } }, install: [{ cwd: '.', command: [process.execPath, '-e', install] }], checks: [{ cwd: '.', command: [process.execPath, '-e', mutate ? "require('fs').writeFileSync('app.txt','changed')" : "if(require('fs').existsSync('.env'))process.exit(1)"] }] };
  writeFileSync(join(root, 'scripts/local-release/config.json'), JSON.stringify(config));
  git('add', '.');
  assert.match(git('var', 'GIT_AUTHOR_IDENT'), /^zmuhls <42992492\+zmuhls@users.noreply.github.com>/);
  assert.match(git('var', 'GIT_COMMITTER_IDENT'), /^zmuhls <42992492\+zmuhls@users.noreply.github.com>/);
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  return root;
}
test('check runs against committed archive without ignored files or a deployment', async t => {
  const root = fixture(t);
  await release(root, ['--check']);
  const id = readdirSync(join(root, '.local-releases')).find(p => !p.endsWith('.lock'));
  const r = JSON.parse(readFileSync(join(root, '.local-releases', id, 'receipt.json')));
  assert.equal(r.status, 'checked'); assert.equal(r.version, undefined); assert.equal(r.checks.length, 1);
  assert.equal(existsSync(join(root, '.local-releases', id, 'source')), false);
  assert.equal(existsSync(join(root, '.local-releases', id, 'source.tar')), true);
});
test('dirty/untracked changes are rejected before any release work', async t => {
  const root = fixture(t); writeFileSync(join(root, 'uncommitted.txt'), 'new');
  await assert.rejects(release(root, ['--check']), /clean checkout/);
});
test('checks cannot silently change the deployed source', async t => {
  const root = fixture(t, true);
  await assert.rejects(release(root, ['--check']), /modified tracked source/);
  const id = readdirSync(join(root, '.local-releases')).find(p => !p.endsWith('.lock'));
  assert.equal(JSON.parse(readFileSync(join(root, '.local-releases', id, 'receipt.json'))).status, 'failed');
});
