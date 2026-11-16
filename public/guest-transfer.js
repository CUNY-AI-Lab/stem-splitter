(async () => {
  const token = location.hash.slice(1);
  const home = '/stem-splitter/';
  const checked = () => {
    try {
      sessionStorage.setItem('stem-transfer-checked', '1');
      sessionStorage.removeItem('stem-transfer-member');
    } catch {}
  };
  const returnPath = () => {
    try {
      const saved = sessionStorage.getItem('stem-transfer-return');
      sessionStorage.removeItem('stem-transfer-return');
      if (saved && /^\/stem-splitter\/(?:\?|$)/.test(saved)) return saved;
    } catch {}
    return home;
  };

  // A bookmark or reload has no one-use handoff. Start a fresh identity check;
  // account-only sources use existingOnly and can never replace this workspace.
  if (!token) {
    let existingOnly = false;
    try { existingOnly = /^cail-[0-9a-f]{32}$/.test(sessionStorage.getItem('stem-transfer-member') || ''); } catch {}
    try {
      const response = await window.StemFetch('/api/account', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (response.ok) {
        const current = (await response.json()).account?.subject;
        existingOnly = /^cail-[0-9a-f]{32}$/.test(current || '');
        if (existingOnly) try { sessionStorage.setItem('stem-transfer-member', current); } catch {}
      }
    } catch { /* Continue using the current guest session if account lookup is unavailable. */ }
    location.replace(window.StemPath('/auth/guest-transfer/start') + (existingOnly ? '?existingOnly=1' : ''));
    return;
  }

  // Keep the encrypted handoff out of browser history before requesting data.
  history.replaceState(null, '', location.pathname);
  try {
    const response = await window.StemFetch('/auth/guest-transfer/finish', {
      method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      if (response.status === 409 && result.error?.code === 'member_workspace') {
        // There is no source guest account to restore. Quietly create an ordinary
        // guest session while leaving the existing member cookie untouched.
        checked();
        const started = await window.StemFetch('/auth/guest', {
          method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(8000),
          headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        if (!started.ok) throw new Error('guest_start_failed');
      } else if (response.status === 409 && result.error?.code === 'workspace_conflict') {
        // Both distinct guest identities remain intact; continue in the current one.
        checked();
        location.replace(returnPath());
        return;
      } else throw new Error('handoff_failed');
    } else checked();
    location.replace(returnPath());
  } catch {
    // Leave retry and connectivity messaging to the ordinary app. Its one-shot
    // marker prevents another transfer loop and lets normal guest startup run.
    checked();
    location.replace(returnPath());
  }
})();
