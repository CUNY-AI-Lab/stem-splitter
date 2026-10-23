/** The Worker supplies a verified principal; the delivery adapter owns receipts. */
import { parseGuestContact, type GuestContact } from '../public/bug-report/contact.js';
export type BugReport = { reportId: string; description: string; path: string; expectedActor: string };
type FailureCode = 'invalid' | 'forbidden' | 'not_admitted' | 'idempotency_conflict' | 'rate_limited' | 'unavailable' | 'redmine_rejected';
export type BugReportResult = { ok: true; status: 'saved'; reportId: string; createdAt: string } |
  { ok: false; code: FailureCode; retryable: boolean; retryAfterSeconds?: number };
export type BugReportService = {
  submitAuthenticated(report: { reportId: string; subject: string; preferredName?: string | null; description: string; origin: string; path: string; release: string }): Promise<BugReportResult>;
  submitGuest?(report: { reportId: string; contact: GuestContact; rateKey: string; description: string; origin: string; path: string; release: string }): Promise<BugReportResult>;
};
type Options = {
  origin: string; subject: string; preferredName?: string | null; release?: string;
  service?: BugReportService; limiter?: { limit(input: { key: string }): Promise<{ success: boolean }> };
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PATHS = new Set(['/', '/teacher.html', '/account.html', '/classroom.html']);
const CODES = new Set<FailureCode>(['invalid', 'forbidden', 'not_admitted', 'idempotency_conflict', 'rate_limited', 'unavailable', 'redmine_rejected']);
const statuses = { invalid: 400, forbidden: 403, not_admitted: 403, idempotency_conflict: 409, rate_limited: 429, unavailable: 503, account_changed: 409, redmine_rejected: 502 };
function response(result: unknown, status = 200, retryAfterSeconds?: number) {
  return Response.json(result, { status, headers: {
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    ...(retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {}),
  } });
}
function failure(code: FailureCode | 'account_changed', retryable = false, retryAfterSeconds?: number) {
  return response({ ok: false, code, retryable, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) }, statuses[code], retryAfterSeconds);
}
function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), milliseconds); })])
    .finally(() => clearTimeout(timer));
}
/** Comparison marker only: it cannot authenticate a request or choose its reporter. */
export async function bugReportActor(subject: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cail-bug-report-actor:v1\n${subject}`));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function readReport(request: Request, guest = false): Promise<(Omit<BugReport, 'expectedActor'> & { expectedActor?: string; firstName?: unknown; lastName?: unknown; email?: unknown }) | null> {
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
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).sort().join(',') !== (guest ? 'description,email,firstName,lastName,path,reportId' : 'description,expectedActor,path,reportId')) return null;
    if (!['reportId', 'description', 'path'].every(key => typeof data[key] === 'string') || !UUID.test(data.reportId)) return null;
    if (!PATHS.has(data.path) || (!guest && (typeof data.expectedActor !== 'string' || !/^[0-9a-f]{64}$/.test(data.expectedActor))) || data.description.length > 4000) return null;
    const description = data.description.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').trim();
    if (description.length < 10 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(description)) return null;
    return { ...data, description };
  } catch { return null; }
  finally { void reader.cancel().catch(() => {}); }
}

export async function handleBugReport(request: Request, options: Options): Promise<Response> {
  const url = new URL(request.url);
  const session = url.pathname === '/api/bug-reports/session';
  if (request.method !== (session ? 'GET' : 'POST')) return new Response(null, {
    status: 405, headers: { Allow: session ? 'GET' : 'POST', 'Cache-Control': 'private, no-store' },
  });
  if (url.origin !== options.origin || request.headers.get('sec-fetch-site') === 'cross-site' ||
      (session ? request.headers.has('origin') && request.headers.get('origin') !== options.origin : request.headers.get('origin') !== options.origin)) return failure('forbidden');
  if (url.search) return failure('invalid');
  if (!/^cail-[0-9a-f]{32}$/.test(options.subject)) return failure('forbidden');
  if (!options.limiter) return failure('unavailable', true, 60);
  // Cloudflare supplies this header. The delivery adapter never receives the IP.
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip || !/^[0-9a-fA-F:.]{3,45}$/.test(ip)) return failure('unavailable', true, 60);
  try {
    const limit = await within(options.limiter.limit({ key: `bug-report:stem-splitter:${ip}` }), 3000);
    if (!limit.success) return failure('rate_limited', true, 60);
  } catch { return failure('unavailable', true, 60); }
  const expectedActor = await bugReportActor(options.subject);
  if (session) return response({ ok: true, expectedActor, preferredName: options.preferredName ?? null });
  if (!options.service || !options.release || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(options.release)) return failure('unavailable', true, 60);
  const report = await readReport(request);
  if (!report) return failure('invalid');
  if (report.expectedActor !== expectedActor) return failure('account_changed');
  return deliveryResponse(options.service.submitAuthenticated({ reportId: report.reportId, subject: options.subject, preferredName: options.preferredName,
    description: report.description, origin: options.origin, path: report.path, release: options.release }), report.reportId);
}

export async function handleGuestBugReport(request: Request, options: Omit<Options, 'subject'> & { rateKey: string }): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  if (url.origin !== options.origin || request.headers.get('origin') !== options.origin || request.headers.get('sec-fetch-site') === 'cross-site') return failure('forbidden');
  if (url.search) return failure('invalid');
  if (!options.service?.submitGuest || !options.release || !options.limiter || !/^[0-9a-f]{64}$/.test(options.rateKey)) return failure('unavailable', true, 60);
  try {
    const limit = await within(options.limiter.limit({ key: `guest-report:stem-splitter:${options.rateKey}` }), 3000);
    if (!limit.success) return failure('rate_limited', true, 60);
  } catch { return failure('unavailable', true, 60); }
  const report = await readReport(request, true);
  if (!report) return failure('invalid');
  const parsed = parseGuestContact(report);
  if (!parsed.ok) return response({ ok: false, code: 'invalid_contact', fields: parsed.errors }, 400);
  return deliveryResponse(options.service.submitGuest({ reportId: report.reportId, contact: parsed.contact, rateKey: options.rateKey,
    description: report.description, origin: options.origin, path: report.path, release: options.release }), report.reportId);
}

async function deliveryResponse(delivery: Promise<BugReportResult>, reportId: string): Promise<Response> {
  try {
    const result = await within(delivery, 20000);
    if (result?.ok === true && result.status === 'saved' && result.reportId === reportId &&
        typeof result.createdAt === 'string' && Number.isFinite(Date.parse(result.createdAt)) && new Date(result.createdAt).toISOString() === result.createdAt) {
      return response({ ok: true, status: 'saved', reportId, createdAt: result.createdAt });
    }
    if (result?.ok === false && CODES.has(result.code) && typeof result.retryable === 'boolean') {
      const retryAfterSeconds = Number.isSafeInteger(result.retryAfterSeconds) && result.retryAfterSeconds! > 0 && result.retryAfterSeconds! <= 86400 ? result.retryAfterSeconds : undefined;
      return failure(result.code, result.retryable, retryAfterSeconds);
    }
  } catch { /* The durable record may exist. An explicit retry must keep its UUID and text. */ }
  return failure('unavailable', true);
}
