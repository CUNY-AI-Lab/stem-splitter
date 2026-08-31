#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argumentsSet = new Set(process.argv.slice(2));
const allowedArguments = new Set(['--help', '--without-discovery', '--with-separator']);

for (const argument of argumentsSet) {
  if (!allowedArguments.has(argument)) {
    throw new Error(`Unknown local Auto option: ${argument}`);
  }
}

if (argumentsSet.has('--help')) {
  console.log(`Usage: npm run dev:auto [-- --without-discovery] [--with-separator]

Starts the Railway-shaped Node app and host analyzer on loopback. By default it
also starts the pinned offline CLAP candidate in a removable Docker container.
The candidate proves the discovery transport but remains rejected for musical
usefulness; it cannot rename stems or change Auto routing.

--without-discovery  Run core Auto only; Docker is not required.
--with-separator     Also run the local Audio Separator service. Its first use
                     may download a pinned model into local-separator/.models.

Optional environment: LOCAL_AUTO_APP_PORT, LOCAL_AUTO_ANALYSIS_PORT,
LOCAL_AUTO_DISCOVERY_PORT, LOCAL_AUTO_SEPARATOR_PORT,
LOCAL_AUTO_DISCOVERY_IMAGE, LOCAL_AUTO_DATA_DIR, LOCAL_AUTO_CLASS_CODE.`);
  process.exit(0);
}

const discoveryEnabled = !argumentsSet.has('--without-discovery');
const separatorEnabled = argumentsSet.has('--with-separator');

function boundedPort(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a TCP port`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65_535) {
    throw new Error(`${name} must be between 1024 and 65535`);
  }
  return value;
}

function safeValue(name, fallback, pattern) {
  const value = process.env[name] || fallback;
  if (!pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

const appPort = boundedPort('LOCAL_AUTO_APP_PORT', 8899);
const analysisPort = boundedPort('LOCAL_AUTO_ANALYSIS_PORT', 9091);
const discoveryPort = boundedPort('LOCAL_AUTO_DISCOVERY_PORT', 9090);
const separatorPort = boundedPort('LOCAL_AUTO_SEPARATOR_PORT', 8765);
const ports = [appPort, analysisPort];
if (discoveryEnabled) ports.push(discoveryPort);
if (separatorEnabled) ports.push(separatorPort);
if (new Set(ports).size !== ports.length) throw new Error('Local Auto ports must be unique');

const discoveryImage = safeValue(
  'LOCAL_AUTO_DISCOVERY_IMAGE',
  'stem-splitter-instrument-discovery:v3.2-candidate',
  /^[A-Za-z0-9_./:@+-]+$/
);
const classCode = safeValue(
  'LOCAL_AUTO_CLASS_CODE',
  'stem-local',
  /^[^\s\u0000-\u001f\u007f]{4,128}$/
);
const dataDirectory = resolve(
  repositoryRoot,
  process.env.LOCAL_AUTO_DATA_DIR || '.railway-data/local-auto'
);
const tsx = resolve(repositoryRoot, 'node_modules/.bin/tsx');
const runId = `${process.pid}-${Date.now()}`;
const discoveryContainer = `stem-splitter-discovery-local-${runId}`;
const analysisToken = randomBytes(32).toString('base64url');
const discoveryToken = randomBytes(32).toString('base64url');
const separatorToken = randomBytes(32).toString('base64url');
const webhookSecret = randomBytes(32).toString('base64url');
const appBase = `http://127.0.0.1:${appPort}`;
const analysisBase = `http://127.0.0.1:${analysisPort}`;
const discoveryBase = `http://127.0.0.1:${discoveryPort}`;
const separatorBase = `http://127.0.0.1:${separatorPort}`;

const children = [];
let dockerContainerCreated = false;
let stopping = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: options.timeout ?? 15_000,
    maxBuffer: 2 * 1024 * 1024,
    env: options.env ?? process.env,
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${command} ${args[0] || ''} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function commandAvailable(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 512 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} is required for the local Auto stack`);
  }
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

async function assertPortAvailable(port) {
  await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once('error', () => rejectPromise(new Error(`127.0.0.1:${port} is already in use`)));
    server.listen(port, '127.0.0.1', () => server.close(resolvePromise));
  });
}

function pipeLines(label, stream, target) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) target.write(`[${label}] ${line}\n`);
  });
  stream.on('end', () => {
    if (pending) target.write(`[${label}] ${pending}\n`);
  });
}

function startChild(label, command, args, environment) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeLines(label, child.stdout, process.stdout);
  pipeLines(label, child.stderr, process.stderr);
  children.push(child);
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`[local-auto] ${label} stopped unexpectedly (${signal || code})`);
      void shutdown(1);
    }
  });
  return child;
}

async function waitForJson(url, predicate, label, timeoutMs) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      const value = await response.json();
      if (response.ok && predicate(value)) return value;
      lastError = new Error(`${label} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`${label} did not become ready: ${lastError instanceof Error ? lastError.message : 'timeout'}`);
}

