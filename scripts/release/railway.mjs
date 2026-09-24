import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, verifyCurrentRelease } from './verify-source.mjs';

export const target = Object.freeze({ project: 'f070742b-3375-4cba-9a86-335f39273c88', environment: 'b3381640-1e2f-4765-8e15-15baec599ec2', service: 'f53a2915-087c-493a-a345-7a1fa73e6588' });
const scope = ['--project', target.project, '--environment', target.environment, '--service', target.service];
export function parseRailwayJson(text) {
  try { return JSON.parse(text); }
  catch { throw new Error('Railway returned an unreadable response. Raw output is withheld because it may contain private configuration.'); }
}
export function validateConfiguration(vars) {
  for (const key of ['NODE_AUTH_TOKEN', 'CAIL_IDENTITY_JWKS', 'CAIL_READINESS_TOKEN', 'WEBHOOK_SECRET', 'CLASS_CODE']) {
    if (typeof vars[key] !== 'string' || !vars[key].trim()) throw new Error(`Railway configuration is missing ${key}.`);
  }
  if (vars.DATA_DIR !== '/data' || vars.CAIL_GATEWAY_URL !== 'https://tools.ailab.gc.cuny.edu' ||
      vars.CAIL_IDENTITY_ISSUER !== 'https://tools.ailab.gc.cuny.edu/cail-sso' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(vars.ASSISTANT_MODEL || '')) {
    throw new Error('Railway data or fleet configuration does not match the release contract.');
  }
  const origin = new URL(vars.PUBLIC_BASE_URL || `https://${vars.RAILWAY_PUBLIC_DOMAIN}`);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || origin.hostname === 'undefined') throw new Error('Railway public origin is invalid.');
  return new URL('/api/fleet/readyz', origin).href;
}
export function deploymentState(deployments, id) {
  const deployment = deployments.find(item => item.id === id);
  if (!deployment) throw new Error('Submitted Railway deployment is missing; do not retry the upload.');
  if (['QUEUED', 'INITIALIZING', 'WAITING', 'BUILDING', 'DEPLOYING'].includes(deployment.status)) return 'pending';
  if (deployment.status !== 'SUCCESS') throw new Error(`Railway deployment ended at ${deployment.status}; do not retry the upload.`);
  if (deployments.filter(item => item.status === 'SUCCESS').length !== 1) throw new Error('Railway still reports more than one active version.');
  return 'success';
}
function run(command, args, options = {}) {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options }); }
  catch { throw new Error(`Release command failed: ${command}. Inspect the scoped deployment; no automatic retry was made.`); }
}
async function main() {
  if (!process.env.RAILWAY_TOKEN) throw new Error('A project-scoped Railway deployment token is required.');
  const sha = await verifyCurrentRelease(config);
  // Inspect in memory only. Never print Railway variable values or retain them.
  const vars = parseRailwayJson(run('railway', ['variable', 'list', '--json', ...scope]));
  const readinessUrl = validateConfiguration(vars);
  const stage = mkdtempSync(join(tmpdir(), 'stem-release-'));
  try {
    const archive = join(stage, 'source.tar');
    const source = join(stage, 'source');
    run('mkdir', [source]);
    run('git', ['archive', '--format=tar', '--output', archive, sha]);
    run('tar', ['-xf', archive, '-C', source]);
    // The placeholder is source configuration, never the CI token. Railpack
    // resolves the existing read-only package token stored on this service.
    writeFileSync(join(source, '.npmrc'), '@cuny-ai-lab:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n', { mode: 0o600 });
    await verifyCurrentRelease(config); // Reject a queued SHA superseded while preparing.
    run('railway', ['variable', 'set', `CAIL_SOURCE_VERSION=${sha}`, '--skip-deploys', ...scope]);
    const uploaded = parseRailwayJson(run('railway', ['up', source, '--path-as-root', '--no-gitignore', '--detach', '--json', '--message', `CI fleet release ${sha}`, ...scope]));
    const id = uploaded.deploymentId;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Upload outcome is uncertain; inspect Railway before retrying.');
    console.log(`Submitted Railway deployment ${id} from ${sha}.`);
    const until = Date.now() + 20 * 60 * 1000;
    for (;;) {
      const deployments = parseRailwayJson(run('railway', ['deployment', 'list', '--limit', '20', '--json', ...scope]));
      if (deploymentState(deployments, id) === 'success') break;
      if (Date.now() > until) throw new Error(`Deployment ${id} is still pending; inspect it before retrying.`);
      await new Promise(resolve => setTimeout(resolve, 15000));
    }
    const denied = await fetch(readinessUrl, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (denied.status !== 401) throw new Error('Private readiness did not reject an anonymous request.');
    await denied.body?.cancel();
    const response = await fetch(readinessUrl, { headers: { Authorization: `Bearer ${vars.CAIL_READINESS_TOKEN}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    const ready = await response.json();
    if (!response.ok || ready.ready !== true || ready.sourceVersion !== sha || ready.audience !== 'cail:stem-splitter') throw new Error('Private readiness did not verify the exact deployed source.');
    console.log(`Verified one active Railway deployment ${id}, exact source ${sha}, and private readiness. Signed-in model and audio acceptance remains separate.`);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
