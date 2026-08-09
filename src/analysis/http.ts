import type { AudioAnalysisProvider, AudioAnalysisRequestV1 } from './types';
import { AudioAnalysisContractError } from './contract.ts';

const MAX_ANALYSIS_RESPONSE_BYTES = 64 * 1024;

export function audioAnalysisEndpoint(baseUrl: string): string {
  if (baseUrl !== baseUrl.trim()) {
    throw new AudioAnalysisContractError('audio analysis URL is not an approved service origin');
  }
  const configured = new URL(baseUrl);
  const hostname = configured.hostname.toLowerCase();
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
  const railwayPrivate = hostname.endsWith('.railway.internal');
  const transportAllowed =
    configured.protocol === 'https:' ||
    (configured.protocol === 'http:' && (loopback || railwayPrivate));
  if (
    !transportAllowed ||
    configured.username ||
    configured.password ||
    (configured.pathname !== '' && configured.pathname !== '/') ||
    configured.search ||
    configured.hash
  ) {
    throw new AudioAnalysisContractError('audio analysis URL is not an approved service origin');
  }
  configured.pathname = '/v1/analyze';
  return configured.toString();
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_ANALYSIS_RESPONSE_BYTES) {
        await reader.cancel('audio analysis response is too large');
        throw new AudioAnalysisContractError('audio analysis response is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
}

export function httpAudioAnalysisProvider(baseUrl: string, token: string): AudioAnalysisProvider {
  if (
    token.length < 32 ||
    token !== token.trim() ||
    /\s|[\u0000-\u001f\u007f]/.test(token)
  ) {
    throw new AudioAnalysisContractError('audio analysis token is invalid');
  }
  const endpoint = audioAnalysisEndpoint(baseUrl);
  return {
    async analyze(request: AudioAnalysisRequestV1, signal?: AbortSignal): Promise<unknown> {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal,
        // Workerd does not dispatch subrequests with redirect="error". Manual
        // mode is portable and keeps the bearer token on the configured origin;
        // the non-2xx check below rejects every redirect response.
        redirect: 'manual',
      });
      if (!response.ok) throw new Error(`audio analysis failed (${response.status})`);
      const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        throw new AudioAnalysisContractError('audio analysis response is not JSON');
      }
      const declaredHeader = response.headers.get('content-length');
      if (declaredHeader !== null) {
        const declaredLength = Number(declaredHeader);
        if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
          throw new AudioAnalysisContractError('audio analysis content length is invalid');
        }
        if (declaredLength > MAX_ANALYSIS_RESPONSE_BYTES) {
          throw new AudioAnalysisContractError('audio analysis response is too large');
        }
      }
      const text = await readBoundedResponse(response);
      return JSON.parse(text) as unknown;
    },
  };
}
