import { mountBugReport } from './bug-report/form.js';

const footer = document.querySelector('main footer') || document.querySelector('footer');
const paths = new Map([['/', '/'], ['/index.html', '/'], ['/account', '/account.html'], ['/account.html', '/account.html'],
  ['/teacher', '/teacher.html'], ['/teacher.html', '/teacher.html'], ['/classroom', '/classroom.html'], ['/classroom.html', '/classroom.html']]);
const path = paths.get(location.pathname) || '/';
// The receiver is released separately. Do not offer a form without its binding.
async function reportingAvailable() {
  try {
    const response = await fetch('/api/bug-reports/availability', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    return response.ok && (await response.json()).enabled === true;
  } catch { return false; }
}
async function mountAvailableReport() {
  if (!footer || footer.querySelector('.bug-report') || !await reportingAvailable()) return;
  const container = document.createElement('section');
  footer.append(container);
  const report = mountBugReport(container, { path: () => path });
  // Session expiry clears private app contents while this anonymous draft stays in memory.
  window.StemReportDraft = { hasDraft: report.hasDraft, sessionChanged: report.sessionChanged };
}
void mountAvailableReport();
