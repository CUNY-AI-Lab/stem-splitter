// Drives the real-audio evaluation corpus through a running deployment and
// scores every result with scripts/eval-stems.mjs.
//
//   CLASS_CODE=<code> node scripts/run-audio-corpus.mjs                # whole corpus
//   CLASS_CODE=<code> node scripts/run-audio-corpus.mjs dylan-baez-duet
//   BASE=http://localhost:8787 CLASS_CODE=<code> node scripts/run-audio-corpus.mjs
//
// Costs roughly $0.05 per source × model, plus ~$0.01 per YouTube fetch.
// Fill in tests/corpus/corpus.json first — no audio ships with the repo.
//
// Note on YouTube sources: `/api/files/*` serves only `stems/`, never the
// uploaded original (deliberate copyright posture), so the source mix is not
// retrievable and reconstruction cannot be measured for them. Those entries
// are instead scored by cross-model consistency: two different splits of the
// same recording must sum back to the same audio as each other.

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const BASE = process.env.BASE || 'https://stem-splitter.ailab-452.workers.dev';
const CODE = process.env.CLASS_CODE;
const CORPUS = resolve('tests/corpus/corpus.json');
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const DATE = process.env.CORPUS_DATE || new Date().toISOString().slice(0, 10);
const OUT = resolve(process.env.CORPUS_OUT || `docs/acceptance/${DATE}-corpus`);

if (!CODE) {
  console.error('✗ CLASS_CODE is required.');
  process.exit(2);
}

const headers = { 'content-type': 'application/json', 'x-class-code': CODE };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...init.headers } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return body;
}

async function createJob(entry, model) {
  if (entry.kind === 'youtube') {
    return api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ youtubeUrl: entry.source, model }),
    });
  }
  const path = resolve(entry.source);
  const filename = basename(path);
  const bytes = await readFile(path);
  const { key, uploadUrl } = await api('/api/uploads', {
    method: 'POST',
    body: JSON.stringify({ filename }),
  });
  const put = await fetch(uploadUrl, { method: 'PUT', body: bytes });
  if (!put.ok) throw new Error(`upload PUT → ${put.status}`);
  return api('/api/jobs', { method: 'POST', body: JSON.stringify({ key, filename, model }) });
}

async function waitForJob(id, label) {
  const deadline = Date.now() + 15 * 60 * 1000;
  let last = '';
  while (Date.now() < deadline) {
    const job = await api(`/api/jobs/${id}`);
    if (job.status !== last) {
      process.stdout.write(`\n    ${label}: ${job.status}`);
      last = job.status;
    } else {
      process.stdout.write('.');
    }
    if (job.status === 'done' || job.status === 'failed') {
      process.stdout.write('\n');
      return job;
    }
    await sleep(10000);
  }
  throw new Error(`${label} did not finish within 15 minutes`);
}

async function downloadStems(job, dir) {
  await mkdir(dir, { recursive: true });
  const saved = [];
  for (const stem of job.stems) {
    const res = await fetch(`${BASE}${stem.url}`);
    if (!res.ok) throw new Error(`stem ${stem.name} → ${res.status}`);
    const path = `${dir}/${stem.name}.mp3`;
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
    saved.push({ name: stem.name, path });
  }
  return saved;
}

/** Sum a set of stems into one wav, so two models can be compared to each other. */
async function sumStems(stems, outPath) {
  const inputs = stems.flatMap((s) => ['-i', s.path]);
  await run('ffmpeg', [
    '-v', 'error', '-y', ...inputs,
    '-filter_complex', `${stems.map((_, i) => `[${i}]`).join('')}amix=inputs=${stems.length}:normalize=0[m]`,
    '-map', '[m]', outPath,
  ]);
  return outPath;
}

async function evalStems({ label, source, stems, expect, complementary, jsonPath }) {
  const args = [
    'scripts/eval-stems.mjs',
    '--label', label,
    '--source', source,
    ...stems.flatMap((s) => ['--stem', `${s.name}=${s.path}`]),
    '--json', jsonPath,
  ];
  if (complementary) args.push('--complementary');
  if (expect?.loud?.length) args.push('--expect-loud', expect.loud.join(','));
  if (expect?.quiet?.length) args.push('--expect-quiet', expect.quiet.join(','));
  try {
    const { stdout } = await run('node', args, { maxBuffer: 1024 * 1024 * 64 });
    console.log(stdout);
    return 'PASS';
  } catch (error) {
    console.log(error.stdout ?? error.message);
    return 'FAIL';
  }
}

