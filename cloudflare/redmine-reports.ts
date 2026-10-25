import { bugReportActor, type BugReportResult, type BugReportService } from './dev-bug-reports.ts';
import type { GuestContact } from '../public/bug-report/contact.js';

const BASE = 'https://tools.ailab.gc.cuny.edu/help/';
const PROJECT = 15, TRACKER = 2;
type Receipt = { fingerprint: string; state: string; created_at: string; issue_id: number | null };
const REDIRECTS = new Set([301,302,303,307,308]);
const subject = (owner: string, id: string) => `Stem Splitter bug report [stem-report:${owner.slice(0,16)}:${id}]`;
const failure = (code: 'unavailable' | 'redmine_rejected' | 'rate_limited' | 'idempotency_conflict', retryable = false, retryAfterSeconds?: number): BugReportResult =>
  ({ ok: false, code, retryable, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) });

async function redmine(key: string, resource: string, signal: AbortSignal, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json'); headers.set('X-Redmine-API-Key', key);
  // Workers supports manual/follow only. Never forward the API key on redirects.
  const response = await fetch(new URL(resource, BASE), { ...init, headers, redirect: 'manual', signal });
  // A definite rejection needs no body; upstream streams may stall or be huge.
  if (REDIRECTS.has(response.status)) {
    void response.body?.cancel().catch(() => {});
    return { status: response.status, ok: false, data: null };
  }
  const reader = response.body?.getReader();
  let length = 0, text = '';
  const decoder = new TextDecoder();
  try {
    while (reader) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 2 * 1024 * 1024) throw new Error('response_size');
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally { void reader?.cancel().catch(() => {}); }
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* Unreadable replies keep the receipt pending. */ }
  return { status: response.status, ok: response.ok, data };
}

async function findIssue(key: string, owner: string, id: string, at: string, signal: AbortSignal): Promise<number | null> {
  const params = new URLSearchParams({ project_id: String(PROJECT), tracker_id: String(TRACKER), status_id: '*',
    created_on: `>=${new Date(Date.parse(at) - 300000).toISOString()}`, sort: 'created_on:asc', limit: '100' });
  for (let offset = 0; offset < 1000;) {
    params.set('offset', String(offset));
    const { ok, data } = await redmine(key, `issues.json?${params}`, signal);
    if (!ok || !Array.isArray(data?.issues) || !Number.isSafeInteger(data.total_count)) throw new Error('lookup_unavailable');
    const issue = data.issues.find((item: any) => item.subject === subject(owner, id));
    if (issue && Number.isSafeInteger(issue.id) && issue.id > 0) return issue.id;
    offset += data.issues.length;
    if (!data.issues.length || offset >= data.total_count) return null;
  }
  throw new Error('lookup_incomplete');
}

