/** Anonymous reporting is separate from all course and account authorization. */
export type BugReport = { reportId: string; description: string; path: string };
type FailureCode = 'invalid' | 'forbidden' | 'delivery_unknown' | 'idempotency_conflict' | 'rate_limited' | 'unavailable';
export type BugReportResult = { ok: true; status: 'accepted'; reportId: string } |
  { ok: false; code: FailureCode; retryable: boolean; retryAfterSeconds?: number };
export type BugReportService = {
  submitPublic(report: { reportId: string; description: string; origin: string; path: string; release: string; rateKey: string; rateDay: string }): Promise<BugReportResult>;
};
type Options = {
  origin: string; release?: string;
  service?: BugReportService; limiter?: { limit(input: { key: string }): Promise<{ success: boolean }> };
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PATHS = new Set(['/', '/teacher.html', '/account.html', '/classroom.html']);
const CODES = new Set<FailureCode>(['invalid', 'forbidden', 'delivery_unknown', 'idempotency_conflict', 'rate_limited', 'unavailable']);
const statuses = { invalid: 400, forbidden: 403, delivery_unknown: 503, idempotency_conflict: 409, rate_limited: 429, unavailable: 503 };
function response(result: unknown, status = 200, retryAfterSeconds?: number) {
  return Response.json(result, { status, headers: {
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    ...(retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {}),
  } });
}
function failure(code: FailureCode, retryable = false, retryAfterSeconds?: number) {
  return response({ ok: false, code, retryable, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) }, statuses[code], retryAfterSeconds);
}
function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), milliseconds); })])
    .finally(() => clearTimeout(timer));
}
async function readReport(request: Request): Promise<BugReport | null> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || !request.body) return null;
  const claimed = request.headers.get('content-length');
  if (claimed && (!/^\d+$/.test(claimed) || Number(claimed) > 16384)) return null;
  const reader = request.body.getReader();
  try {
    const text = await within((async () => {
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }); let text = '', bytes = 0;
      while (true) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength; if (bytes > 16384) throw new Error('size');
        text += decoder.decode(part.value, { stream: true });
      }
      return text + decoder.decode();
    })(), 5000);
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).sort().join(',') !== 'description,path,reportId') return null;
    if (!['reportId', 'description', 'path'].every(key => typeof data[key] === 'string') || !UUID.test(data.reportId)) return null;
    if (!PATHS.has(data.path) || data.description.length > 4000) return null;
    const description = data.description.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').trim();
    if (description.length < 10 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(description)) return null;
    return { reportId: data.reportId, description, path: data.path };
  } catch { return null; }
  finally { void reader.cancel().catch(() => {}); }
}

export async function handleBugReport(request: Request, options: Options): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/bug-reports') return new Response(null, { status: 404 });
  if (request.method !== 'POST') return new Response(null, {
    status: 405, headers: { Allow: 'POST', 'Cache-Control': 'private, no-store' },
  });
  if (url.origin !== options.origin || request.headers.get('sec-fetch-site') === 'cross-site' ||
      request.headers.get('origin') !== options.origin) return failure('forbidden');
  if (url.search) return failure('invalid');
  const referer = request.headers.get('referer');
  if (referer) {
    try { if (new URL(referer).origin !== options.origin) return failure('forbidden'); }
    catch { return failure('forbidden'); }
  }
  if (!options.limiter) return failure('unavailable', true, 60);
  // Cloudflare supplies this header. Only its daily digest reaches Admission.
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip || !/^[0-9a-fA-F:.]{3,45}$/.test(ip)) return failure('unavailable', true, 60);
  try {
    const limit = await within(options.limiter.limit({ key: `bug-report:stem-splitter:${ip}` }), 3000);
    if (!limit.success) return failure('rate_limited', true, 60);
  } catch { return failure('unavailable', true, 60); }
  if (!options.service || !options.release || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(options.release)) return failure('unavailable', true, 60);
  const report = await readReport(request);
  if (!report) return failure('invalid');
  if (request.signal.aborted) return failure('unavailable', true);
  const rateDay = new Date().toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cail-public-report:stem-splitter:${rateDay}:${ip}`));
  const rateKey = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (request.signal.aborted) return failure('unavailable', true);
  try {
    const result = await within(options.service.submitPublic({ reportId: report.reportId, rateKey, rateDay,
      description: report.description, origin: options.origin, path: report.path, release: options.release }), 20000);
    if (result?.ok === true && result.status === 'accepted' && result.reportId === report.reportId) {
      return response({ ok: true, status: 'accepted', reportId: report.reportId });
    }
    if (result?.ok === false && CODES.has(result.code) && typeof result.retryable === 'boolean') {
      const retryAfterSeconds = Number.isSafeInteger(result.retryAfterSeconds) && result.retryAfterSeconds! > 0 && result.retryAfterSeconds! <= 86400 ? result.retryAfterSeconds : undefined;
      return failure(result.code, result.code === 'delivery_unknown' ? false : result.retryable, retryAfterSeconds);
    }
  } catch { /* A send may have completed; the same reference can safely check its receipt. */ }
  return failure('delivery_unknown', false);
}
