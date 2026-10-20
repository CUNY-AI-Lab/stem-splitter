import { mountBugReport } from './bug-report/form.js';

const footer = document.querySelector('main footer') || document.querySelector('footer');
const paths = new Map([['/', '/'], ['/index.html', '/'], ['/account', '/account.html'], ['/account.html', '/account.html'],
  ['/teacher', '/teacher.html'], ['/teacher.html', '/teacher.html'], ['/classroom', '/classroom.html'], ['/classroom.html', '/classroom.html']]);
const path = paths.get(location.pathname) || '/';
if (footer && !footer.querySelector('.bug-report')) {
  const container = document.createElement('section');
  footer.append(container);
  const report = mountBugReport(container, { loginUrl: '/auth/login?next=' + encodeURIComponent(path), path: () => path });
  // Session expiry clears private app contents while this owner-bound draft stays in memory.
  window.StemReportDraft = { hasDraft: report.hasDraft, sessionChanged: report.sessionChanged };
}
