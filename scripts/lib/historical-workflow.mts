import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Verify the workflow a historical receipt executed, never today's checkout. */
export function verifyHistoricalWorkflow(
  repositoryRoot: string,
  commit: string,
  path: string,
  expectedSha256: string
): void {
  if (
    !/^[a-f0-9]{40}$/.test(commit) ||
    !/^\.github\/workflows\/[a-z0-9-]+\.ya?ml$/.test(path) ||
    !/^[a-f0-9]{64}$/.test(expectedSha256)
  ) {
    throw new Error('historical workflow identity is invalid');
  }
  let bytes: Buffer;
  try {
    bytes = execFileSync('git', ['--no-replace-objects', 'cat-file', 'blob', `${commit}:${path}`], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error('historical workflow source is unavailable');
  }
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
    throw new Error(`${path} drifted from historical native-amd64 acceptance`);
  }
}
