import {
  AUDIO_ANALYSIS_SCHEMA_VERSION,
  SOURCE_FINGERPRINT_SCHEMA_VERSION,
  type AudioAnalysisRequestV1,
  type AudioFingerprintRequestV1,
  type AudioSourceType,
  type CoreModelContract,
} from '../src/analysis/types.ts';

const MAX_REQUEST_BYTES = 32 * 1024;
const MODEL_ID = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const SOURCE_TYPES = new Set<AudioSourceType>(['upload', 'youtube', 'archive']);
const REQUEST_KEYS = new Set([
  'schemaVersion',
  'sourceUrl',
  'sourceType',
  'coreModels',
  'fallbackModel',
  'instrumentDiscovery',
]);
const FINGERPRINT_REQUEST_KEYS = new Set(['schemaVersion', 'sourceUrl', 'sourceType']);

export class AnalysisRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key)) && valueKeysEqual(value, keys);
}

function valueKeysEqual(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  if (Object.keys(value).length !== keys.size) return false;
  for (const key of keys) if (!(key in value)) return false;
  return true;
}

function parseCoreModels(value: unknown): CoreModelContract[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) {
    throw new AnalysisRequestError('coreModels must contain one to six contracts');
  }
  const seenModels = new Set<string>();
  return value.map((candidate) => {
    if (!record(candidate) || !exactKeys(candidate, new Set(['id', 'stems']))) {
      throw new AnalysisRequestError('a core model contract is invalid');
    }
    const id = typeof candidate.id === 'string' ? candidate.id : '';
    if (!MODEL_ID.test(id) || id.length > 100 || seenModels.has(id)) {
      throw new AnalysisRequestError('a core model id is invalid or duplicated');
    }
    if (
      !Array.isArray(candidate.stems) ||
      ![2, 4, 6].includes(candidate.stems.length) ||
      candidate.stems.some(
        (stem) => typeof stem !== 'string' || !MODEL_ID.test(stem) || stem.length > 64
      ) ||
      new Set(candidate.stems).size !== candidate.stems.length
    ) {
      throw new AnalysisRequestError('a core model stem contract is invalid');
    }
    seenModels.add(id);
    return { id, stems: [...candidate.stems] as string[] };
  });
}

function parseSourceFields(value: Record<string, unknown>): {
  sourceUrl: string;
  sourceType: AudioSourceType;
} {
  if (
    typeof value.sourceUrl !== 'string' ||
    !value.sourceUrl ||
    value.sourceUrl.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(value.sourceUrl)
  ) {
    throw new AnalysisRequestError('sourceUrl is invalid');
  }
  if (typeof value.sourceType !== 'string' || !SOURCE_TYPES.has(value.sourceType as AudioSourceType)) {
    throw new AnalysisRequestError('sourceType is invalid');
  }
  return { sourceUrl: value.sourceUrl, sourceType: value.sourceType as AudioSourceType };
}

export async function readBoundedJson(request: Request): Promise<unknown> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new AnalysisRequestError('Content-Type must be application/json', 415);
  }
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_REQUEST_BYTES) {
      throw new AnalysisRequestError('request body is too large', 413);
    }
  }
  if (!request.body) throw new AnalysisRequestError('request body is required');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel('request body is too large');
        throw new AnalysisRequestError('request body is too large', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new AnalysisRequestError('request body is not valid JSON');
  }
}

export function parseAnalysisRequest(value: unknown): AudioAnalysisRequestV1 {
  if (!record(value) || !exactKeys(value, REQUEST_KEYS)) {
    throw new AnalysisRequestError('analysis request shape is invalid');
  }
  if (value.schemaVersion !== AUDIO_ANALYSIS_SCHEMA_VERSION) {
    throw new AnalysisRequestError('analysis schema version is unsupported');
  }
  const source = parseSourceFields(value);
  if (typeof value.instrumentDiscovery !== 'boolean') {
    throw new AnalysisRequestError('instrumentDiscovery must be boolean');
  }
  const coreModels = parseCoreModels(value.coreModels);
  if (
    typeof value.fallbackModel !== 'string' ||
    !coreModels.some((model) => model.id === value.fallbackModel)
  ) {
    throw new AnalysisRequestError('fallbackModel is not an advertised core model');
  }
  return {
    schemaVersion: AUDIO_ANALYSIS_SCHEMA_VERSION,
    ...source,
    coreModels,
    fallbackModel: value.fallbackModel,
    instrumentDiscovery: value.instrumentDiscovery,
  };
}

export function parseFingerprintRequest(value: unknown): AudioFingerprintRequestV1 {
  if (!record(value) || !exactKeys(value, FINGERPRINT_REQUEST_KEYS)) {
    throw new AnalysisRequestError('fingerprint request shape is invalid');
  }
  if (value.schemaVersion !== SOURCE_FINGERPRINT_SCHEMA_VERSION) {
    throw new AnalysisRequestError('fingerprint schema version is unsupported');
  }
  return {
    schemaVersion: SOURCE_FINGERPRINT_SCHEMA_VERSION,
    ...parseSourceFields(value),
  };
}
