import { endianness } from 'node:os';
import {
  INSTRUMENT_DISCOVERY_SCHEMA_VERSION,
  MAX_DISCOVERY_WINDOWS,
  MAX_DISCOVERY_WINDOW_SECONDS,
  PINNED_INSTRUMENT_CLASSIFIER_VERSION,
  PINNED_INSTRUMENT_MODEL_SHA256,
  PINNED_INSTRUMENT_VOCABULARY_SHA256,
  PINNED_INSTRUMENT_VOCABULARY_VERSION,
  type InstrumentDetectionV1,
  type InstrumentDiscoveryCode,
  type InstrumentDiscoveryResultV1,
} from '../src/analysis/types.ts';
import { PINNED_INSTRUMENT_LABELS } from '../src/analysis/instrument-vocabulary.ts';
import type { DecodedAnalysisAudio } from './decoder.ts';

const MAX_DISCOVERY_RESPONSE_BYTES = 64 * 1024;

export class InstrumentDiscoveryError extends Error {
  constructor(readonly code: InstrumentDiscoveryCode, message: string = code) {
    super(message);
  }
}

export interface InstrumentDiscoveryProvider {
  discover(
    decoded: DecodedAnalysisAudio,
    signal?: AbortSignal
  ): Promise<InstrumentDiscoveryResultV1>;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function boundedNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function parseDetection(value: unknown, windowsAnalyzed: number): InstrumentDetectionV1 {
  if (
    !record(value) ||
    !exactKeys(value, [
      'id',
      'label',
      'confidence',
      'state',
      'windowSupport',
      'windowsAnalyzed',
    ]) ||
    typeof value.id !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id) ||
    value.id.length > 64 ||
    typeof value.label !== 'string' ||
    !value.label.trim() ||
    value.label !== value.label.trim() ||
    value.label.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(value.label) ||
    PINNED_INSTRUMENT_LABELS.get(value.id) !== value.label ||
    !boundedNumber(value.confidence, 0, 1) ||
    (value.state !== 'possible' && value.state !== 'uncertain') ||
    !Number.isSafeInteger(value.windowSupport) ||
    (value.windowSupport as number) < 1 ||
    (value.windowSupport as number) > windowsAnalyzed ||
    value.windowsAnalyzed !== windowsAnalyzed
  ) {
    throw new InstrumentDiscoveryError(
      'discovery_contract_invalid',
      'instrument discovery returned an invalid detection'
    );
  }
  return {
    id: value.id,
    label: value.label,
    confidence: value.confidence,
    state: value.state,
    windowSupport: value.windowSupport as number,
    windowsAnalyzed,
  };
}

export function parseInstrumentDiscoveryResult(
  value: unknown,
  expectedWindows: number
): InstrumentDiscoveryResultV1 {
  if (
    !record(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'classifier',
      'vocabularyVersion',
      'vocabularySha256',
      'detections',
      'windowsAnalyzed',
      'timingMs',
    ]) ||
    value.schemaVersion !== INSTRUMENT_DISCOVERY_SCHEMA_VERSION ||
    value.vocabularyVersion !== PINNED_INSTRUMENT_VOCABULARY_VERSION ||
    value.vocabularySha256 !== PINNED_INSTRUMENT_VOCABULARY_SHA256 ||
    value.windowsAnalyzed !== expectedWindows ||
    !Number.isSafeInteger(value.windowsAnalyzed) ||
    expectedWindows < 1 ||
    expectedWindows > MAX_DISCOVERY_WINDOWS ||
    !boundedNumber(value.timingMs, 0, 30_000) ||
    !record(value.classifier) ||
    !exactKeys(value.classifier, ['version', 'weightsSha256']) ||
    value.classifier.version !== PINNED_INSTRUMENT_CLASSIFIER_VERSION ||
    value.classifier.weightsSha256 !== PINNED_INSTRUMENT_MODEL_SHA256 ||
    !Array.isArray(value.detections) ||
    value.detections.length > 12
  ) {
    throw new InstrumentDiscoveryError(
      'discovery_contract_invalid',
      'instrument discovery response does not match the pinned contract'
    );
  }

  const seen = new Set<string>();
  const detections = value.detections.map((candidate) => {
    const detection = parseDetection(candidate, expectedWindows);
    if (seen.has(detection.id)) {
      throw new InstrumentDiscoveryError(
        'discovery_contract_invalid',
        `instrument discovery duplicated ${detection.id}`
      );
    }
    seen.add(detection.id);
    return detection;
  });

  return {
    schemaVersion: INSTRUMENT_DISCOVERY_SCHEMA_VERSION,
    classifier: {
      version: PINNED_INSTRUMENT_CLASSIFIER_VERSION,
      weightsSha256: PINNED_INSTRUMENT_MODEL_SHA256,
    },
    vocabularyVersion: PINNED_INSTRUMENT_VOCABULARY_VERSION,
    vocabularySha256: PINNED_INSTRUMENT_VOCABULARY_SHA256,
    detections,
    windowsAnalyzed: expectedWindows,
    timingMs: value.timingMs,
  };
}