// --- run -------------------------------------------------------------------

const corpus = JSON.parse(await readFile(CORPUS, 'utf8'));
const entries = corpus.sources.filter((e) => (only.length ? only.includes(e.slug) : true));
const missing = entries.filter((e) => !e.source);
if (missing.length) {
  console.error(`✗ These corpus entries have no source yet: ${missing.map((e) => e.slug).join(', ')}`);
  console.error(`  Fill them in at ${CORPUS} with audio you are allowed to test.`);
  process.exit(2);
}
if (!entries.length) {
  console.error('✗ No matching corpus entries.');
  process.exit(2);
}

await mkdir(OUT, { recursive: true });
const summary = [];

for (const entry of entries) {
  console.log(`\n══ ${entry.slug} (${entry.kind}) ══`);
  console.log(`   ${entry.why}`);
  const perModel = {};

  for (const model of entry.models) {
    const dir = `${OUT}/${entry.slug}/${model}`;
    let job;
    try {
      const created = await createJob(entry, model);
      job = await waitForJob(created.id, model);
    } catch (error) {
      console.log(`    ✗ ${model}: ${error.message}`);
      summary.push({ slug: entry.slug, model, verdict: 'ERROR', detail: error.message });
      continue;
    }

    if (job.status !== 'done') {
      console.log(`    ✗ ${model} failed: ${job.error}`);
      summary.push({ slug: entry.slug, model, verdict: 'JOB_FAILED', detail: job.error });
      continue;
    }

    const stems = await downloadStems(job, dir);
    await writeFile(`${dir}/job.json`, `${JSON.stringify(job, null, 2)}\n`);
    perModel[model] = { stems, dir };

    // A local source can be compared directly; a YouTube import cannot, because
    // the Worker never serves the uploaded original back out.
    if (entry.kind === 'file') {
      const verdict = await evalStems({
        label: `${entry.slug} / ${model}`,
        source: resolve(entry.source),
        stems,
        expect: entry.expect?.[model],
        complementary: stems.length === 2,
        jsonPath: `${dir}/eval.json`,
      });
      summary.push({ slug: entry.slug, model, verdict });
    } else {
      summary.push({ slug: entry.slug, model, verdict: 'STEMS_ONLY' });
    }
  }

  // Cross-model consistency: independent splits of the same recording must sum
  // back to the same audio. This is the only reconstruction-style check
  // available for YouTube sources, and it is a real one — it catches a track
  // renamed onto the wrong audio just as a source comparison would.
  const models = Object.keys(perModel);
  if (models.length >= 2) {
    const [a, b] = models;
    const sumA = await sumStems(perModel[a].stems, `${OUT}/${entry.slug}/sum-${a}.wav`);
    const verdict = await evalStems({
      label: `${entry.slug}: ${b} tracks vs ${a} sum`,
      source: sumA,
      stems: perModel[b].stems,
      expect: entry.expect?.[b],
      complementary: perModel[b].stems.length === 2,
      jsonPath: `${OUT}/${entry.slug}/cross-model-eval.json`,
    });
    summary.push({ slug: entry.slug, model: `${b}-vs-${a}`, verdict, crossModel: true });
  }

  if (entry.manualChecks?.length) {
    console.log(`   Listen-tests that no measure covers:`);
    for (const check of entry.manualChecks) console.log(`     · ${check}`);
  }
}

await writeFile(`${OUT}/summary.json`, `${JSON.stringify({ base: BASE, date: DATE, summary }, null, 2)}\n`);
console.log(`\n══ summary ══`);
for (const row of summary) {
  console.log(`  ${row.verdict.padEnd(11)} ${row.slug} / ${row.model}${row.detail ? ` — ${row.detail}` : ''}`);
}
console.log(`\nartifacts: ${OUT}`);
process.exit(summary.some((r) => r.verdict === 'FAIL' || r.verdict === 'ERROR' || r.verdict === 'JOB_FAILED') ? 1 : 0);
