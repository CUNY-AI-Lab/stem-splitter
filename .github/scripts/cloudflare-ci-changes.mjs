import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Keep the workflow's check present for documentation PRs. Skipping the entire
// workflow can leave required checks pending; skipping its expensive steps does not.
export function classifyChanges(files, { eventName, draft = false } = {}) {
  const documentationOnly = files !== null && files.every(path =>
    path.startsWith('docs/') || /^[^/]+\.md$/i.test(path)
  );
  const required = !documentationOnly;
  return { required, browsers: required && !(eventName === 'pull_request' && draft) };
}

export function changedFiles({ base, head }, git = execFileSync) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || /^0+$/.test(base) ||
      !/^[a-f0-9]{40}$/.test(head ?? '')) return null;
  try {
    // Include both sides of renames, so moving documentation into runtime code
    // cannot hide the new source path from the decision.
    return git('git', ['diff', '--no-renames', '--name-only', '-z', base, head, '--'],
      { encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    // Missing history or an unfamiliar event gets the full checks.
    return null;
  }
}

const workflowPath = '.github/workflows/cloudflare-candidate.yml';
const receiptName = head => `cloudflare-browser-checks-${head}`;

export function canReuseReceipt(run, receipt, { repository, head, tree }) {
  return run.event === 'pull_request' && run.conclusion === 'success' &&
    run.path === workflowPath && run.head_sha === head &&
    run.head_repository?.full_name === repository &&
    receipt?.version === 1 && receipt.repository === repository &&
    receipt.head === head && receipt.tree === tree &&
    JSON.stringify(receipt.browsers) === JSON.stringify(['chrome', 'firefox']);
}

export function verifiedMergeRun({ repository, head }, command = execFileSync) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^[a-f0-9]{40}$/.test(head ?? '')) return null;
  const call = (tool, args) => command(tool, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1048576 });
  try {
    const parents = call('git', ['show', '-s', '--format=%P', head]).trim().split(' ');
    if (parents.length !== 2) return null;
    const sourceHead = parents[1];
    const tree = call('git', ['rev-parse', `${head}^{tree}`]).trim();
    const { workflow_runs: runs } = JSON.parse(call('gh', [
      'api', `repos/${repository}/actions/workflows/cloudflare-candidate.yml/runs`,
      '--method', 'GET', '-f', 'event=pull_request', '-f', `head_sha=${sourceHead}`,
      '-f', 'status=success', '-f', 'per_page=5',
    ]));
    for (const run of runs ?? []) {
      if (!Number.isSafeInteger(run.id) || run.id < 1) continue;
      const directory = mkdtempSync(join(tmpdir(), 'stem-ci-receipt-'));
      try {
        call('gh', ['run', 'download', String(run.id), '--repo', repository,
          '--name', receiptName(sourceHead), '--dir', directory]);
        const receipt = JSON.parse(readFileSync(join(directory, 'cloudflare-ci-receipt.json'), 'utf8'));
        if (canReuseReceipt(run, receipt, { repository, head: sourceHead, tree })) return run.id;
      } catch {
        // An absent, expired or invalid receipt requires fresh browser checks.
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  } catch {
    // GitHub unavailability and missing history require fresh browser checks.
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'receipt') {
    writeFileSync(process.argv[3], JSON.stringify({
      version: 1,
      repository: process.env.GITHUB_REPOSITORY,
      head: process.env.CI_SOURCE_HEAD,
      tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
      browsers: ['chrome', 'firefox'],
    }, null, 2));
    process.exit(0);
  }
  const files = changedFiles({ base: process.env.CI_BASE_SHA, head: process.env.CI_HEAD_SHA });
  const result = classifyChanges(files, {
    eventName: process.env.GITHUB_EVENT_NAME,
    draft: process.env.CI_PULL_REQUEST_DRAFT === 'true',
  });
  const reusedRun = result.browsers && process.env.GITHUB_EVENT_NAME === 'push'
    ? verifiedMergeRun({ repository: process.env.GITHUB_REPOSITORY, head: process.env.CI_HEAD_SHA }) : null;
  if (reusedRun) result.browsers = false;
  for (const [key, value] of Object.entries(result)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  console.log(JSON.stringify({ ...result, reusedRun, changedFiles: files }, null, 2));
}
