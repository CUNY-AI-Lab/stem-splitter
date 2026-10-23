
const footer = document.querySelector('main footer') || document.querySelector('footer');
const paths = new Map([['/', '/'], ['/index.html', '/'], ['/account', '/account.html'], ['/account.html', '/account.html'],
  ['/teacher', '/teacher.html'], ['/teacher.html', '/teacher.html'], ['/classroom', '/classroom.html'], ['/classroom.html', '/classroom.html']]);
const path = paths.get(location.pathname) || '/';
// The receiver is released separately. Do not offer a form without its binding.
async function reportingAvailable() {
  try {
    const response = await fetch('/api/bug-reports/availability', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const state = await response.json();
    return state.enabled === true ? state : null;
  } catch { return null; }
}
async function mountAvailableReport() {
  if (!footer || footer.querySelector('.bug-report')) return;
  const availability = await reportingAvailable();
  if (!availability) return;
  const dev = availability.mode === 'dev-contact';
  const { mountBugReport } = await import(dev ? './bug-report/dev-form.js' : './bug-report/form.js');
  if (dev) {
    const style = document.createElement('link'); style.rel = 'stylesheet';
    style.href = '/bug-report/dev-form.css'; document.head.append(style);
  }
  const container = document.createElement('section');
  container.className = 'footer-feedback-slot';
  footer.append(container);
  const report = mountBugReport(container, { path: () => path, loginUrl: '/auth/login?next=' + encodeURIComponent(path), loginClassName: 'account-button' });
  // Session expiry clears private app contents while this anonymous draft stays in memory.
  window.StemReportDraft = { hasDraft: report.hasDraft, sessionChanged: report.sessionChanged };
}
void mountAvailableReport();
