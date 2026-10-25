import { bugReportActor, type BugReportService, type BugReportResult } from './dev-bug-reports.ts';
import type { BugReportService as EmailService } from './bug-reports.ts';
import { redmineReports } from './redmine-reports.ts';

type Input = Parameters<BugReportService['submitAuthenticated']>[0] & {
  contact?: Parameters<NonNullable<BugReportService['submitGuest']>>[0]['contact']; rateKey?: string;
};
type Receipt = { fingerprint: string; created_at: string; delivery: 'redmine' | 'email'; state: string };
const unknown = (): BugReportResult => ({ ok: false, code: 'delivery_unknown', retryable: false });
const unavailable = (): BugReportResult => ({ ok: false, code: 'unavailable', retryable: true, retryAfterSeconds: 60 });
/** Local report text plus transport receipt; raw identity/contact/IP never enter D1. */
export function reportDelivery(db: D1Database, key?: string, email?: EmailService): BugReportService {
  async function submit(report: Input): Promise<BugReportResult> {
    const owner = await bugReportActor(report.contact ? `guest-report-email:v1\n${report.contact.email}` : report.subject);
    const fingerprint = await bugReportActor(JSON.stringify([report.reportId, report.path, report.description, report.contact ?? null]));
    const at = new Date().toISOString(), since = new Date(Date.now() - 86400000).toISOString();
    const rate = report.rateKey ?? owner;
    try {
      const legacyTable = report.contact ? 'bug_report_guest_receipts' : 'bug_report_receipts';
      const legacy = await db.prepare(`SELECT fingerprint,state FROM ${legacyTable} WHERE owner=? AND report_id=?`).bind(owner, report.reportId).first<{fingerprint:string;state:string}>();
      if (legacy) {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${report.reportId}\n${report.path}\n${report.description}${report.contact ? `\n${JSON.stringify(report.contact)}` : ''}`));
        const oldFingerprint = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
        if (legacy.fingerprint !== oldFingerprint) return {ok:false,code:'idempotency_conflict',retryable:false};
      }
      const initialDelivery = legacy && legacy.state !== 'rejected' ? 'redmine' : key && !legacy ? 'redmine' : 'email';
      await db.prepare(`INSERT OR IGNORE INTO bug_report_deliveries
        (owner,report_id,fingerprint,description,path,release,created_at,delivery,state,rate_key)
        SELECT ?,?,?,?,?,?,?,?,'pending',? WHERE
        (SELECT count(*) FROM bug_report_deliveries WHERE owner=? AND created_at>=?) < 10 AND
        (SELECT count(*) FROM bug_report_deliveries WHERE rate_key=? AND created_at>=?) < 20`)
        .bind(owner, report.reportId, fingerprint, report.description, report.path, report.release, at, initialDelivery, rate, owner, since, rate, since).run();
      let receipt = await db.prepare('SELECT fingerprint,created_at,delivery,state FROM bug_report_deliveries WHERE owner=? AND report_id=?')
        .bind(owner, report.reportId).first<Receipt>();
      if (!receipt) return { ok: false, code: 'rate_limited', retryable: true, retryAfterSeconds: 3600 };
      if (receipt.fingerprint !== fingerprint) return { ok: false, code: 'idempotency_conflict', retryable: false };
      const saved = (): BugReportResult => ({ ok: true, status: 'saved', reportId: report.reportId, createdAt: receipt!.created_at, delivery: receipt!.delivery });
      if (receipt.state === 'accepted') return saved();
      if (receipt.delivery === 'redmine' && legacy?.state === 'saved') {
        await db.prepare("UPDATE bug_report_deliveries SET state='accepted' WHERE owner=? AND report_id=? AND delivery='redmine'").bind(owner, report.reportId).run();
        return saved();
      }
      if (receipt.delivery === 'redmine') {
        if (!key) return unavailable(); // Never change transport when an earlier send may have succeeded.
        const adapter = redmineReports(db, key);
        const result = report.contact ? await adapter.submitGuest!({ ...report, contact: report.contact, rateKey: rate }) : await adapter.submitAuthenticated(report);
        if (result.ok) {
          await db.prepare("UPDATE bug_report_deliveries SET state='accepted' WHERE owner=? AND report_id=? AND delivery='redmine'").bind(owner, report.reportId).run();
          return saved();
        }
        if (result.code === 'idempotency_conflict') return result;
        // Only a definite upstream rejection permits a different transport. An
        // unreadable response, timeout, or failed receipt write must stay Redmine.
        const table = report.contact ? 'bug_report_guest_receipts' : 'bug_report_receipts';
        const prior = await db.prepare(`SELECT state FROM ${table} WHERE owner=? AND report_id=?`).bind(owner, report.reportId).first<{state:string}>();
        if (prior?.state !== 'rejected') return result;
        await db.prepare("UPDATE bug_report_deliveries SET delivery='email',state='pending' WHERE owner=? AND report_id=? AND delivery='redmine'").bind(owner, report.reportId).run();
        receipt = { ...receipt, delivery: 'email', state: 'pending' };
      }
      if (!email) return unavailable();
      // Admission owns the durable claim and deduplication before SES. All
      // replays retain this exact UUID/body, including after lost acknowledgments.
      let result: Awaited<ReturnType<EmailService['submitPublic']>>;
      try { result = await email.submitPublic({ reportId: report.reportId, description: report.description,
        origin: report.origin, path: report.path, release: report.release, rateKey: rate, rateDay: at.slice(0,10) }); } catch {
        await db.prepare("UPDATE bug_report_deliveries SET state='unknown' WHERE owner=? AND report_id=? AND delivery='email' AND state!='accepted'").bind(owner, report.reportId).run();
        return unknown();
      }
      const accepted = result?.ok === true && result.status === 'accepted' && result.reportId === report.reportId;
      const state = accepted ? 'accepted' : result?.ok === false && result.code === 'delivery_unknown' ? 'unknown' : 'pending';
      await db.prepare('UPDATE bug_report_deliveries SET state=? WHERE owner=? AND report_id=? AND delivery=\'email\' AND state!=\'accepted\'')
        .bind(state, owner, report.reportId).run();
      if (accepted) return saved();
      if (state === 'unknown') return unknown();
      if (result?.ok === false && ['rate_limited','idempotency_conflict','forbidden','invalid','unavailable'].includes(result.code)) return result as BugReportResult;
      return unavailable();
    } catch { return unavailable(); }
  }
  return { submitAuthenticated: submit, submitGuest: report => submit({ ...report, subject: '' }) };
}
