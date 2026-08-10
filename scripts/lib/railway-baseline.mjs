import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_MS = 10_000;
const API_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const JOB_STATUSES = new Set(['pending', 'processing', 'ingesting', 'done', 'failed']);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('BASE must be an absolute Railway origin');
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
    url.hostname.toLowerCase()
  );
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('BASE must be an HTTPS origin (HTTP is allowed only on loopback)');
  }
  return url.origin;
}

function sameOriginUrl(value, base, label) {
  let url;
  try {
    url = new URL(value, `${base}/`);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (url.origin !== base || url.username || url.password || url.hash) {
    throw new Error(`${label} escaped the deployment origin`);
  }
  return url;
}

function isMp3(bytes) {
  if (bytes.length < 1024) return false;
  let offset = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    if (
      bytes.length < 10 ||
      [bytes[6], bytes[7], bytes[8], bytes[9]].some((byte) => byte & 0x80)
    ) {
      return false;
    }
    const tagSize =
      (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
    offset = 10 + tagSize + (bytes[5] & 0x10 ? 10 : 0);
    if (offset >= bytes.length) return false;
  }
  const limit = Math.min(bytes.length - 3, offset + 64 * 1024);
  for (let index = offset; index < limit; index += 1) {
    if (bytes[index] !== 0xff || (bytes[index + 1] & 0xe0) !== 0xe0) continue;
    const version = (bytes[index + 1] >> 3) & 0x03;
    const layer = (bytes[index + 1] >> 1) & 0x03;
    const bitrate = (bytes[index + 2] >> 4) & 0x0f;
    const sampleRate = (bytes[index + 2] >> 2) & 0x03;
    if (
      version !== 0x01 &&
      layer !== 0 &&
      bitrate !== 0 &&
      bitrate !== 0x0f &&
      sampleRate !== 0x03
    ) {
      return true;
    }
  }
  return false;
}

async function readBoundedBytes(response, limit, label) {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > limit) {
      throw new Error(`${label} exceeded its response-size limit`);
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel('response is too large');
        throw new Error(`${label} exceeded its response-size limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function boundedFetch(fetchImpl, url, init, label, timeoutMs = API_TIMEOUT_MS) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(`${label} request failed`);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${label} redirected`);
  }
  return response;
}

