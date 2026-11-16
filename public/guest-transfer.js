(async () => {
  const guestButton = document.getElementById('transfer-guest');
  guestButton.addEventListener('click', async () => {
    guestButton.disabled = true;
    try {
      const response = await window.StemFetch('/auth/guest', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!response.ok) throw new Error('Guest session unavailable');
      location.replace('/stem-splitter/');
    } catch {
      document.getElementById('transfer-status').textContent = 'Guest access could not start. Please try again. Your saved account tracks are unchanged.';
      guestButton.disabled = false;
    }
  });
  const token = location.hash.slice(1);
  // A bookmark or reload has no one-use handoff. Restart at the source rather
  // than posting an empty token or reusing credentials removed from history.
  if (!token) {
    let existingOnly = false;
    try { existingOnly = /^cail-[0-9a-f]{32}$/.test(sessionStorage.getItem('stem-transfer-member') || ''); } catch {}
    location.replace(window.StemPath('/auth/guest-transfer/start') + (existingOnly ? '?existingOnly=1' : ''));
    return;
  }
  // Remove the encrypted handoff from browser history before requesting data.
  history.replaceState(null, '', location.pathname);
  const checked = () => {
    try {
      const member = sessionStorage.getItem('stem-transfer-member');
      if (/^cail-[0-9a-f]{32}$/.test(member || '')) sessionStorage.setItem('stem-transfer-checked:' + member, '1');
      sessionStorage.removeItem('stem-transfer-member');
    } catch {}
  };
  try {
    const response = await window.StemFetch('/auth/guest-transfer/finish', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      if (response.status === 409 && ['member_workspace', 'workspace_conflict'].includes(result.error?.code)) {
        checked();
        document.getElementById('transfer-status').textContent = result.error.message;
        document.getElementById('transfer-accounts').hidden = false;
        if (result.error.code === 'member_workspace') {
          document.getElementById('transfer-status').textContent = 'Sign in with CUNY to check your previous workspace, or continue as a guest here. This will not change any saved account tracks.';
          document.getElementById('transfer-current').hidden = true;
          guestButton.hidden = false;
        }
        return;
      }
      throw new Error('Transfer unavailable');
    }
    checked();
    let next = '/stem-splitter/';
    try {
      const saved = sessionStorage.getItem('stem-transfer-return');
      sessionStorage.removeItem('stem-transfer-return');
      if (saved && /^\/stem-splitter\/(?:\?|$)/.test(saved)) next = saved;
    } catch {}
    location.replace(next);
  } catch {
    document.getElementById('transfer-status').textContent = 'We could not restore your workspace. Your previous tracks are still at the original address.';
    document.getElementById('transfer-retry').hidden = false;
  }
})();
