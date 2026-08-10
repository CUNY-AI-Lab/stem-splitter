export interface BoundedResponseErrors {
  tooLarge(): Error;
  timedOut(): Error;
  unreadable(): Error;
}

export interface BoundedResponseOptions {
  maximumBytes: number;
  timeoutMs: number;
  errors: BoundedResponseErrors;
}

/**
 * Read a fetch response without trusting Content-Length or buffering an
 * unbounded body. The timeout covers the complete body read, including a
 * provider that sends headers and then stalls indefinitely.
 */
export async function readBoundedResponse(
  response: Response,
  options: BoundedResponseOptions
): Promise<ArrayBuffer> {
  const { maximumBytes, timeoutMs, errors } = options;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError('maximumBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('timeoutMs must be a positive safe integer');
  }

  const declaredHeader = response.headers.get('content-length');
  if (declaredHeader !== null) {
    if (!/^\d+$/.test(declaredHeader)) {
      await response.body?.cancel('provider content length was invalid').catch(() => undefined);
      throw errors.unreadable();
    }
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared)) {
      await response.body?.cancel('provider content length was invalid').catch(() => undefined);
      throw errors.unreadable();
    }
    if (declared > maximumBytes) {
      await response.body?.cancel('provider response body was too large').catch(() => undefined);
      throw errors.tooLarge();
    }
  }
  if (!response.body) return new ArrayBuffer(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const expectedErrors = new Set<Error>();
  const mappedError = (factory: () => Error): Error => {
    const error = factory();
    expectedErrors.add(error);
    return error;
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(mappedError(() => errors.timedOut())), timeoutMs);
  });

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw mappedError(() => errors.tooLarge());
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel('provider response body was rejected').catch(() => undefined);
    if (error instanceof Error && expectedErrors.has(error)) throw error;
    throw errors.unreadable();
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

export function responseMediaType(response: Response): string {
  return response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
}
