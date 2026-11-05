import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, lstatSync, readlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export function options(args) {
  const result = { target: 'dev', mode: 'deploy' };
  if (['dev', 'production'].includes(args[0])) result.target = args.shift();
  while (args.length) {
    const arg = args.shift();
    if (['--plan', '--check'].includes(arg) && result.mode === 'deploy') result.mode = arg.slice(2);
    else if (['--dev-receipt', '--acceptance'].includes(arg) && args[0] && !args[0].startsWith('--')) result[arg.slice(2)] = args.shift();
    else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  return result;
}
export function validateDev(receipt, project, sha, tree) {
  if (receipt.project !== project || receipt.target !== 'dev' || receipt.source !== sha || receipt.tree !== tree || receipt.status !== 'verified' || !receipt.version)
    throw new Error('Production requires a verified Dev receipt for this exact commit and tree.');
}
export function activeVersion(deployments, version) {
  const latest = [...deployments].sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0];
  if (!latest || latest.versions?.length !== 1 || latest.versions[0].version_id !== version || latest.versions[0].percentage !== 100) throw new Error('Deployment traffic does not match the uploaded version.');
}
export function deployment(output, worker) {
  const rows = output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const row = rows.findLast(row => row.type === 'deploy');
  if (row?.worker_name !== worker || !/^[0-9a-f-]{36}$/.test(row?.version_id || '')) throw new Error('Missing or mismatched Wrangler deployment receipt.');
  return row.version_id;
}
const digest = value => createHash('sha256').update(value).digest('hex');
function run(argv, cwd, env, capture = false) {
  console.log(`> ${argv.join(' ')}`);
  const result = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Command failed: ${argv[0]} ${argv[1] || ''}`);
  return capture ? result.stdout.trim() : '';
}
export async function release(root, args) {
  const opt = options([...args]);
  const policy = JSON.parse(readFileSync(join(root, 'scripts/local-release/config.json')));
  const target = policy.targets[opt.target];
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: policy.account, CI: 'true', WRANGLER_SEND_METRICS: 'false' };
  // Never let a caller redirect the deployment log or load an alternate config.
  delete env.WRANGLER_OUTPUT_FILE_PATH; delete env.WRANGLER_OUTPUT_FILE_DIRECTORY;
  const git = (...a) => run(['git', ...a], root, env, true);
  const source = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  if (opt.mode === 'plan') { console.log(JSON.stringify({ project: policy.project, ...opt, source, tree, ...target, checks: policy.checks, githubPush: false }, null, 2)); return; }
  if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('Commit your intended changes locally and use a clean checkout. No GitHub push is required.');
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== policy.account) throw new Error('Unexpected Cloudflare account override.');
  if (opt.target === 'production' && opt.mode === 'deploy') {
    if (!opt['dev-receipt'] || !opt.acceptance) throw new Error('Use --dev-receipt <receipt.json> and --acceptance <Dev verification notes> for production.');
    validateDev(JSON.parse(readFileSync(resolve(opt['dev-receipt']))), policy.project, source, tree);
    if (readFileSync(resolve(opt.acceptance), 'utf8').trim().length < 20) throw new Error('Record the actual signed-in Dev acceptance results before production.');
  }
  const lock = resolve(root, '.local-releases', `${opt.target}.lock`);
  mkdirSync(dirname(lock), { recursive: true });
  mkdirSync(lock); // Atomic: a second local release cannot race this target.
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${opt.target}-${source.slice(0, 12)}`;
  const dir = resolve(root, '.local-releases', id);
  const snapshot = join(dir, 'source');
  const receipt = { project: policy.project, target: opt.target, source, tree, worker: target.worker, origin: target.origin, status: 'preparing', checks: [], startedAt: new Date().toISOString(), authenticatedAcceptance: 'separate verification required' };
  const save = () => writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  try {
    mkdirSync(snapshot, { recursive: true });
    save();
    git('archive', '--format=tar', `--output=${join(dir, 'source.tar')}`, source);
    receipt.sourceArchiveSha256 = digest(readFileSync(join(dir, 'source.tar')));
    // Keep the commit reachable even if the development branch later moves.
    git('update-ref', `refs/local-releases/${id}`, source);
    run(['tar', '-xf', join(dir, 'source.tar'), '-C', snapshot], root, env);
    const files = git('ls-tree', '-rz', '--name-only', source).split('\0').filter(Boolean);
    const hashes = () => Object.fromEntries(files.map(p => {
      const f = join(snapshot, p);
      if (!existsSync(f)) throw new Error(`Archived source file missing: ${p}`);
      return [p, digest(lstatSync(f).isSymbolicLink() ? readlinkSync(f) : readFileSync(f))];
    }));
    const sourceHashes = hashes();
    const configDir = join(snapshot, target.cwd);
    const configPath = join(configDir, target.config);
    // JSONC configs here use full-line comments only. Wrangler performs full validation below.
    const config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
    if (config.name !== target.worker || config.account_id !== policy.account) throw new Error('Worker/account does not match the approved target.');
    if (policy.project === 'stem-splitter' && config.main !== 'worker.ts') throw new Error('Only the current Cloudflare Stem adapter may deploy.');
    if (policy.project === 'systems-mapping') {
      // Registry settings contain a literal env reference, never a saved token.
      const npmrc = join(dir, 'registry.npmrc');
      writeFileSync(npmrc, '@cuny-ai-lab:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n');
      if (!env.NODE_AUTH_TOKEN) throw new Error('Set NODE_AUTH_TOKEN for the pinned private GitHub packages; it is used only by the local install.');
      env.npm_config_userconfig = npmrc;
      receipt.optionalPostgres = env.TEST_POSTGRES_URL ? 'enabled' : 'skipped: separate Node/PostgreSQL host; not a Cloudflare storage test';
    }
    for (const step of policy.install) run(step.command, join(snapshot, step.cwd), env);
    for (const step of policy.checks) {
      run(step.command, join(snapshot, step.cwd), { ...env, ...step.env });
      receipt.checks.push({ command: step.command, status: 'passed' }); save();
    }
    const wrangler = resolve(configDir, 'node_modules/.bin/wrangler');
    const cf = (...a) => [wrangler, ...a, '--config', target.config];
    const deployArgs = ['deploy', '--var', `RELEASE:${source}`];
    run(cf(...deployArgs, '--dry-run', '--outdir', join(dir, 'bundle')), configDir, env);
    if (JSON.stringify(hashes()) !== JSON.stringify(sourceHashes)) throw new Error('A check modified tracked source; refusing to deploy.');
    receipt.status = 'checked'; save();
    if (opt.mode === 'check') return;
    if (opt.target === 'production') {
      // Dev must still be serving the exact version we accepted.
      await verify(policy, policy.targets.dev.origin, source);
      receipt.devReceipt = resolve(opt['dev-receipt']);
      receipt.acceptanceSha256 = digest(readFileSync(resolve(opt.acceptance)));
    }
    run(cf('whoami'), configDir, env);
    receipt.before = JSON.parse(run(cf('deployments', 'list', '--json'), configDir, env, true));
    receipt.status = 'deploying'; save();
    const structured = join(dir, 'wrangler.ndjson');
    run(cf(...deployArgs), configDir, { ...env, WRANGLER_OUTPUT_FILE_PATH: structured });
    receipt.version = deployment(readFileSync(structured, 'utf8'), target.worker);
    receipt.status = 'uploaded'; save();
    receipt.after = JSON.parse(run(cf('deployments', 'list', '--json'), configDir, env, true));
    activeVersion(receipt.after, receipt.version);
    await verify(policy, target.origin, source);
    receipt.status = 'verified';
    receipt.completedAt = new Date().toISOString(); save();
  } catch (error) {
    receipt.failedAt = new Date().toISOString();
    receipt.failureStage = receipt.status;
    receipt.status = 'failed'; save();
    throw error;
  } finally {
    // Retain the immutable archive and bundle, not another dependency tree per release.
    if (['checked', 'verified'].includes(receipt.status)) rmSync(snapshot, { recursive: true, force: true });
    rmSync(lock, { recursive: true });
    console.log(`Release record: ${join(dir, 'receipt.json')}`);
  }
}
export async function verify(policy, origin, sha, request = fetch) {
  const res = await request(origin + policy.health, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const body = await res.json();
  if (!res.ok || body.release !== sha || (policy.project === 'stem-splitter' ? body.ok !== true || body.authMode !== 'cail' : body.status !== 'ok' || body.auth !== 'cuny' || body.storage !== 'isolated-cloudflare')) throw new Error('Live health or source marker does not match.');
  const denied = await request(origin + policy.protected, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if (denied.status !== 401 || !denied.headers.get('cache-control')?.includes('no-store')) throw new Error('Anonymous access did not fail closed.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  release(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
