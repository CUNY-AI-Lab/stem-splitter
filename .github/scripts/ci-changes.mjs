import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { AUDIO_ANALYSIS_IMAGE_EVIDENCE_SOURCES } from '../../scripts/lib/audio-analysis-image-evidence.mts';
import { changedFiles } from './cloudflare-ci-changes.mjs';

const imageInputs = new Set(AUDIO_ANALYSIS_IMAGE_EVIDENCE_SOURCES);

function affectsImage(path) {
  return imageInputs.has(path) || path.startsWith('audio-analysis/') ||
    path.startsWith('src/analysis/') || path.startsWith('tests/fixtures/audio/') ||
    /^tests\/(?:audio-analysis|autosplit)/.test(path);
}

function coveredElsewhere(path) {
  // Cloudflare has its own required check. Acceptance records remain source
  // inputs even when their filenames end in Markdown.
  return path.startsWith('cloudflare/') || /^[^/]+\.md$/i.test(path) ||
    (path.startsWith('docs/') && !path.startsWith('docs/acceptance/') && /\.md$/i.test(path));
}

export function classifyChanges(files, { eventName, draft = false, scope = 'all' } = {}) {
  if (eventName === 'workflow_dispatch') {
    if (!['all', 'source', 'image'].includes(scope)) throw new Error('Unknown CI scope');
    return { source: scope !== 'image', image: scope !== 'source', browsers: scope !== 'image' };
  }
  const image = files === null || files.some(affectsImage);
  const source = files === null || image || files.some(path => !coveredElsewhere(path));
  return { source, image, browsers: source && !(eventName === 'pull_request' && draft) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = changedFiles({ base: process.env.CI_BASE_SHA, head: process.env.CI_HEAD_SHA });
  const result = classifyChanges(files, {
    eventName: process.env.GITHUB_EVENT_NAME,
    draft: process.env.CI_PULL_REQUEST_DRAFT === 'true',
    scope: process.env.CI_SCOPE || 'all',
  });
  for (const [key, value] of Object.entries(result)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  const summary = [
    '## General CI selection',
    `Source gate: **${result.source ? 'run' : 'skip'}**`,
    `Native audio image: **${result.image ? 'run' : 'skip'}**`,
    `General browser suites: **${result.browsers ? 'run' : 'skip'}**`,
    files === null ? 'Change history unavailable; full checks selected.' :
      `Compared ${files.length} changed path(s), including both sides of renames.`,
  ].join('\n\n');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  console.log(JSON.stringify({ ...result, changedFiles: files }, null, 2));
}
