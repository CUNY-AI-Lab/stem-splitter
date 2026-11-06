const el = (id) => document.getElementById(id);
window.addEventListener('pageshow', event => { if (event.persisted && !window.StemSessionGuard) location.reload(); });
let users = [];
let subject = '';
let membersLoaded = false;
let membersLoading = false;
let membersNextCursor = null;
let saving = false;
let accountRole = '';
let checkingAccount = false;
let accountGeneration = 0, sessionEnded = false;
let studentSelection = '', studentCursor = null, studentRequest = 0;
let studentRows = [], studentsLoading = null, studentsLoaded = false, studentsNextCursor = null;
const currentAccount = generation => !sessionEnded && generation === accountGeneration;
const canManageAccounts = () => Boolean(subject) && !sessionEnded && accountRole === 'admin';
const canReviewStudents = () => Boolean(subject) && !sessionEnded && ['admin', 'instructor'].includes(accountRole);
function applyAccountCapabilities(account) {
  if (accountRole && accountRole !== account.role) {
    accountGeneration++; studentRequest++;
    users=[];membersLoaded=false;membersLoading=false;membersNextCursor=null;saving=false;
    studentRows=[];studentsLoaded=false;studentsLoading=null;studentsNextCursor=null;studentSelection='';studentCursor=null;
    el('access-form').reset();el('access-form').hidden=true;el('access-member').replaceChildren();el('access-editor').disabled=true;
    el('student-list').replaceChildren();el('student-jobs').replaceChildren();el('student-detail').hidden=true;
    el('student-status').textContent='';el('access-status').textContent='';
  }
  accountRole=account.role;
  el('account-role').textContent=`${{admin:'Administrator',instructor:'Instructor',student:'Student',member:'CUNY AI Lab member'}[accountRole]||'CUNY AI Lab member'} access`;
  el('account-admin').hidden=!canManageAccounts();
  el('student-review').hidden=!canReviewStudents();
}
function clearAccountState() {
  sessionEnded = true;
  accountGeneration++;
  studentRequest++;
  users = []; subject = ''; accountRole = '';
  membersLoaded = false; membersLoading = false; membersNextCursor = null; saving = false;
  studentSelection = ''; studentCursor = null;
  studentRows = []; studentsLoading = null; studentsLoaded = false; studentsNextCursor = null;
}
window.addEventListener('focus', async () => {
  if (!subject || checkingAccount) return;
  const generation = accountGeneration;
  checkingAccount = true;
  try {
    const response = await fetch('/api/account', { credentials: 'same-origin', cache: 'no-store' });
    if (!currentAccount(generation)) return;
    if (response.status === 401 || response.status === 403) {
      window.StemSessionGuard ? window.StemSessionGuard.clear() : location.reload();
    } else if (response.ok) {
      const { account } = await response.json();
      if (!currentAccount(generation)) return;
      if (account?.subject !== subject) {
        window.StemSessionGuard ? window.StemSessionGuard.clear() : location.reload();
      } else applyAccountCapabilities(account);
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
  if (!canManageAccounts()) return;
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
  if (!canManageAccounts()) return;
  const instructor = el('access-role').value === 'instructor';
  el('access-permanent-field').hidden = !instructor;
  el('access-permanent').disabled = !instructor;
  const needsDate = instructor && !el('access-permanent').checked;
  el('access-expiry-field').hidden = !needsDate;
  el('access-expiry').disabled = !needsDate;
  el('access-expiry').required = needsDate;
}
async function loadMembers(more = false) {
  if (!canManageAccounts() || membersLoading) return false;
  const generation = accountGeneration;
  membersLoading = true;
  el('access-more').disabled = true;
  el('access-retry').hidden = true;
  const previous = el('access-member').value;
  try {
    const result = await request('/api/admin/users' + (more && membersNextCursor ? `?cursor=${encodeURIComponent(membersNextCursor)}` : ''));
    if (!currentAccount(generation)) return false;
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
    if (!currentAccount(generation)) return false;
    // An administration outage must not hide a valid sign-in or enable stale edits.
    el('access-form').hidden = true;
    el('access-empty').hidden = true;
    el('access-status').textContent = error.message;
    el('access-retry').hidden = false;
    membersLoaded = false;
    return false;
  } finally {
    if (currentAccount(generation)) { membersLoading = false; el('access-more').disabled = false; }
  }
}
el('access-more').addEventListener('click', () => void loadMembers(true));
el('access-member').addEventListener('change', selectMember);
el('access-role').addEventListener('change', () => {
  if (!canManageAccounts()) return;
  // Selecting a new role never silently selects a permanent grant.
  el('access-permanent').checked = false;
  showExpiry();
});
el('access-permanent').addEventListener('change', showExpiry);
el('account-admin').addEventListener('toggle', async () => {
  if (canManageAccounts() && el('account-admin').open && !membersLoaded && !membersLoading) {
    const generation = accountGeneration;
    el('access-status').textContent = 'Loading accounts…';
    if (await loadMembers() && currentAccount(generation)) el('access-status').textContent = '';
  }
});
el('access-retry').addEventListener('click', async () => {
  const generation = accountGeneration;
  if (await loadMembers() && currentAccount(generation)) el('access-status').textContent = '';
});
el('access-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!canManageAccounts()) return;
  const generation = accountGeneration;
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
    if (!currentAccount(generation)) return;
    el('access-status').textContent = 'Access updated.';
    await loadMembers();
  } catch (error) { if (currentAccount(generation)) el('access-status').textContent = error.message; }
  finally {
    if (currentAccount(generation)) {
      saving = false;
      el('access-member').disabled = false;
      selectMember();
    }
  }
});
(async () => {
  const generation = accountGeneration;
  try {
    const { account, splitAllowance, listeningUsage } = await request('/api/account');
    if (!currentAccount(generation)) return;
    if (account.quotaClass === 'guest') { location.replace('/'); return; }
    subject = account.subject;
    applyAccountCapabilities(account);
    window.StemSessionGuard?.start(subject, clearAccountState);
    el('account-status').textContent = '';
    try { await window.StemGuestClaim.run(account); }
    catch (error) { if (currentAccount(generation)) el('account-status').textContent = error.message; }
    if (!currentAccount(generation)) return;
    el('account-details').hidden = false;
    document.querySelector('.dashboard-nav').hidden = false;
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
      if (!currentAccount(generation)) return;
      if (quota && typeof quota.remaining_percent === 'number') el('account-quota').textContent = `CUNY AI Lab model allowance: ${quota.remaining_percent}% remaining (estimated).`;
    } catch { /* Informational only. Gateway authorizes each model request. */ }
  } catch (error) {
    if (!currentAccount(generation)) return;
    el('account-status').textContent = error.message;
    el('account-login').hidden = false;
    el('account-back').hidden = false;
  }
})();

