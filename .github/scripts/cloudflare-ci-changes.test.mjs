import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFiles, classifyChanges, canReuseReceipt, verifiedMergeRun } from './cloudflare-ci-changes.mjs';

test('documentation changes skip expensive checks, including on pushes', () => {
  for (const eventName of ['pull_request', 'push']) {
    assert.deepEqual(classifyChanges(['README.md', 'docs/classroom-access.md'], { eventName }),
      { required: false, browsers: false });
  }
});

test('runtime, configuration, fixture and mixed changes keep verification', () => {
  for (const path of ['public/app.js', 'cloudflare/worker.ts', 'schema.sql',
    'bun.lock', '.github/workflows/cloudflare-candidate.yml',
    'tests/fixtures/audio/source.wav', 'unexpected/new-file']) {
    assert.deepEqual(classifyChanges(['docs/note.md', path], { eventName: 'pull_request' }),
      { required: true, browsers: true }, path);
  }
});

test('draft PRs keep fast checks; ready PRs and direct pushes run browsers', () => {
  assert.deepEqual(classifyChanges(['public/app.js'], { eventName: 'pull_request', draft: true }),
    { required: true, browsers: false });
  for (const eventName of ['pull_request', 'push']) {
    assert.equal(classifyChanges(['public/app.js'], { eventName }).browsers, true);
  }
});

test('unknown or missing history requests full verification', () => {
  assert.deepEqual(classifyChanges(null, { eventName: 'push' }), { required: true, browsers: true });
  assert.equal(changedFiles({ base: '0'.repeat(40), head: 'a'.repeat(40) }), null);
  assert.equal(changedFiles({ base: 'a'.repeat(40), head: 'b'.repeat(40) }, () => { throw Error('missing'); }), null);
});

test('real Git ranges include deleted paths and documentation renamed into source', () => {
  const root = mkdtempSync(join(tmpdir(), 'stem-ci-changes-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.name', 'CI fixture');
    git('config', 'user.email', 'ci@example.invalid');
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'note.md'), 'fixture\n');
    writeFileSync(join(root, 'old.js'), 'old\n');
    git('add', '.'); git('commit', '-qm', 'fixture base');
    const base = git('rev-parse', 'HEAD').trim();
    git('mv', 'docs/note.md', 'source.js'); git('rm', '-q', 'old.js');
    git('commit', '-qm', 'fixture rename and delete');
    const head = git('rev-parse', 'HEAD').trim();
    const files = changedFiles({ base, head }, (_command, args) => git(...args));
    assert.deepEqual(files.sort(), ['docs/note.md', 'old.js', 'source.js']);
    assert.equal(classifyChanges(files, { eventName: 'pull_request' }).browsers, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('only a successful full browser check for the identical tree can be reused', () => {
  const context = { repository: 'CUNY-AI-Lab/stem-splitter', head: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const run = { event: 'pull_request', conclusion: 'success',
    path: '.github/workflows/cloudflare-candidate.yml', head_sha: context.head,
    head_repository: { full_name: context.repository } };
  const receipt = { version: 1, repository: context.repository, head: context.head,
    tree: context.tree, browsers: ['chrome', 'firefox'] };
  assert.equal(canReuseReceipt(run, receipt, context), true);
  for (const change of [{ tree: 'c'.repeat(40) }, { head: 'c'.repeat(40) },
    { repository: 'another/repo' }, { browsers: ['chrome'] }, { version: 2 }]) {
    assert.equal(canReuseReceipt(run, { ...receipt, ...change }, context), false);
  }
  for (const change of [{ conclusion: 'failure' }, { event: 'push' },
    { path: 'another.yml' }, { head_sha: 'c'.repeat(40) },
    { head_repository: { full_name: 'another/repo' } }]) {
    assert.equal(canReuseReceipt({ ...run, ...change }, receipt, context), false);
  }
  assert.equal(canReuseReceipt(run, null, context), false);
});

test('merge lookup downloads a receipt and rejects a changed tree or missing artifact', () => {
  const repository = 'CUNY-AI-Lab/stem-splitter', head = 'c'.repeat(40),
    source = 'a'.repeat(40), tree = 'b'.repeat(40);
  let changedTree = false, missing = false;
  const run = { id: 123, event: 'pull_request', conclusion: 'success',
    path: '.github/workflows/cloudflare-candidate.yml', head_sha: source,
    head_repository: { full_name: repository } };
  const command = (tool, args) => {
    if (tool === 'git') return args[0] === 'show' ? `${'d'.repeat(40)} ${source}\n` : tree;
    if (args[0] === 'api') return JSON.stringify({ workflow_runs: [run] });
    assert.equal(args[args.indexOf('--name') + 1], `cloudflare-browser-checks-${source}`);
    if (missing) throw Error('artifact expired');
    const directory = args[args.indexOf('--dir') + 1];
    writeFileSync(join(directory, 'cloudflare-ci-receipt.json'), JSON.stringify({ version: 1,
      repository, head: source, tree: changedTree ? 'f'.repeat(40) : tree,
      browsers: ['chrome', 'firefox'] }));
    return '';
  };
  assert.equal(verifiedMergeRun({ repository, head }, command), 123);
  changedTree = true;
  assert.equal(verifiedMergeRun({ repository, head }, command), null);
  missing = true;
  assert.equal(verifiedMergeRun({ repository, head }, command), null);
});

test('direct commits and GitHub outages keep fresh browser checks', () => {
  const context = { repository: 'CUNY-AI-Lab/stem-splitter', head: 'a'.repeat(40) };
  assert.equal(verifiedMergeRun(context, () => 'b'.repeat(40)), null);
  assert.equal(verifiedMergeRun(context, () => { throw Error('unavailable'); }), null);
});
