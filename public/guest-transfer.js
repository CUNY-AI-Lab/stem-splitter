(async () => {
  const token = location.hash.slice(1);
  // Remove the encrypted handoff from browser history before requesting data.
  history.replaceState(null, '', location.pathname);
  try {
    const response = await window.StemFetch('/auth/guest-transfer/finish', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      if (response.status === 409 && ['member_workspace', 'workspace_conflict'].includes(result.error?.code)) {
        document.getElementById('transfer-status').textContent = result.error.message;
        document.getElementById('transfer-accounts').hidden = false;
        return;
      }
      throw new Error('Transfer unavailable');
    }
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
