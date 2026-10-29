const el = (id) => document.getElementById(id);
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
let users = [];
let subject = '';
let membersLoaded = false;
let membersLoading = false;
let membersNextCursor = null;
let saving = false;
let accountRole = '';
let checkingAccount = false;
window.addEventListener('focus', async () => {
  if (!subject || checkingAccount) return;
  checkingAccount = true;
  try {
    const response = await fetch('/api/account', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401 || response.status === 403) {
      for (const id of ['account-details', 'account-admin', 'student-review', 'account-footer']) el(id).hidden = true;
      users = [];
      el('access-member').replaceChildren();
      subject = '';
      window.StemSessionGuard ? window.StemSessionGuard.clear() : location.reload();
    } else if (response.ok) {
      const { account } = await response.json();
      if (account?.subject !== subject || account?.role !== accountRole) {
        for (const id of ['account-details', 'account-admin', 'student-review', 'account-footer']) el(id).hidden = true;
        window.StemSessionGuard ? window.StemSessionGuard.clear() : location.reload();
      }
    }
  } catch { /* A network outage is not a sign-out. */ }
  finally { checkingAccount = false; }
});
async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || body.error || 'Please try again.');
  return body;
}
function selectMember(event) {
  const user = users.find((user) => user.subject === el('access-member').value);
  el('access-editor').hidden = !user;
  el('access-editor').disabled = !user || saving;
  if (!user) return;
  el('access-role').value = user.role;
  el('access-enabled').checked = !user.disabled;
  el('access-permanent').checked = user.role === 'instructor' && user.role_expires_at === null;
  const date = user.role_expires_at ? new Date(user.role_expires_at) : null;
  el('access-expiry').value = date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  showExpiry();
  if (event?.type === 'change') void openAccountActivity(user);
}
function showExpiry() {
  const instructor = el('access-role').value === 'instructor';
  el('access-permanent-field').hidden = !instructor;
  el('access-permanent').disabled = !instructor;
  const needsDate = instructor && !el('access-permanent').checked;
  el('access-expiry-field').hidden = !needsDate;
  el('access-expiry').disabled = !needsDate;
  el('access-expiry').required = needsDate;
}
async function loadMembers(more = false) {
  if (membersLoading) return;
  membersLoading = true;
  el('access-more').disabled = true;
  el('access-retry').hidden = true;
  const previous = el('access-member').value;
  try {
    const result = await request('/api/admin/users' + (more && membersNextCursor ? `?cursor=${encodeURIComponent(membersNextCursor)}` : ''));
    if (more && result.nextCursor && result.nextCursor === membersNextCursor) throw new Error('Account page did not advance. Try again.');
    const rows = result.users.filter((user) => user.subject !== subject);
    users = more ? [...new Map([...users, ...rows].map(user => [user.subject, user])).values()] : rows;
    membersNextCursor = result.nextCursor || null;
    el('access-more').hidden = !membersNextCursor;
    el('access-list-status').textContent = membersNextCursor ? 'More accounts are available.' : 'All available accounts loaded.';
    const placeholder = new Option('Choose an account', '');
    placeholder.disabled = true;
    placeholder.selected = true;
    el('access-member').replaceChildren(placeholder, ...users.map((user) => new Option(user.displayName || 'Name unavailable', user.subject)));
    if (users.some((user) => user.subject === previous)) el('access-member').value = previous;
    el('access-form').hidden = !users.length;
    el('access-empty').hidden = users.length > 0;
    selectMember();
    membersLoaded = true;
    return true;
  } catch (error) {
    // An administration outage must not hide a valid sign-in or enable stale edits.
    el('access-form').hidden = true;
    el('access-empty').hidden = true;
    el('access-status').textContent = error.message;
    el('access-retry').hidden = false;
    membersLoaded = false;
    return false;
  } finally { membersLoading = false; el('access-more').disabled = false; }
}
el('access-more').addEventListener('click', () => void loadMembers(true));
el('access-member').addEventListener('change', selectMember);
el('access-role').addEventListener('change', () => {
  // Selecting a new role never silently selects a permanent grant.
  el('access-permanent').checked = false;
  showExpiry();
});
el('access-permanent').addEventListener('change', showExpiry);
el('account-admin').addEventListener('toggle', async () => {
  if (el('account-admin').open && !membersLoaded && !membersLoading) {
    el('access-status').textContent = 'Loading accounts…';
    if (await loadMembers()) el('access-status').textContent = '';
  }
});
el('access-retry').addEventListener('click', async () => {
  if (await loadMembers()) el('access-status').textContent = '';
});
el('access-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const user = users.find((user) => user.subject === el('access-member').value);
  if (!user || saving || membersLoading || !membersLoaded) return;
  saving = true;
  el('access-member').disabled = true;
  el('access-editor').disabled = true;
  try {
    await request(`/api/admin/users/${encodeURIComponent(user.subject)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: el('access-role').value, disabled: !el('access-enabled').checked,
        expiresAt: el('access-role').value === 'instructor' && !el('access-permanent').checked ? new Date(el('access-expiry').value).toISOString() : null, revision: user.revision }),
    });
    el('access-status').textContent = 'Access updated.';
    await loadMembers();
  } catch (error) { el('access-status').textContent = error.message; }
  finally {
    saving = false;
    el('access-member').disabled = false;
    selectMember();
  }
});
(async () => {
  try {
    const { account, splitAllowance, listeningUsage } = await request('/api/account');
    if (account.quotaClass === 'guest') { location.replace('/'); return; }
    subject = account.subject;
    window.StemSessionGuard?.start(subject, () => { users = []; subject = ""; });
    accountRole = account.role;
    el('account-status').textContent = '';
    try { await window.StemGuestClaim.run(account); }
    catch (error) { el('account-status').textContent = error.message; }
    el('account-role').textContent = `${{ admin: 'Administrator', instructor: 'Instructor', student: 'Student', member: 'CUNY AI Lab member' }[account.role] || 'CUNY AI Lab member'} access`;
    el('account-details').hidden = false;
    el('account-footer').hidden = false;
    el('account-guidance').hidden = !['admin', 'instructor'].includes(account.role);
    el('account-admin').hidden = account.role !== 'admin';
    el('student-review').hidden = !['admin', 'instructor'].includes(account.role);
    if (splitAllowance && Number.isInteger(splitAllowance.limit) && Number.isInteger(splitAllowance.remaining) &&
        splitAllowance.limit > 0 && splitAllowance.remaining >= 0 && splitAllowance.remaining <= splitAllowance.limit &&
        Number.isFinite(Date.parse(splitAllowance.resetsAt))) {
      const reset = new Date(splitAllowance.resetsAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
      el('account-splits').textContent = `${splitAllowance.remaining} of ${splitAllowance.limit} runs left today. Resets ${reset}.`;
    }
    if (listeningUsage?.limit === 50 && Number.isInteger(listeningUsage.remainingTurns)) {
      el('account-listening').textContent = `Listening Guy: ${listeningUsage.remainingTurns} of ${listeningUsage.limit} chat turns left today.`;
    }
    try {
      const { quota } = await request('/api/model-quota');
      if (quota && typeof quota.remaining_percent === 'number') el('account-quota').textContent = `CUNY AI Lab model allowance: ${quota.remaining_percent}% remaining (estimated).`;
    } catch { /* Informational only. Gateway authorizes each model request. */ }
  } catch (error) {
    el('account-status').textContent = error.message;
    el('account-login').hidden = false;
    el('account-back').hidden = false;
  }
})();

let studentSelection = '', studentCursor = null, studentRequest = 0;
let studentRows = [], studentsLoading = null, studentsLoaded = false, studentsNextCursor = null;
function studentSummary(student, detail = false) {
  const visits = student.recordedVisits || student.recordedPlays
    ? `${student.recordedVisits} recorded ${student.recordedVisits === 1 ? 'visit' : 'visits'} · ${student.recordedPlays ?? 0} recorded ${(student.recordedPlays ?? 0) === 1 ? 'play' : 'plays'}`
    : 'Visit and playback history begins Oct 29';
  const first = typeof student.firstSeenAt === 'string' ? Date.parse(student.firstSeenAt.replace(' ', 'T') + (student.firstSeenAt.endsWith('Z') ? '' : 'Z')) : NaN;
  return `${student.runs} recorded split ${student.runs === 1 ? 'attempt' : 'attempts'} · ${student.completed} completed · ${student.guideTurns ?? 0} Guide ${(student.guideTurns ?? 0) === 1 ? 'turn' : 'turns'} · ${visits}${Number.isFinite(first) ? ` · First account access ${new Date(first).toLocaleDateString()}` : ''}${detail && student.lastActiveAt ? ` · Last recorded activity ${new Date(student.lastActiveAt).toLocaleString()}` : ''}`;
}
function loadStudents(more = false) {
  if (studentsLoading) return studentsLoading;
  el('student-status').textContent = 'Loading students…';
  el('student-list-more').disabled = true;
  el('guest-activity').textContent='Loading guest activity…';
  el('student-retry').hidden = true;
  studentsLoading = (async () => { try {
    const result = await request('/api/teacher/students' + (more && studentsNextCursor ? `?cursor=${encodeURIComponent(studentsNextCursor)}` : ''));
    if (more && result.nextCursor && result.nextCursor === studentsNextCursor) throw new Error('Account page did not advance. Try again.');
    studentRows = more ? [...new Map([...studentRows, ...result.students].map(user => [user.subject, user])).values()] : result.students;
    studentsNextCursor = result.nextCursor || null;
    el('student-list-more').hidden = !studentsNextCursor;
    el('student-list-status').textContent = studentsNextCursor ? 'More accounts may be available. Load the next page to continue.' : 'All available accounts loaded.';
    const guests=result.guestActivity;
    el('guest-activity').textContent=guests && Number.isInteger(guests.completedSplits) && Number.isInteger(guests.sessionsWithSplits)
      ? `${guests.splitAttempts} split ${guests.splitAttempts === 1 ? 'attempt' : 'attempts'} · ${guests.completedSplits} completed · ${guests.sessionsWithSplits} ${guests.sessionsWithSplits === 1 ? 'session' : 'sessions'} with splits`
      : 'Guest activity unavailable.';
    el('guest-sessions').textContent = guests && Number.isInteger(guests.browserSessions) && Number.isInteger(guests.splitsSavedToAccounts)
      ? `${guests.browserSessions} guest sessions created · ${guests.splitsSavedToAccounts} ${guests.splitsSavedToAccounts === 1 ? 'split' : 'splits'} saved to accounts · ${Math.max(0, guests.completedSplits - guests.splitsSavedToAccounts)} completed ${guests.completedSplits - guests.splitsSavedToAccounts === 1 ? 'split' : 'splits'} awaiting an account link`
      : '';
    studentsLoaded = true;
    el('student-list').replaceChildren(...studentRows.map(student => {
      const row = document.createElement('li'), button = document.createElement('button'), count = document.createElement('span');
      button.type = 'button'; button.className = 'student-select'; button.textContent = student.displayName + (student.subject === subject ? ' (you)' : '');
      button.addEventListener('click', () => void loadStudentJobs(student));
      count.className = 'student-count';
      count.textContent = studentSummary(student);
      row.append(button, count); return row;
    }));
    el('student-status').textContent = studentRows.length ? '' : studentsNextCursor ? 'No eligible accounts on these pages yet.' : 'Students appear here after they use Stem Splitter.';
    return true;
  } catch (error) {
    el('student-status').textContent = error.message;
    el('guest-activity').textContent='Guest activity unavailable.';
    el('guest-sessions').textContent='';
    el('student-retry').hidden = false;
    return false;
  } finally { studentsLoading = null; el('student-list-more').disabled = false; } })();
  return studentsLoading;
}
async function openAccountActivity(user) {
  const requestId = ++studentRequest;
  studentSelection = user.subject;
  studentCursor = null;
  el('student-review').open = true;
  el('student-detail').hidden = false;
  el('student-name').textContent = user.displayName || 'Name unavailable';
  el('student-summary').textContent = '';
  el('student-jobs').replaceChildren();
  el('student-more').hidden = true;
  el('student-status').textContent = 'Loading activity…';
  requestAnimationFrame(() => {
    if (studentSelection === user.subject) el('student-review').scrollIntoView({ block: 'start', behavior: 'instant' });
  });
  if (!studentsLoaded && !await loadStudents()) return;
  if (requestId !== studentRequest) return;
  while (!studentRows.some(row => row.subject === user.subject) && studentsNextCursor) {
    if (!await loadStudents(true) || requestId !== studentRequest) return;
  }
  const student = studentRows.find(row => row.subject === user.subject);
  if (!student) { el('student-status').textContent = 'Activity is unavailable for this account.'; return; }
  await loadStudentJobs(student);
}
async function loadStudentJobs(student, more = false) {
  const requestId = ++studentRequest;
  studentSelection = student.subject;
  el('student-detail').hidden = false;
  el('student-name').textContent = student.displayName;
  el('student-summary').textContent = studentSummary(student, true);
  el('student-more').hidden = true;
  el('student-more').disabled = true;
  el('student-retry').hidden = true;
  if (!more) {
    el('student-jobs').replaceChildren();
    requestAnimationFrame(() => {
      if (requestId === studentRequest) el('student-review').scrollIntoView({ block: 'start', behavior: 'instant' });
    });
  }
  el('student-status').textContent = 'Loading splits…';
  try {
    const result = await request(`/api/teacher/students/${encodeURIComponent(student.subject)}/jobs${more && studentCursor ? '?cursor=' + encodeURIComponent(studentCursor) : ''}`);
    if (requestId !== studentRequest) return;
    for (const job of result.jobs) {
      const row = document.createElement('li'), text = document.createElement('div'), title = document.createElement('span'), detail = document.createElement('small');
      title.textContent = job.filename;
      detail.textContent = `${new Date(job.createdAt.replace(' ', 'T') + 'Z').toLocaleDateString()} · ${job.status === 'done' ? job.stemCount + (job.stemCount === 1 ? ' stem' : ' stems') : job.status}`;
      text.append(title, detail); row.append(text);
      if (job.status === 'done' && job.stemCount) {
        const load = document.createElement('a'); load.className = 'account-button'; load.textContent = 'Load';
        load.href = `/?student=${encodeURIComponent(student.subject)}&job=${encodeURIComponent(job.id)}`;
        row.append(load);
      }
      el('student-jobs').append(row);
    }
    studentCursor = result.nextCursor;
    el('student-more').hidden = !studentCursor;
    el('student-status').textContent = el('student-jobs').children.length ? '' : 'No saved splits in the past 90 days.';
  } catch (error) {
    if (requestId === studentRequest) {
      el('student-status').textContent = error.message;
      el('student-retry').hidden = false;
    }
  }
  finally { if (requestId === studentRequest) el('student-more').disabled = false; }
}
el('student-list-more').addEventListener('click', () => void loadStudents(true));
el('student-review').addEventListener('toggle', () => {
  if (el('student-review').open && !studentsLoaded && !studentsLoading) void loadStudents();
});
el('student-retry').addEventListener('click', async () => {
  const selection = studentSelection;
  if (!await loadStudents() || selection !== studentSelection) return;
  while (!studentRows.some(row => row.subject === selection) && studentsNextCursor) {
    if (!await loadStudents(true) || selection !== studentSelection) return;
  }
  const student = studentRows.find(row => row.subject === selection);
  if (student) await loadStudentJobs(student);
});
el('student-more').addEventListener('click', () => {
  const student = studentRows.find(row => row.subject === studentSelection);
  if (student) void loadStudentJobs(student, true);
});
