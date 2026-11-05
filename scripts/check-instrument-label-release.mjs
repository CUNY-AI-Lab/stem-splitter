#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABEL_RELEASE_PLAN, evaluateLabelRelease, verifyLabelAudioArtifact } from './lib/instrument-label-release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    if (!['--evidence', '--revision'].includes(key) || !value || value.startsWith('--') || args.has(key)) {
      throw new Error('Usage: check-instrument-label-release.mjs [--evidence report.json] [--revision exact-git-sha]');
    }
    args.set(key, value);
  }
  const plan = JSON.parse(readFileSync(resolve(root, LABEL_RELEASE_PLAN), 'utf8'));
  const revision = args.get('--revision') ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const evidencePath = args.has('--evidence') ? resolve(args.get('--evidence')) : null;
  const evidence = evidencePath ? JSON.parse(readFileSync(evidencePath, 'utf8')) : undefined;
  const checked = new Set();
  const result = evaluateLabelRelease(plan, evidence, { revision,
    verifyArtifact: evidencePath ? artifact => {
      const directory = dirname(evidencePath);
      verifyLabelAudioArtifact(directory, artifact);
      const path = resolve(directory, artifact.path), key = `${path}:${artifact.sha256}`;
      if (!checked.has(key)) {
        const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file',
          '-format_whitelist', 'mp3,wav,flac,ogg,aiff,mov', '-show_entries',
          'stream=codec_type,sample_rate,channels:format=duration', '-of', 'json', path],
        { encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 }));
        if (!info.streams?.some(s => s.codec_type === 'audio' && Number(s.sample_rate) > 0 && s.channels > 0) ||
            !(Number(info.format?.duration) > 0)) throw new Error('No decodable audio stream.');
        checked.add(key);
      }
      return true;
    } : undefined });
  result.sourceFiles = plan.sources.map(source => {
    try { verifyLabelAudioArtifact(root, source); return { id: source.id, status: 'verified', sha256: source.sha256 }; }
    catch { return { id: source.id, status: 'missing-or-mismatched', sha256: source.sha256 }; }
  });
  if (result.sourceFiles.some(s => s.status !== 'verified')) result.ready = false;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ready ? 0 : 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