async function shutdown(exitCode) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  cleanupDocker();
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolvePromise) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolvePromise();
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolvePromise();
          }, 5_000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolvePromise();
          });
      })
    )
  );
  process.exit(exitCode);
}

function cleanupDocker() {
  if (dockerContainerCreated) {
    spawnSync('docker', ['rm', '--force', discoveryContainer], {
      cwd: repositoryRoot,
      stdio: 'ignore',
      timeout: 15_000,
    });
    dockerContainerCreated = false;
  }
}

process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));
process.once('exit', cleanupDocker);

try {
  if (!existsSync(tsx)) {
    throw new Error('JavaScript dependencies are missing; run bun install --frozen-lockfile');
  }
  const ffmpegVersionOutput = commandAvailable('ffmpeg', ['-version']);
  commandAvailable('ffprobe', ['-version']);
  const ffmpegVersion = /^ffmpeg version\s+(\d+\.\d+(?:\.\d+)?)/m.exec(ffmpegVersionOutput)?.[1];
  if (!ffmpegVersion) throw new Error('The local FFmpeg version could not be read');
  await Promise.all(ports.map(assertPortAvailable));
  mkdirSync(dataDirectory, { recursive: true });

  if (discoveryEnabled) {
    commandAvailable('docker', ['info']);
    run('docker', ['image', 'inspect', discoveryImage]);
    startChild(
      'discovery',
      'docker',
      [
        'run',
        '--rm',
        '--name', discoveryContainer,
        '--network', 'bridge',
        '--publish', `127.0.0.1:${discoveryPort}:8080`,
        '--memory', '4g',
        '--memory-swap', '4g',
        '--cpus', '2',
        '--pids-limit', '128',
        '--cap-drop', 'ALL',
        '--read-only',
        '--security-opt', 'no-new-privileges',
        '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=128m',
        '--env', `INSTRUMENT_DISCOVERY_TOKEN=${discoveryToken}`,
        '--env', 'PORT=8080',
        discoveryImage,
      ],
      {}
    );
    dockerContainerCreated = true;
    await waitForJson(
      `${discoveryBase}/readyz`,
      (value) => value?.ready === true && value?.vocabularyVersion === 'classroom-instruments-v1',
      'instrument discovery',
      180_000
    );
  }

  startChild('analysis', tsx, ['audio-analysis/server.ts'], {
    PORT: String(analysisPort),
    AUDIO_ANALYSIS_TOKEN: analysisToken,
    AUDIO_ANALYSIS_SOURCE_ORIGINS: appBase,
    AUDIO_ANALYSIS_ALLOW_HTTP: 'true',
    AUDIO_ANALYSIS_EXPECTED_FFMPEG_VERSION: ffmpegVersion,
    AUDIO_ANALYSIS_MAX_CONCURRENCY: '1',
    AUDIO_ANALYSIS_MAX_SOURCE_BYTES: '104857600',
    AUDIO_ANALYSIS_MAX_SOURCE_SECONDS: '900',
    AUDIO_ANALYSIS_FETCH_TIMEOUT_MS: '5000',
    AUDIO_ANALYSIS_DECODER_TIMEOUT_MS: '8000',
    INSTRUMENT_DISCOVERY_URL: discoveryEnabled ? discoveryBase : '',
    INSTRUMENT_DISCOVERY_TOKEN: discoveryEnabled ? discoveryToken : '',
    INSTRUMENT_DISCOVERY_TIMEOUT_MS: '12000',
  });
  await waitForJson(
    `${analysisBase}/readyz`,
    (value) =>
      value?.ready === true &&
      value?.classifierVersion === 'autosplit-role-v4' &&
      value?.instrumentDiscovery === (discoveryEnabled ? 'configured' : 'unconfigured'),
    'audio analysis',
    30_000
  );

  if (separatorEnabled) {
    commandAvailable('uv', ['--version']);
    startChild(
      'separator',
      'uv',
      ['run', '--project', 'local-separator', 'python', 'local-separator/service.py', '--port', String(separatorPort)],
      {
        UV_CACHE_DIR: resolve(repositoryRoot, '.uv-cache'),
        AUDIO_SEPARATOR_TOKEN: separatorToken,
        AUDIO_SEPARATOR_PUBLIC_URL: separatorBase,
      }
    );
    await waitForJson(
      `${separatorBase}/health`,
      (value) => value?.ok === true && Array.isArray(value?.models),
      'local separator',
      30_000
    );
  }

  startChild('app', tsx, ['server/index.ts'], {
    PORT: String(appPort),
    DATA_DIR: dataDirectory,
    PUBLIC_BASE_URL: appBase,
    WEBHOOK_SECRET: webhookSecret,
    CLASS_CODE: classCode,
    SEPARATION_BACKEND: 'audio-separator',
    AUDIO_SEPARATOR_URL: separatorEnabled ? separatorBase : 'http://127.0.0.1:1',
    AUDIO_SEPARATOR_TOKEN: separatorEnabled ? separatorToken : '',
    SERVER_AUTO_ENABLED: 'true',
    SERVER_AUTO_MODE: 'authoritative',
    INSTRUMENT_DISCOVERY_ENABLED: discoveryEnabled ? 'true' : 'false',
    AUDIO_ANALYSIS_URL: analysisBase,
    AUDIO_ANALYSIS_TOKEN: analysisToken,
    AUDIO_ANALYSIS_TIMEOUT_MS: '30000',
    REPLICATE_API_TOKEN: '',
    REPLICATE_MODEL_VERSION: '',
    REPLICATE_YT_MODEL: '',
    REPLICATE_YT_MODEL_VERSION: '',
    QUERY_ISOLATION_ENABLED: 'false',
    QUERY_ISOLATION_MODE: 'off',
    REPLICATE_AUDIOSEP_VERSION: '',
    OPENROUTER_API_KEY: '',
    TEACHER_SEED: '',
  });
  await waitForJson(
    `${appBase}/healthz`,
    (value) =>
      value?.ok === true &&
      value?.configuration?.audioAnalysis === 'configured' &&
      value?.configuration?.serverAutoMode === 'authoritative' &&
      value?.configuration?.instrumentDiscovery === (discoveryEnabled ? 'enabled' : 'disabled'),
    'STEM Splitter app',
    30_000
  );

  console.log(`\n[local-auto] ready at ${appBase}`);
  console.log(`[local-auto] class code: ${classCode}`);
  console.log(`[local-auto] core Auto: autosplit-role-v4 through the local analyzer`);
  if (discoveryEnabled) {
    console.log(
      '[local-auto] discovery: CLAP transport is live, but this candidate remains uncalibrated and rejected for useful detections'
    );
  }
  console.log(
    separatorEnabled
      ? '[local-auto] separation: local Audio Separator is enabled'
      : '[local-auto] separation: disabled; use --with-separator for completed local stem jobs'
  );
  console.log('[local-auto] press Ctrl-C to stop the stack');
  await new Promise(() => {});
} catch (error) {
  console.error(`[local-auto] ${error instanceof Error ? error.message : String(error)}`);
  await shutdown(1);
}
