import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_MS = 10_000;
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const API_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 5 * 60 * 1000;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameOriginUrl(value, base, label) {
  const url = new URL(value, base);
  if (url.origin !== new URL(base).origin) {
    throw new Error(`${label} escaped the deployment origin`);
  }
  return url;
}

function isMp3(bytes) {
  return (
    (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
    (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  );
}

async function responseBody(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function requestJson(fetchImpl, url, init, label) {
  const response = await fetchImpl(url, {
    ...init,
    redirect: 'manual',
    signal: init.signal ?? AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const body = await responseBody(response);
  if (!response.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`${label} failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`${label} returned a non-object response`);
  }
  return body;
}

export async function captureRailwayBaseline({
  base,
  classCode,
  sourcePath,
  sourceBytes,
  filename,
  model = 'htdemucs_ft',
  fetchImpl = fetch,
  pollMs = DEFAULT_POLL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onProgress = () => {},
}) {
  if (!base) throw new Error('BASE or PUBLIC_BASE_URL is required');
  if (!classCode) throw new Error('CLASS_CODE is required');
  if (!sourcePath && !sourceBytes) throw new Error('SOURCE_AUDIO or sourceBytes is required');
  if (!/^https?:$/.test(new URL(base).protocol)) throw new Error('BASE must be HTTP or HTTPS');

  const normalizedBase = base.replace(/\/$/, '');
  const bytes = sourceBytes ? Buffer.from(sourceBytes) : await readFile(sourcePath);
  const sourceFilename = filename ?? basename(sourcePath);
  if (!sourceFilename) throw new Error('a source filename is required');
  if (bytes.length < 1 || bytes.length > MAX_SOURCE_BYTES) {
    throw new Error('source must be between 1 byte and 100 MiB');
  }
  const headers = {
    'content-type': 'application/json',
    'x-class-code': classCode,
  };

  const health = await requestJson(fetchImpl, `${normalizedBase}/healthz`, {}, 'health check');
  if (health.ok !== true) throw new Error('deployment health did not report ok');
  if (health.base && health.base.replace(/\/$/, '') !== normalizedBase) {
    throw new Error(`deployment health reported the wrong public base (${health.base})`);
  }
  const catalogue = await requestJson(
    fetchImpl,
    `${normalizedBase}/api/separation-options`,
    {},
    'separation catalogue'
  );
  const contract = catalogue.models?.find((option) => option.id === model);
  if (!contract || !Array.isArray(contract.stems) || contract.stems.length !== 4) {
    throw new Error(`${model} is not the live four-track contract`);
  }
  if (catalogue.defaultModel !== model) {
    throw new Error(`${model} is not the live default contract`);
  }

  const upload = await requestJson(
    fetchImpl,
    `${normalizedBase}/api/uploads`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: sourceFilename }),
    },
    'upload allocation'
  );
  if (typeof upload.key !== 'string' || typeof upload.uploadUrl !== 'string') {
    throw new Error('upload allocation omitted key or uploadUrl');
  }
  const uploadUrl = sameOriginUrl(upload.uploadUrl, normalizedBase, 'upload URL');
  const put = await fetchImpl(uploadUrl, {
    method: 'PUT',
    redirect: 'manual',
    signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    headers: {
      'content-type': 'application/octet-stream',
      'x-class-code': classCode,
    },
    body: bytes,
  });
  if (!put.ok) throw new Error(`upload PUT failed (${put.status})`);

  const startedAt = new Date();
  const created = await requestJson(
    fetchImpl,
    `${normalizedBase}/api/jobs`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: upload.key, filename: sourceFilename, model }),
    },
    'job creation'
  );
  if (typeof created.id !== 'string') throw new Error('job creation omitted its id');

  const deadline = Date.now() + timeoutMs;
  let job;
  let lastStatus = '';
  while (Date.now() < deadline) {
    job = await requestJson(
      fetchImpl,
      `${normalizedBase}/api/jobs/${encodeURIComponent(created.id)}`,
      {},
      'job poll'
    );
    if (job.status !== lastStatus) {
      lastStatus = String(job.status ?? 'unknown');
      onProgress(lastStatus);
    }
    if (job.status === 'done' || job.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (!job || (job.status !== 'done' && job.status !== 'failed')) {
    throw new Error(`job ${created.id} did not finish within ${timeoutMs} ms`);
  }
  if (job.status !== 'done') throw new Error(`job ${created.id} failed: ${job.error ?? 'unknown error'}`);
  if (job.model !== model) throw new Error(`job resolved to ${job.model ?? 'no model'} instead of ${model}`);

  const expectedStems = Array.isArray(job.expectedStems) ? job.expectedStems : contract.stems;
  if (JSON.stringify(expectedStems) !== JSON.stringify(contract.stems)) {
    throw new Error('job expected-stem contract drifted from the live catalogue');
  }
  const stems = Array.isArray(job.stems) ? job.stems : [];
  if (stems.length !== expectedStems.length) {
    throw new Error(`job returned ${stems.length} stems; expected ${expectedStems.length}`);
  }
  const names = stems.map((stem) => stem.name);
  if (JSON.stringify(names) !== JSON.stringify(expectedStems)) {
    throw new Error(`job stem order ${JSON.stringify(names)} did not match ${JSON.stringify(expectedStems)}`);
  }

  const stemEvidence = [];
  for (const stem of stems) {
    if (typeof stem.url !== 'string') throw new Error(`stem ${stem.name} omitted its URL`);
    const stemUrl = sameOriginUrl(stem.url, normalizedBase, `stem ${stem.name} URL`);
    const response = await fetchImpl(stemUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`stem ${stem.name} download failed (${response.status})`);
    const stemBytes = Buffer.from(await response.arrayBuffer());
    if (!isMp3(stemBytes)) throw new Error(`stem ${stem.name} is not recognizable MP3 audio`);
    stemEvidence.push({
      name: stem.name,
      bytes: stemBytes.length,
      sha256: sha256(stemBytes),
    });
  }
  const hashes = stemEvidence.map((stem) => stem.sha256);
  if (new Set(hashes).size !== hashes.length) {
    throw new Error('two or more stem outputs have identical SHA-256 hashes');
  }

  const completedAt = new Date();
  return {
    schemaVersion: '1',
    capturedAt: completedAt.toISOString(),
    base: normalizedBase,
    health,
    catalogue: {
      backend: catalogue.backend,
      defaultModel: catalogue.defaultModel,
      model: { id: contract.id, stems: [...contract.stems], engine: contract.engine },
    },
    source: {
      filename: sourceFilename,
      bytes: bytes.length,
      sha256: sha256(bytes),
    },
    job: {
      id: created.id,
      model: job.model ?? model,
      status: job.status,
      expectedStems,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      latencyMs: completedAt.getTime() - startedAt.getTime(),
    },
    stems: stemEvidence,
  };
}