function activityNumber(value) {
  return Number.isInteger(value)&&value>=0 ? (value===0?'None recorded':String(value)) : 'Unavailable';
}
function activityDate(value) {
  if(typeof value!=='string')return 'Not recorded';
  const date=new Date(/(?:Z|[+-]\d\d:?\d\d)$/.test(value)?value:value.replace(' ','T')+'Z');
  return Number.isFinite(date.valueOf())?date.toLocaleString():'Not recorded';
}
function studentSummary(student) {
  return `Runs: ${activityNumber(student.runs)} · Completed: ${activityNumber(student.completed)} · Replies: ${activityNumber(student.chatReplies)} · Opening cues: ${activityNumber(student.guideCues)}. Browser reports in the past 30 days — visits: ${activityNumber(student.recordedVisits)}; plays: ${activityNumber(student.recordedPlays)}.`;
}
function renderActivity(student) {
  const row=document.createElement('li');row.className='activity-card';
  const button=document.createElement('button');button.type='button';button.className='student-select';
  button.textContent=student.displayName+(student.subject===subject?' (you)':'');
  button.addEventListener('click',()=>void loadStudentJobs(student));
  const metrics=document.createElement('dl');metrics.className='activity-metrics';
  for(const [label,key] of [['Runs','runs'],['Completed','completed'],['Replies','chatReplies'],['Opening cues','guideCues'],['Visit reports','recordedVisits'],['Play reports','recordedPlays']]) {
    const group=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');
    dt.textContent=label;dd.textContent=activityNumber(student[key]);dd.dataset.empty=String(!student[key]);group.append(dt,dd);metrics.append(group);
  }
  const dates=document.createElement('details');dates.className='activity-dates';
  const summary=document.createElement('summary');summary.textContent='Recorded dates';const list=document.createElement('dl');
  for(const [label,value] of [['Account added',student.accountCreatedAt??student.firstSeenAt],['Last browser activity',student.lastClientActivityAt],['Last operation record',student.lastOperationAt],['Last authenticated request',student.lastServerAccessAt]]) {
    const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=activityDate(value);list.append(dt,dd);
  }
  dates.append(summary,list);row.append(button,metrics,dates);return row;
}
function loadStudents(more = false) {
  if (!canReviewStudents()) return Promise.resolve(false);
  if (studentsLoading) return studentsLoading;
  const generation = accountGeneration;
  el('student-status').textContent = 'Loading account activity…';
  el('student-list-more').disabled = true;
  el('guest-activity').textContent='Loading guest activity…';
  el('student-retry').hidden = true;
  studentsLoading = (async () => { try {
    const result = await request('/api/teacher/students' + (more && studentsNextCursor ? `?cursor=${encodeURIComponent(studentsNextCursor)}` : ''));
    if (!currentAccount(generation)) return false;
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
    el('student-list').replaceChildren(...studentRows.map(renderActivity));
    el('student-status').textContent = studentRows.length ? '' : studentsNextCursor ? 'No eligible accounts on these pages yet.' : 'Students appear here after they use Stem Splitter.';
    return true;
  } catch (error) {
    if (!currentAccount(generation)) return false;
    el('student-status').textContent = error.message;
    el('guest-activity').textContent='Guest activity unavailable.';
    el('guest-sessions').textContent='';
    el('student-retry').hidden = false;
    return false;
  } finally {
    if (currentAccount(generation)) { studentsLoading = null; el('student-list-more').disabled = false; }
  } })();
  return studentsLoading;
}
async function findStudentActivity(selection, requestId, generation, refresh = false) {
  const active = () => currentAccount(generation) && requestId === studentRequest;
  if ((refresh || !studentsLoaded) && !await loadStudents()) return null;
  if (!active() || !selection) return null;
  const seen = new Set();
  let pages = 0;
  while (!studentRows.some(row => row.subject === selection) && studentsNextCursor) {
    // Automatic lookup must stop even if a provider alternates cursors or keeps
    // returning empty pages. Manual pagination remains available to the user.
    if (seen.has(studentsNextCursor) || pages >= 10) {
      el('student-status').textContent = 'Activity lookup stopped. Load more accounts or try again.';
      el('student-retry').hidden = false;
      return null;
    }
    seen.add(studentsNextCursor); pages++;
    if (!await loadStudents(true) || !active()) return null;
  }
  const student = studentRows.find(row => row.subject === selection);
  if (!student) el('student-status').textContent = 'Activity is unavailable for this account.';
  return student || null;
}
async function openAccountActivity(user) {
  if (!canReviewStudents()) return;
  const generation = accountGeneration;
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
    if (currentAccount(generation) && requestId === studentRequest) el('student-review').scrollIntoView({ block: 'start', behavior: 'instant' });
  });
  const student = await findStudentActivity(user.subject, requestId, generation);
  if (student && currentAccount(generation) && requestId === studentRequest) await loadStudentJobs(student);
}
async function loadStudentJobs(student, more = false) {
  if (!canReviewStudents()) return;
  const generation = accountGeneration;
  const requestId = ++studentRequest;
  studentSelection = student.subject;
  el('student-detail').hidden = false;
  el('student-name').textContent = student.displayName;
  el('student-summary').textContent = studentSummary(student);
  el('student-more').hidden = true;
  el('student-more').disabled = true;
  el('student-retry').hidden = true;
  if (!more) {
    el('student-jobs').replaceChildren();
    requestAnimationFrame(() => {
      if (currentAccount(generation) && requestId === studentRequest) el('student-review').scrollIntoView({ block: 'start', behavior: 'instant' });
    });
  }
  el('student-status').textContent = 'Loading splits…';
  try {
    const result = await request(`/api/teacher/students/${encodeURIComponent(student.subject)}/jobs${more && studentCursor ? '?cursor=' + encodeURIComponent(studentCursor) : ''}`);
    if (!currentAccount(generation) || requestId !== studentRequest) return;
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
    if (currentAccount(generation) && requestId === studentRequest) {
      el('student-status').textContent = error.message;
      el('student-retry').hidden = false;
    }
  }
  finally { if (currentAccount(generation) && requestId === studentRequest) el('student-more').disabled = false; }
}
el('student-list-more').addEventListener('click', () => void loadStudents(true));
el('student-review').addEventListener('toggle', () => {
  if (canReviewStudents() && el('student-review').open && !studentsLoaded && !studentsLoading) void loadStudents();
});
el('student-retry').addEventListener('click', async () => {
  if (!canReviewStudents()) return;
  const generation = accountGeneration, requestId = ++studentRequest;
  const selection = studentSelection;
  const student = await findStudentActivity(selection, requestId, generation, true);
  if (student && currentAccount(generation) && requestId === studentRequest) await loadStudentJobs(student);
});
el('student-more').addEventListener('click', () => {
  const student = studentRows.find(row => row.subject === studentSelection);
  if (student) void loadStudentJobs(student, true);
});
