const el = (id) => document.getElementById(id);
let users = [];
let subject = '';
async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || body.error || 'Please try again.');
  return body;
}
function selectMember() {
  const user = users.find((user) => user.subject === el('access-member').value);
  if (!user) return;
  el('access-role').value = user.role;
  el('access-disabled').checked = Boolean(user.disabled);
  const date = user.role_expires_at ? new Date(user.role_expires_at) : null;
  el('access-expiry').value = date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  el('access-expiry').required = user.role === 'instructor';
}
async function loadMembers() {
  const previous = el('access-member').value;
  users = (await request('/api/admin/users')).users.filter((user) => user.subject !== subject);
  el('access-member').replaceChildren(...users.map((user) => {
    const option = document.createElement('option');
    option.value = user.subject;
    option.textContent = `${user.subject} · ${user.role}${user.disabled ? ' · suspended' : ''}`;
    return option;
  }));
  if (users.some((user) => user.subject === previous)) el('access-member').value = previous;
  selectMember();
  el('access-form').querySelector('button').disabled = !users.length;
}
el('access-member').addEventListener('change', selectMember);
el('access-role').addEventListener('change', () => { el('access-expiry').required = el('access-role').value === 'instructor'; });
el('access-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const user = users.find((user) => user.subject === el('access-member').value);
  if (!user) return;
  const button = el('access-form').querySelector('button');
  button.disabled = true;
  try {
    await request(`/api/admin/users/${encodeURIComponent(user.subject)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: el('access-role').value, disabled: el('access-disabled').checked,
        expiresAt: el('access-expiry').value ? new Date(el('access-expiry').value).toISOString() : null, revision: user.revision }),
    });
    el('access-status').textContent = 'Access updated.';
    await loadMembers();
  } catch (error) { el('access-status').textContent = error.message; }
  finally { button.disabled = false; }
});
(async () => {
  try {
    const { account } = await request('/api/account');
    subject = account.subject;
    el('account-status').textContent = '';
    el('account-role').textContent = `Signed in · ${account.role}`;
    el('account-id').textContent = subject;
    el('account-details').hidden = false;
    if (account.role === 'admin') {
      await loadMembers();
      el('account-admin').hidden = false;
    }
  } catch (error) { el('account-status').textContent = error.message; }
})();
