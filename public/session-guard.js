/* Private views belong to one currently verified account. A recheck conceals
 * the view immediately; only a same-account success can restore its drafts. */
(() => {
  let subject = null, clearing = false, checking = null, suspended = false;
  let cleanup = () => {}, pause = () => {}, previousHidden = false, previousInert = false;
  let panel, message, retry;
  function suspend() {
    if (suspended) return;
    suspended = true;
    const main = document.querySelector('main');
    if (main) {
      previousHidden = main.hidden; previousInert = main.inert;
      main.inert = true; main.hidden = true;
    }
    try { pause(); } catch { /* The concealed view must still offer recovery. */ }
    for (const audio of document.querySelectorAll('audio')) audio.pause();
    if (!panel) {
      panel = document.createElement('section'); panel.id = 'session-check'; panel.className = 'session-check';
      message = document.createElement('p'); message.setAttribute('role', 'status');
      retry = document.createElement('button'); retry.type = 'button'; retry.className = 'account-button'; retry.textContent = 'Retry';
      retry.addEventListener('click', () => void check());
      panel.append(message, retry); document.body.append(panel);
    }
    panel.hidden = false;
  }
  function restore() {
    if (!suspended || clearing) return;
    suspended = false;
    const main = document.querySelector('main');
    if (main) { main.inert = previousInert; main.hidden = previousHidden; }
    if (panel) panel.hidden = true;
    // Playback stays paused. Returning to a page is not a request to play audio.
  }
  function clear() {
    if (clearing) return;
    clearing = true; suspend(); cleanup();
    const main = document.querySelector('main');
    if (main) main.replaceChildren();
    message.textContent = 'Your account changed. Reloading your workspace…'; retry.hidden = true;
    location.reload();
  }
  function observe(response) {
    const actor = response.headers.get('X-Stem-Account');
    if (subject && actor && actor !== subject) {
      clear(); throw Object.assign(new Error('Your account changed. Reload the page.'), { status: 401 });
    }
    return response;
  }
  async function check() {
    if (!subject || clearing) return;
    if (checking) return checking;
    suspend(); message.textContent = 'Checking your account…'; retry.hidden = true;
    checking = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = observe(await fetch('/api/account', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal }));
        if ([401, 403].includes(response.status)) { clear(); return; }
        if (!response.ok) throw new Error('Account unavailable');
        const account = (await response.json()).account;
        if (!account || typeof account.subject !== 'string') throw new Error('Invalid account');
        if (account.subject !== subject) { clear(); return; }
        restore();
      } catch {
        if (!clearing) {
          message.textContent = 'Could not verify your account. Your workspace is hidden until access is checked.';
          retry.hidden = false;
        }
      } finally { clearTimeout(timer); checking = null; }
    })();
    return checking;
  }
  window.StemSessionGuard = {
    start(value, onClear, onPause) { subject = value; cleanup = onClear || cleanup; pause = onPause || pause; },
    observe, check, clear,
  };
  window.addEventListener('focus', () => void check());
  window.addEventListener('pageshow', event => { if (event.persisted) void check(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void check(); });
})();
