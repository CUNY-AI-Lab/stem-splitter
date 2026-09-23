export async function withSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

export async function deadline<T>(callback: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, milliseconds: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Request expired', 'TimeoutError')), milliseconds);
  try { return await callback(AbortSignal.any([signal, controller.signal])); }
  finally { clearTimeout(timer); }
}

export function cancel(body: ReadableStream | null | undefined) {
  try { void body?.cancel().catch(() => {}); } catch { /* Best effort, never block cancellation. */ }
}

export async function boundedText(response: Response, signal: AbortSignal, maximum = 262144) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let text = '', bytes = 0;
  try {
    for (;;) {
      const { done, value } = await withSignal(reader.read(), signal);
      if (value) bytes += value.byteLength;
      if (bytes > maximum) throw new Error('response_size');
      text += decoder.decode(value, { stream: !done });
      if (done) return text;
    }
  } finally {
    try { void reader.cancel().catch(() => {}); } catch { /* Best effort. */ }
    reader.releaseLock();
  }
}