/** Dev-only delivery: account-bound receipts contain no report description. */
export function redmineReports(db: D1Database, key: string): BugReportService {
  async function deliver(report: Parameters<BugReportService['submitAuthenticated']>[0] & { contact?: GuestContact; rateKey?: string }): Promise<BugReportResult> {
    const owner = await bugReportActor(report.contact ? `guest-report-email:v1\n${report.contact.email}` : report.subject), id = report.reportId;
    const table = report.contact ? 'bug_report_guest_receipts' : 'bug_report_receipts';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${id}\n${report.path}\n${report.description}${report.contact ? `\n${JSON.stringify(report.contact)}` : ''}`));
    const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const createdAt = new Date().toISOString();
    try {
      // A single SQL statement reserves the send and daily allowance atomically.
      const since = new Date(Date.now() - 86400000).toISOString();
      const inserted = report.contact ? await db.prepare(`INSERT OR IGNORE INTO bug_report_guest_receipts
        (owner,report_id,fingerprint,created_at,state,issue_id,rate_key)
        SELECT ?,?,?,?,'pending',NULL,? WHERE
        (SELECT count(*) FROM bug_report_guest_receipts WHERE owner=? AND created_at>=?) < 10 AND
        (SELECT count(*) FROM bug_report_guest_receipts WHERE rate_key=? AND created_at>=?) < 20`)
        .bind(owner, id, fingerprint, createdAt, report.rateKey, owner, since, report.rateKey, since).run()
        : await db.prepare(`INSERT OR IGNORE INTO bug_report_receipts
        (owner,report_id,fingerprint,created_at,state,issue_id)
        SELECT ?,?,?,?,'pending',NULL WHERE
        (SELECT count(*) FROM bug_report_receipts WHERE owner=? AND created_at>=?) < 10`)
        .bind(owner, id, fingerprint, createdAt, owner, since).run();
      const receipt = await db.prepare(`SELECT fingerprint,state,created_at,issue_id FROM ${table} WHERE owner=? AND report_id=?`)
        .bind(owner, id).first<Receipt>();
      if (!receipt) return failure('rate_limited', true, 3600);
      if (receipt.fingerprint !== fingerprint) return failure('idempotency_conflict');
      const saved = (): BugReportResult => ({ ok: true, status: 'saved', reportId: id, createdAt: receipt.created_at });
      const save = async (issueId: number) => {
        await db.prepare(`UPDATE ${table} SET state='saved',issue_id=? WHERE owner=? AND report_id=?`).bind(issueId, owner, id).run();
        return saved();
      };
      if (receipt.state === 'saved') return saved();
      if (receipt.state === 'rejected') return failure('redmine_rejected');
      let maySend = inserted.meta.changes === 1;
      if (!maySend && receipt.state === 'retryable') {
        const claim = await db.prepare(`UPDATE ${table} SET state='pending' WHERE owner=? AND report_id=? AND state='retryable'`).bind(owner, id).run();
        maySend = claim.meta.changes === 1;
      }
      const signal = AbortSignal.timeout(15000);
      if (!maySend) {
        // An uncertain delivery can only be looked up, never sent twice.
        const found = await findIssue(key, owner, id, receipt.created_at, signal);
        return found === null ? failure('unavailable', true, 60) : save(found);
      }
      const page = ({ '/': 'Workspace', '/teacher.html': 'Instructor', '/account.html': 'Account', '/classroom.html': 'Classroom' } as Record<string,string>)[report.path];
      const result = await redmine(key, 'issues.json', signal, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue: { project_id: PROJECT, tracker_id: TRACKER, subject: subject(owner, id), is_private: true,
          description: [...(report.contact ? [`Reporter (self-reported): ${report.contact.firstName} ${report.contact.lastName}`, `Contact email (unverified): ${report.contact.email}`]
            : [`CAIL account reference: ${owner.slice(0,16)}`, ...(report.preferredName ? [`SSO preferred name: ${report.preferredName}`] : [])]), `Page: ${page}`, `Stem Splitter release: ${report.release}`,
            `Reported at: ${receipt.created_at}`, `Report reference: ${id}`, '', report.description].join('\n'),
        } }),
      });
      if (result.ok && Number.isSafeInteger(result.data?.issue?.id) && result.data.issue.id > 0) return save(result.data.issue.id);
      if (result.status === 429) {
        await db.prepare(`UPDATE ${table} SET state='retryable' WHERE owner=? AND report_id=?`).bind(owner, id).run();
        return failure('rate_limited', true, 60);
      }
      if (REDIRECTS.has(result.status) || [400,401,403,404,422].includes(result.status)) {
        await db.prepare(`UPDATE ${table} SET state='rejected' WHERE owner=? AND report_id=?`).bind(owner, id).run();
        return failure('redmine_rejected');
      }
    } catch { /* No report text, credentials, or upstream body enters logs. */ }
    return failure('unavailable', true, 60);
  }
  return { submitAuthenticated: deliver, submitGuest: report => deliver({ ...report, subject: '' }) };
}
