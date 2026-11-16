(() => {
  const data = document.getElementById('stem-transfer-source');
  let target;
  try {
    target = new URL(JSON.parse(data.textContent).continueUrl, location.origin);
    if (target.origin !== location.origin || target.pathname !== '/auth/guest-transfer/continue') return;
  } catch { return; }
  let finished = false;
  const controller = new AbortController();
  const finish = () => {
    if (finished) return;
    finished = true; controller.abort(); location.replace(target.href);
  };
  const timeout = setTimeout(finish, 7500);
  const options = {credentials:'same-origin',cache:'no-store',signal:controller.signal};
  async function copy(contextPath, guest) {
    const response = await fetch(contextPath, options);
    if (!response.ok) return;
    const body = await response.json(), subject = guest ? body.guest?.subject : body.account?.subject;
    if (!subject || (guest ? !/^guest-[a-f0-9]{64}$/.test(subject) : !/^cail-[a-f0-9]{32}$/.test(subject))) return;
    if (response.headers.get('X-Stem-Account') !== subject) return;
    await Promise.allSettled([window.StemPreferences?.seed(subject,{signal:controller.signal,
      endpoint:guest?'/auth/guest-transfer/preferences/seed':'/api/account/preferences/seed',
      ...(guest?{writeEndpoint:'/auth/guest-transfer/preferences/write'}:{})}),window.StemUiState.seed(subject,{signal:controller.signal,flushJournal:true,
      endpoint:guest ? '/auth/guest-transfer/seed' : '/api/account/ui-state/seed',
      ...(guest ? {writeEndpoint:'/auth/guest-transfer/write'} : {})})]);
  }
  Promise.allSettled([copy('/api/account',false),copy('/auth/guest-transfer/context',true)])
    .finally(() => {clearTimeout(timeout);finish();});
})();
