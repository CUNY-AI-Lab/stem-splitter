import { spawn } from 'node:child_process';

export class ProcessFailure extends Error {
  constructor(readonly code: 'spawn' | 'timeout' | 'exit' | 'output_limit' | 'aborted') {
    super(code);
  }
}

export interface ProcessResult {
  stdout: Buffer;
  stderr: Buffer;
}

export function runBoundedProcess(
  binary: string,
  args: readonly string[],
  options: {
    timeoutMs: number;
    maxStdoutBytes: number;
    maxStderrBytes?: number;
    signal?: AbortSignal;
  }
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };
    const stop = (error: ProcessFailure) => {
      child.kill('SIGKILL');
      finish(error);
    };
    const abort = () => stop(new ProcessFailure('aborted'));
    const timer = setTimeout(() => stop(new ProcessFailure('timeout')), options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) return abort();

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxStdoutBytes) return stop(new ProcessFailure('output_limit'));
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const remaining = Math.max(0, maxStderrBytes - stderrBytes);
      if (remaining) stderr.push(chunk.subarray(0, remaining));
      stderrBytes += chunk.length;
    });
    child.once('error', () => finish(new ProcessFailure('spawn')));
    child.once('close', (code, signalName) => {
      if (settled) return;
      if (code !== 0 || signalName) return finish(new ProcessFailure('exit'));
      finish();
    });
  });
}