async function responseBody(response, label) {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('json')) throw new Error(`${label} did not return JSON`);
  const bytes = await readBoundedBytes(response, MAX_JSON_BYTES, label);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} returned invalid UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function requestJson(fetchImpl, url, init, label, timeoutMs = API_TIMEOUT_MS) {
  const response = await boundedFetch(fetchImpl, url, init, label, timeoutMs);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${label} failed (${response.status})`);
  }
  const body = await responseBody(response, label);
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
  if (
    typeof classCode !== 'string' ||
    classCode.length < 1 ||
    classCode.length > 256 ||
    classCode !== classCode.trim() ||
    /[\u0000-\u001f\u007f]/.test(classCode)
  ) {
    throw new Error('CLASS_CODE is missing or invalid');
  }
  const hasSourcePath = typeof sourcePath === 'string' && sourcePath.length > 0;
  const hasSourceBytes = sourceBytes !== undefined;
  if (Number(hasSourcePath) + Number(hasSourceBytes) !== 1) {
    throw new Error('provide exactly one of SOURCE_AUDIO or sourceBytes');
  }
  if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 60_000) {
    throw new Error('BASELINE_POLL_MS is invalid');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60 * 1000) {
    throw new Error('BASELINE_TIMEOUT_MS is invalid');
  }
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(model)) {
    throw new Error('MODEL is invalid');
  }

  const normalizedBase = normalizeBase(base);
  let bytes;
  try {
    bytes = hasSourceBytes ? Buffer.from(sourceBytes) : await readFile(sourcePath);
  } catch {
    throw new Error('SOURCE_AUDIO could not be read');
  }
  if (bytes.length < 1 || bytes.length > MAX_AUDIO_BYTES) {
    throw new Error('source audio must contain 1 byte to 100 MiB');
  }
  const sourceFilename =
    filename ?? (hasSourcePath ? basename(sourcePath) : 'baseline-audio.mp3');
  if (
    typeof sourceFilename !== 'string' ||
    sourceFilename.length < 1 ||
    sourceFilename.length > 255 ||
    sourceFilename !== sourceFilename.trim() ||
    basename(sourceFilename) !== sourceFilename ||
    /[\u0000-\u001f\u007f]/.test(sourceFilename)
  ) {
    throw new Error('source filename is invalid');
  }
  const headers = {
    'content-type': 'application/json',
    'x-class-code': classCode,
  };

  const health = await requestJson(fetchImpl, `${normalizedBase}/healthz`, {}, 'health check');
  if (health.ok !== true || health.base !== normalizedBase || health.promptSchema !== 'ready') {
    throw new Error('health check did not prove the canonical ready deployment');
  }
  const catalogue = await requestJson(
    fetchImpl,
    `${normalizedBase}/api/separation-options`,
    {},
    'separation catalogue'
  );
  if (catalogue.backend !== 'replicate' || catalogue.defaultModel !== model) {
    throw new Error('the live default is not the requested Replicate baseline model');
  }
  const contract = catalogue.models?.find((option) => option.id === model);
  if (
    !contract ||
    !Array.isArray(contract.stems) ||
    contract.stems.length !== 4 ||
    contract.stems.some((stem) => typeof stem !== 'string') ||
    new Set(contract.stems).size !== 4
  ) {
    throw new Error(`${model} is not the live four-track contract`);
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
  if (
    typeof upload.key !== 'string' ||
    !upload.key.startsWith('uploads/') ||
    upload.key.length > 512 ||
    typeof upload.uploadUrl !== 'string'
  ) {
    throw new Error('upload allocation omitted a bounded upload key or URL');
  }
  const uploadUrl = sameOriginUrl(upload.uploadUrl, normalizedBase, 'upload URL');
  const put = await boundedFetch(
    fetchImpl,
    uploadUrl,
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'x-class-code': classCode,
      },
      body: bytes,
    },
    'upload PUT',
    TRANSFER_TIMEOUT_MS
  );
  if (!put.ok) {
    await put.body?.cancel().catch(() => undefined);
    throw new Error(`upload PUT failed (${put.status})`);
  }
  await put.body?.cancel().catch(() => undefined);

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
  if (typeof created.id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(created.id)) {
    throw new Error('job creation omitted a safe id');
  }

  const deadline = Date.now() + timeoutMs;
  let job;
  let lastStatus = '';
  while (Date.now() < deadline) {
    job = await requestJson(
      fetchImpl,
      `${normalizedBase}/api/jobs/${encodeURIComponent(created.id)}`,
      {},
      'job poll',
      Math.min(API_TIMEOUT_MS, Math.max(1, deadline - Date.now()))
    );
    if (!JOB_STATUSES.has(job.status)) throw new Error('job poll returned an unknown status');
    if (job.status !== lastStatus) {
      lastStatus = job.status;
      onProgress(lastStatus);
    }
    if (job.status === 'done' || job.status === 'failed') break;
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
    }
  }
  if (!job || (job.status !== 'done' && job.status !== 'failed')) {
    throw new Error(`job did not finish within ${timeoutMs} ms`);
  }
  if (job.status !== 'done') throw new Error('baseline separation job failed');
  if (job.id !== created.id || job.model !== model) {
    throw new Error('completed job identity did not match the request');
  }

  const expectedStems = job.expectedStems;
  if (JSON.stringify(expectedStems) !== JSON.stringify(contract.stems)) {
    throw new Error('job expected-stem contract did not match the live catalogue');
  }
  const stems = Array.isArray(job.stems) ? job.stems : [];
  if (stems.length !== expectedStems.length) {
    throw new Error(`job returned ${stems.length} stems; expected ${expectedStems.length}`);
  }
  const names = stems.map((stem) =>
    stem && typeof stem === 'object' && typeof stem.name === 'string' ? stem.name : null
  );
  if (JSON.stringify(names) !== JSON.stringify(expectedStems)) {
    throw new Error(`job stem order ${JSON.stringify(names)} did not match the contract`);
  }

  const stemEvidence = [];
  for (const stem of stems) {
    if (typeof stem.url !== 'string') throw new Error(`stem ${stem.name} omitted its URL`);
    const stemUrl = sameOriginUrl(stem.url, normalizedBase, `stem ${stem.name} URL`);
    const response = await boundedFetch(
      fetchImpl,
      stemUrl,
      {},
      `stem ${stem.name} download`,
      TRANSFER_TIMEOUT_MS
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`stem ${stem.name} download failed (${response.status})`);
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('audio/')) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`stem ${stem.name} did not return audio`);
    }
    const stemBytes = await readBoundedBytes(response, MAX_AUDIO_BYTES, `stem ${stem.name}`);
    if (!isMp3(stemBytes)) {
      throw new Error(`stem ${stem.name} has no recognizable MPEG audio frame`);
    }
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
      model: job.model,
      status: job.status,
      expectedStems,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      latencyMs: completedAt.getTime() - startedAt.getTime(),
    },
    stems: stemEvidence,
  };
}

export async function downloadRailwayBaselineStems({
  baseline,
  fetchImpl = fetch,
}) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    throw new Error('baseline evidence must be an object');
  }
  const normalizedBase = normalizeBase(baseline.base);
  const expectedStems = baseline.job?.expectedStems;
  const jobId = baseline.job?.id;
  const model = baseline.job?.model;
  if (
    typeof jobId !== 'string' ||
    !/^[A-Za-z0-9-]{1,128}$/.test(jobId) ||
    typeof model !== 'string' ||
    !Array.isArray(expectedStems) ||
    expectedStems.length < 2 ||
    expectedStems.length > 6 ||
    expectedStems.some((name) => typeof name !== 'string') ||
    new Set(expectedStems).size !== expectedStems.length ||
    !Array.isArray(baseline.stems) ||
    baseline.stems.length !== expectedStems.length
  ) {
    throw new Error('baseline job contract is invalid');
  }

  const health = await requestJson(
    fetchImpl,
    `${normalizedBase}/healthz`,
    {},
    'listening health check'
  );
  if (health.ok !== true || health.base !== normalizedBase || health.promptSchema !== 'ready') {
    throw new Error('listening health check did not prove the canonical ready deployment');
  }

  const catalogue = await requestJson(
    fetchImpl,
    `${normalizedBase}/api/separation-options`,
    {},
    'listening separation catalogue'
  );
  const catalogueModel = Array.isArray(catalogue.models)
    ? catalogue.models.find((option) => option?.id === model)
    : undefined;
  if (
    catalogue.backend !== baseline.catalogue?.backend ||
    catalogue.defaultModel !== baseline.catalogue?.defaultModel ||
    !catalogueModel ||
    catalogueModel.engine !== baseline.catalogue?.model?.engine ||
    JSON.stringify(catalogueModel.stems) !== JSON.stringify(expectedStems)
  ) {
    throw new Error('live listening catalogue drifted from the frozen baseline');
  }

  const job = await requestJson(
    fetchImpl,
    `${normalizedBase}/api/jobs/${encodeURIComponent(jobId)}`,
    {},
    'listening job readback'
  );
  if (
    job.id !== jobId ||
    job.status !== 'done' ||
    job.model !== model ||
    JSON.stringify(job.expectedStems) !== JSON.stringify(expectedStems) ||
    !Array.isArray(job.stems) ||
    job.stems.length !== expectedStems.length
  ) {
    throw new Error('live listening job drifted from the frozen baseline');
  }

  const downloaded = [];
  for (let index = 0; index < expectedStems.length; index += 1) {
    const name = expectedStems[index];
    const liveStem = job.stems[index];
    const frozenStem = baseline.stems[index];
    if (
      !liveStem ||
      typeof liveStem !== 'object' ||
      liveStem.name !== name ||
      typeof liveStem.url !== 'string' ||
      !frozenStem ||
      frozenStem.name !== name ||
      !Number.isSafeInteger(frozenStem.bytes) ||
      frozenStem.bytes < 1 ||
      typeof frozenStem.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(frozenStem.sha256)
    ) {
      throw new Error(`listening stem ${name} evidence is invalid`);
    }
    const stemUrl = sameOriginUrl(
      liveStem.url,
      normalizedBase,
      `listening stem ${name} URL`
    );
    const response = await boundedFetch(
      fetchImpl,
      stemUrl,
      {},
      `listening stem ${name} download`,
      TRANSFER_TIMEOUT_MS
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`listening stem ${name} download failed (${response.status})`);
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('audio/')) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`listening stem ${name} did not return audio`);
    }
    const audio = await readBoundedBytes(
      response,
      MAX_AUDIO_BYTES,
      `listening stem ${name}`
    );
    const digest = sha256(audio);
    if (
      audio.length !== frozenStem.bytes ||
      digest !== frozenStem.sha256 ||
      !isMp3(audio)
    ) {
      throw new Error(`listening stem ${name} drifted from the frozen bytes`);
    }
    downloaded.push({ name, bytes: audio.length, sha256: digest, audio });
  }

  return {
    base: normalizedBase,
    jobId,
    model,
    stems: downloaded,
  };
}