export function instrumentDiscoveryEndpoint(baseUrl: string): string {
  let configured: URL;
  try {
    configured = new URL(baseUrl.trim());
  } catch {
    throw new InstrumentDiscoveryError(
      'discovery_unconfigured',
      'instrument discovery URL is invalid'
    );
  }
  const hostname = configured.hostname.toLowerCase();
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
  const railwayPrivate = hostname.endsWith('.railway.internal');
  if (
    !(loopback || railwayPrivate) ||
    (configured.protocol !== 'https:' && configured.protocol !== 'http:') ||
    configured.username ||
    configured.password ||
    (configured.pathname !== '' && configured.pathname !== '/') ||
    configured.search ||
    configured.hash
  ) {
    throw new InstrumentDiscoveryError(
      'discovery_unconfigured',
      'instrument discovery URL is not an approved private service origin'
    );
  }
  configured.pathname = '/v1/classify';
  return configured.toString();
}

export function discoveryWindowSampleCounts(decoded: DecodedAnalysisAudio): number[] {
  const maximum = decoded.sampleRate * MAX_DISCOVERY_WINDOW_SECONDS;
  const counts: number[] = [];
  for (const sourceCount of decoded.windowSampleCounts) {
    if (!Number.isSafeInteger(sourceCount) || sourceCount < 1) {
      throw new InstrumentDiscoveryError(
        'discovery_contract_invalid',
        'decoded discovery window is invalid'
      );
    }
    const parts = Math.ceil(sourceCount / maximum);
    for (let part = 0; part < parts; part += 1) {
      const start = Math.floor((part * sourceCount) / parts);
      const end = Math.floor(((part + 1) * sourceCount) / parts);
      counts.push(end - start);
    }
  }
  if (
    counts.length < 1 ||
    counts.length > MAX_DISCOVERY_WINDOWS ||
    counts.reduce((sum, count) => sum + count, 0) !== decoded.samples.length
  ) {
    throw new InstrumentDiscoveryError(
      'discovery_contract_invalid',
      'decoded discovery windows exceed the contract'
    );
  }
  return counts;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new InstrumentDiscoveryError(
      'discovery_contract_invalid',
      'instrument discovery response is not JSON'
    );
  }
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_DISCOVERY_RESPONSE_BYTES) {
      throw new InstrumentDiscoveryError(
        'discovery_contract_invalid',
        'instrument discovery response is too large'
      );
    }
  }
  if (!response.body) {
    throw new InstrumentDiscoveryError(
      'discovery_contract_invalid',
      'instrument discovery response body is missing'
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DISCOVERY_RESPONSE_BYTES) {
        await reader.cancel('instrument discovery response is too large');
        throw new InstrumentDiscoveryError(
          'discovery_contract_invalid',
          'instrument discovery response is too large'
        );
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
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    );
  } catch {
    throw new InstrumentDiscoveryError(
      'discovery_contract_invalid',
      'instrument discovery response is not valid JSON'
    );
  }
}

function discoverySignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup(): void;
  timedOut(): boolean;
} {
  const controller = new AbortController();
  let timeout = false;
  const onAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', onAbort, { once: true });
  if (parent?.aborted) onAbort();
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(new Error('instrument discovery timeout'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
    timedOut: () => timeout,
  };
}

export function httpInstrumentDiscoveryProvider(input: {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}): InstrumentDiscoveryProvider {
  if (
    input.token.length < 32 ||
    input.token !== input.token.trim() ||
    /\s|[\u0000-\u001f\u007f]/.test(input.token)
  ) {
    throw new InstrumentDiscoveryError(
      'discovery_unconfigured',
      'instrument discovery token is invalid'
    );
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 20_000) {
    throw new InstrumentDiscoveryError(
      'discovery_unconfigured',
      'instrument discovery timeout is invalid'
    );
  }
  if (endianness() !== 'LE') {
    throw new InstrumentDiscoveryError(
      'discovery_unconfigured',
      'instrument discovery requires a little-endian runtime'
    );
  }
  const endpoint = instrumentDiscoveryEndpoint(input.baseUrl);
  return {
    async discover(decoded, parentSignal) {
      const windowSampleCounts = discoveryWindowSampleCounts(decoded);
      const body = new Uint8Array(
        decoded.samples.buffer,
        decoded.samples.byteOffset,
        decoded.samples.byteLength
      );
      const scoped = discoverySignal(parentSignal, input.timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${input.token}`,
            'Content-Type': 'application/octet-stream',
            'X-Audio-Sample-Rate': String(decoded.sampleRate),
            'X-Audio-Window-Samples': windowSampleCounts.join(','),
            'X-Discovery-Schema-Version': INSTRUMENT_DISCOVERY_SCHEMA_VERSION,
            'X-Expected-Classifier-Version': PINNED_INSTRUMENT_CLASSIFIER_VERSION,
            'X-Expected-Weights-SHA256': PINNED_INSTRUMENT_MODEL_SHA256,
            'X-Vocabulary-Version': PINNED_INSTRUMENT_VOCABULARY_VERSION,
            'X-Vocabulary-SHA256': PINNED_INSTRUMENT_VOCABULARY_SHA256,
          },
          body,
          signal: scoped.signal,
          redirect: 'manual',
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new InstrumentDiscoveryError(
            'discovery_unavailable',
            `instrument discovery failed (${response.status})`
          );
        }
        return parseInstrumentDiscoveryResult(
          await readBoundedJson(response),
          windowSampleCounts.length
        );
      } catch (error) {
        if (error instanceof InstrumentDiscoveryError) throw error;
        if (scoped.timedOut()) {
          throw new InstrumentDiscoveryError('discovery_timeout');
        }
        throw new InstrumentDiscoveryError('discovery_unavailable');
      } finally {
        scoped.cleanup();
      }
    },
  };
}
