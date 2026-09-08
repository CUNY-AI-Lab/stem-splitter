const el = (id) => document.getElementById(id);
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
let users = [];
let subject = '';
let membersLoaded = false;
let membersLoading = false;
let saving = false;
async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || body.error || 'Please try again.');
  return body;
}
function selectMember() {
  const user = users.find((user) => user.subject === el('access-member').value);
  el('access-editor').hidden = !user;
  el('access-editor').disabled = !user || saving;
  if (!user) return;
  el('access-role').value = user.role;
  el('access-enabled').checked = !user.disabled;
  const date = user.role_expires_at ? new Date(user.role_expires_at) : null;
  el('access-expiry').value = date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  showExpiry();
}
function showExpiry() {
  const instructor = el('access-role').value === 'instructor';
  el('access-expiry-field').hidden = !instructor;
  el('access-expiry').disabled = !instructor;
  el('access-expiry').required = instructor;
}
async function loadMembers() {
  if (membersLoading) return;
  membersLoading = true;
  el('access-retry').hidden = true;
  const previous = el('access-member').value;
  try {
    users = (await request('/api/admin/users')).users.filter((user) => user.subject !== subject);
    const placeholder = new Option('Choose an account', '');
    placeholder.disabled = true;
    placeholder.selected = true;
    el('access-member').replaceChildren(placeholder, ...users.map((user) => new Option(user.subject, user.subject)));
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
  } finally { membersLoading = false; }
}
el('access-member').addEventListener('change', selectMember);
el('access-role').addEventListener('change', showExpiry);
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
        expiresAt: el('access-role').value === 'instructor' && el('access-expiry').value ? new Date(el('access-expiry').value).toISOString() : null, revision: user.revision }),
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
    const { account } = await request('/api/account');
    subject = account.subject;
    el('account-status').textContent = '';
    el('account-role').textContent = `${{ admin: 'Administrator', instructor: 'Instructor', student: 'Student' }[account.role] || 'Student'} access`;
    el('account-id').textContent = subject;
    el('account-details').hidden = false;
    el('account-reference').hidden = false;
    el('account-guidance').hidden = !['admin', 'instructor'].includes(account.role);
    el('account-admin').hidden = account.role !== 'admin';
  } catch (error) {
    el('account-status').textContent = error.message;
    el('account-login').hidden = false;
    el('account-back').hidden = false;
  }
})();
