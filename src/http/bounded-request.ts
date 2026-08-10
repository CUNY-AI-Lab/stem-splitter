const DEFAULT_MAX_JSON_BYTES = 8 * 1024;
const DEFAULT_JSON_TIMEOUT_MS = 5_000;

export class JsonRequestError extends Error {
  readonly status: 400 | 408 | 413 | 415;

  constructor(message: string, status: 400 | 408 | 413 | 415) {
    super(message);
    this.name = 'JsonRequestError';
    this.status = status;
  }
}

/** Read an inbound JSON body without trusting Content-Length or buffering forever. */
export async function readBoundedJsonRequest(
  request: Request,
  maximumBytes = DEFAULT_MAX_JSON_BYTES,
  timeoutMs = DEFAULT_JSON_TIMEOUT_MS
): Promise<unknown> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json' || request.headers.has('content-encoding')) {
    await request.body?.cancel('JSON request media type was rejected').catch(() => undefined);
    throw new JsonRequestError('Content-Type must be application/json.', 415);
  }

  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      await request.body?.cancel('JSON request length was rejected').catch(() => undefined);
      throw new JsonRequestError('Request body is too large.', 413);
    }
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size > maximumBytes) {
      await request.body?.cancel('JSON request length was rejected').catch(() => undefined);
      throw new JsonRequestError('Request body is too large.', 413);
    }
  }
  if (!request.body) throw new JsonRequestError('Request body is required.', 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new JsonRequestError('Request body timed out.', 408)),
      timeoutMs
    );
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        throw new JsonRequestError('Request body is too large.', 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel('JSON request body was rejected').catch(() => undefined);
    if (error instanceof JsonRequestError) throw error;
    throw new JsonRequestError('Request body could not be read.', 400);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
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
    throw new JsonRequestError('Request body is not valid JSON.', 400);
  }
}
