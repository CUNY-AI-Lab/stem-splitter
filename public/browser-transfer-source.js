(() => {
  'use strict';
  const status = document.getElementById('source-status');
  const DESTINATION = 'https://tools.ailab.gc.cuny.edu';
  let used = false;
  const idleTimer = setTimeout(() => { used = true; status.textContent = 'This window expired. Close it and start again from Account.'; }, 60000);
  const account = async () => {
    const response = await fetch('/api/account', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Account unavailable');
    const data = await response.json();
    const subject = data?.account?.subject;
    if (!/^(?:cail-[0-9a-f]{32}|guest-[0-9a-f]{64})$/.test(subject || '')) throw new Error('Account unavailable');
    return subject;
  };
  const fail = () => { status.textContent = 'Recovery could not be verified. Close this window and try again from the Account page.'; };
  window.addEventListener('message', async event => {
    if (used || event.origin !== DESTINATION || event.source !== window.opener || event.data?.type !== 'stem-browser-transfer-start') return;
    used = true;
    clearTimeout(idleTimer);
    const port = event.ports?.[0];
    const proof = event.data.proof;
    try {
      if (!port || typeof proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(proof)) throw new Error('Invalid request');
      const before = await account();
      const auth = await fetch('/api/browser-transfer/authorize', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proof }) });
      if (!auth.ok) throw new Error('Not authorized');
      const after = await account();
      if (before !== after) throw new Error('Account changed');
      const payload = window.StemBrowserStateTransfer.exportLocal(after);
      if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 512 * 1024) throw new Error('Recovery is too large');
      port.postMessage({ type: 'stem-browser-transfer-data', payload });
      status.textContent = 'Recovery data was sent directly to the matching account page. You can close this window.';
      port.close();
    } catch { try { port?.postMessage({ type: 'stem-browser-transfer-error' }); port?.close(); } catch {} fail(); }
  });
  account().then(() => {
    if (!window.opener) throw new Error('No opener');
    window.opener.postMessage({ type: 'stem-browser-transfer-ready' }, DESTINATION);
    status.textContent = 'Account confirmed. Waiting for the matching recovery page…';
  }).catch(fail);
})();
