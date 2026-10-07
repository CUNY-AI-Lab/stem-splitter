/** Vendored CAIL bug-report adapter v1. Keep identical in both PoC repositories.
 * The private Admission entrypoint owns delivery, durable limits and receipts.
 * Browser data never chooses an app, destination, subject, identity or attachment.
 */
export type BugReport = { reportId: string; name: string; email: string; description: string };
type FailureCode = 'invalid' | 'forbidden' | 'idempotency_conflict' | 'rate_limited' | 'delivery_unknown' | 'unavailable';
export type BugReportResult = { ok: true; status: 'accepted'; reportId: string } |
  { ok: false; code: FailureCode; retryable: boolean; retryAfterSeconds?: number; reportId?: string };
export type BugReportService = { submit(report: BugReport & { origin: string; rateKey: string; rateDay: string }): Promise<BugReportResult> };
type Options = {
  app: 'stem-splitter' | 'systems-mapping'; origin: string;
  service?: BugReportService; limiter?: { limit(input: { key: string }): Promise<{ success: boolean }> };
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODES = new Set<FailureCode>(['invalid', 'forbidden', 'idempotency_conflict', 'rate_limited', 'delivery_unknown', 'unavailable']);
const statuses = { invalid: 400, forbidden: 403, idempotency_conflict: 409, rate_limited: 429, delivery_unknown: 503, unavailable: 503 };
function response(result: BugReportResult, status?: number) {
  return Response.json(result, { status: status ?? (result.ok ? 200 : statuses[result.code]), headers: {
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    ...(!result.ok && result.retryAfterSeconds ? { 'Retry-After': String(result.retryAfterSeconds) } : {}),
  } });
}
function failure(code: FailureCode, retryable = false, retryAfterSeconds?: number) {
  return response({ ok: false, code, retryable, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) });
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
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).sort().join(',') !== 'description,email,name,reportId') return null;
    if (!['reportId', 'name', 'email', 'description'].every(key => typeof data[key] === 'string') || !UUID.test(data.reportId)) return null;
    const name = data.name.trim(), email = data.email.trim(), description = data.description.trim();
    if (!name || name.length > 120 || /[\x00-\x1f\x7f\u2028\u2029]/.test(name)) return null;
    if (email.length > 254 || !/^[\x21-\x7e]+@[\x21-\x7e]+\.[\x21-\x7e]+$/.test(email) || /[<>(),;:\\"\[\]]/.test(email)) return null;
    if (description.length < 10 || description.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(description)) return null;
    return { reportId: data.reportId, name, email, description };
  } catch { return null; }
  finally { void reader.cancel().catch(() => {}); }
}

export async function handleBugReport(request: Request, options: Options): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'private, no-store' } });
  if (url.origin !== options.origin || request.headers.get('origin') !== options.origin || request.headers.get('sec-fetch-site') === 'cross-site') return failure('forbidden');
  if (!options.service || !options.limiter) return failure('unavailable', true, 60);
  // Cloudflare supplies this header. Never trust X-Forwarded-For or browser rate keys.
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip || !/^[0-9a-fA-F:.]{3,45}$/.test(ip)) return failure('unavailable', true, 60);
  try {
    const limit = await within(options.limiter.limit({ key: `bug-report:${options.app}:${ip}` }), 3000);
    if (!limit.success) return failure('rate_limited', true, 60);
  } catch { return failure('unavailable', true, 60); }
  const report = await readReport(request);
  if (!report) return failure('invalid');
  const rateDay = new Date().toISOString().slice(0, 10);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cail-bug-report-v1\n${options.app}\n${rateDay}\n${ip}`));
  const rateKey = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  try {
    const result = await within(options.service.submit({ ...report, origin: options.origin, rateKey, rateDay }), 20000);
    if (result?.ok === true && result.status === 'accepted' && result.reportId === report.reportId) {
      return response({ ok: true, status: 'accepted', reportId: report.reportId });
    }
    if (result?.ok === false && CODES.has(result.code) && typeof result.retryable === 'boolean') {
      const retryAfterSeconds = Number.isSafeInteger(result.retryAfterSeconds) && result.retryAfterSeconds! > 0 && result.retryAfterSeconds! <= 86400 ? result.retryAfterSeconds : undefined;
      return response({ ok: false, code: result.code, retryable: result.retryable, reportId: report.reportId,
        ...(retryAfterSeconds ? { retryAfterSeconds } : {}) });
    }
  } catch { /* The receiver may already have dispatched. Do not claim a safe retry. */ }
  return response({ ok: false, code: 'delivery_unknown', retryable: false, reportId: report.reportId });
}
