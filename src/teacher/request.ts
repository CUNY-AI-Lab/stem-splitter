const DEFAULT_MAX_TEACHER_JSON_BYTES = 8 * 1024;
const DEFAULT_TEACHER_JSON_TIMEOUT_MS = 5_000;

export class TeacherRequestError extends Error {
  readonly status: 400 | 408 | 413 | 415;

  constructor(message: string, status: 400 | 408 | 413 | 415) {
    super(message);
    this.status = status;
  }
}

/** Read a teacher-only JSON body without trusting Content-Length or buffering forever. */
export async function readBoundedTeacherJson(
  request: Request,
  maximumBytes = DEFAULT_MAX_TEACHER_JSON_BYTES,
  timeoutMs = DEFAULT_TEACHER_JSON_TIMEOUT_MS
): Promise<unknown> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json' || request.headers.has('content-encoding')) {
    throw new TeacherRequestError('Content-Type must be application/json.', 415);
  }

  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) {
      throw new TeacherRequestError('Request body is too large.', 413);
    }
  }
  if (!request.body) throw new TeacherRequestError('Request body is required.', 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new TeacherRequestError('Request body timed out.', 408)),
      timeoutMs
    );
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        throw new TeacherRequestError('Request body is too large.', 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel('teacher request body was rejected').catch(() => undefined);
    if (error instanceof TeacherRequestError) throw error;
    throw new TeacherRequestError('Request body could not be read.', 400);
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
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new TeacherRequestError('Request body is not valid JSON.', 400);
  }
}
