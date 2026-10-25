const footer = document.querySelector('main footer') || document.querySelector('footer');
const paths = new Map([['/', '/'], ['/index.html', '/'], ['/account', '/account.html'], ['/account.html', '/account.html'],
  ['/teacher', '/teacher.html'], ['/teacher.html', '/teacher.html'], ['/classroom', '/classroom.html'], ['/classroom.html', '/classroom.html']]);
const path = paths.get(location.pathname) || '/';
let checking = false, mounted = false, attempts = 0, retryTimer, recovery;

// Availability checks never submit a report. Once mounted, preserve the same form
// and draft; availability recovery must not replace it or repeat a send.
function showRecovery() {
  if (!recovery) {
    recovery = document.createElement('section');
    recovery.className = 'footer-feedback-slot';
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = 'Problem reporting is temporarily unavailable.';
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'account-button';
    button.textContent = 'Retry problem reporting';
    button.addEventListener('click', () => void mountAvailableReport(true));
    recovery.append(status, button); footer.append(recovery);
  }
  recovery.querySelector('button').disabled = checking;
}
async function mountAvailableReport(explicit = false) {
  if (!footer || mounted || checking || footer.querySelector('.bug-report') || (!explicit && attempts >= 3)) return;
  clearTimeout(retryTimer);
  const restoreFocus = recovery?.contains(document.activeElement);
  checking = true; attempts++;
  if (recovery) recovery.querySelector('button').disabled = true;
  try {
    const response = await fetch('/api/bug-reports/availability', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('availability');
    const availability = await response.json();
    // A deliberately disabled receiver has no form or automatic retries.
    if (availability.enabled === false) { recovery?.remove(); recovery = null; attempts = 3; return; }
    if (availability.enabled !== true) throw new Error('availability');
    const dev = ['contact', 'dev-contact'].includes(availability.mode);
    const { mountBugReport } = await import(dev ? './bug-report/dev-form.js' : './bug-report/form.js');
    if (dev && !document.querySelector('link[href="/bug-report/dev-form.css"]')) {
      const style = document.createElement('link');
      style.rel = 'stylesheet'; style.href = '/bug-report/dev-form.css'; document.head.append(style);
    }
    const container = document.createElement('section');
    container.className = 'footer-feedback-slot';
    const report = mountBugReport(container, { path: () => path, loginUrl: '/auth/login?next=' + encodeURIComponent(path), loginClassName: 'account-button' });
    footer.append(container); recovery?.remove(); recovery = null; mounted = true;
    window.removeEventListener('online', retryAvailableReport);
    window.removeEventListener('focus', retryAvailableReport);
    window.StemReportDraft = { hasDraft: report.hasDraft, sessionChanged: report.sessionChanged };
    if (restoreFocus && document.activeElement === document.body) container.querySelector('.bug-report__trigger')?.focus();
  } catch {
    showRecovery();
    if (attempts < 3) retryTimer = setTimeout(() => void mountAvailableReport(), attempts === 1 ? 2000 : 10000);
  } finally {
    checking = false;
    if (recovery) recovery.querySelector('button').disabled = false;
  }
}
function retryAvailableReport() { void mountAvailableReport(); }
window.addEventListener('online', retryAvailableReport);
window.addEventListener('focus', retryAvailableReport);
void mountAvailableReport();
