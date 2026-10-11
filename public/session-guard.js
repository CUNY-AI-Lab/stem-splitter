/* Private results belong to the active browser session. Revalidation keeps
 * the original page controls in place while private regions stay concealed. */
(() => {
  const privateSelectors = '#job-list, #folders, #shelf, #remix-deck, #upload-status, #account-details, #account-admin, #account-reference, #account-footer, #console-panel';
  const originalFetch = window.fetch.bind(window);
  let subject = null, clearing = false, checking = null, suspended = false;
  let cleanup = () => {}, pause = () => {};
  let regions = [], recovery = null;

  function suspend() {
    if (!suspended) {
      suspended = true;
      regions = [...document.querySelectorAll(privateSelectors)].map(element => ({
        element, hidden: element.hidden, inert: element.inert, display: element.style.display,
      }));
      for (const { element } of regions) {
        element.hidden = true; element.inert = true; element.style.display = 'none';
      }
    }
    try { pause(); } catch { /* Concealment remains available if a player has ended. */ }
    for (const audio of document.querySelectorAll('audio')) audio.pause();
  }

  function showRecovery() {
    const message = document.getElementById('rack-status') || document.getElementById('account-status');
    const retry = document.getElementById('rack-retry');
    if (!recovery) recovery = {
      message, retry, text: message?.textContent, hidden: message?.hidden,
      retryHidden: retry?.hidden, retryDisabled: retry?.disabled,
    };
    if (message) { message.textContent = retry ? 'Please retry the connection to load your saved work.' : 'Reload the page to reconnect and load your saved work.'; message.hidden = false; }
    if (retry) { retry.hidden = false; retry.disabled = false; }
  }

  function restore() {
    if (!suspended || clearing) return;
    for (const { element, hidden, inert, display } of regions) {
      element.hidden = hidden; element.inert = inert; element.style.display = display;
    }
    regions = []; suspended = false;
    if (recovery) {
      const { message, retry, text, hidden, retryHidden, retryDisabled } = recovery;
      if (message) { message.textContent = text; message.hidden = hidden; }
      if (retry) { retry.hidden = retryHidden; retry.disabled = retryDisabled; }
      recovery = null;
    }
    // Playback resumes only through the existing play controls.
  }

  function clear() {
    if (clearing) return;
    clearing = true;
    suspend();
    try { cleanup(); } catch { /* Private contents are cleared even if a player cleanup fails. */ }
    for (const element of document.querySelectorAll(privateSelectors)) element.replaceChildren();
    location.reload();
  }

  function observe(response) {
    const actor = response.headers.get('X-Stem-Account');
    if (subject && actor && actor !== subject) clear();
    if (clearing) throw Object.assign(new Error('Your session changed. Reload the page.'), { status: 401 });
    return response;
  }

  window.fetch = async function (input, options) {
    let sameOrigin = false;
    try { sameOrigin = new URL(input instanceof Request ? input.url : String(input), location.href).origin === location.origin; } catch {}
    const response = await originalFetch(input, options);
    return sameOrigin ? observe(response) : response;
  };

  async function check() {
    if (!subject || clearing) return;
    if (checking) return checking;
    suspend();
    checking = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = observe(await originalFetch('/api/account', {
          cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
        }));
        if ([401, 403].includes(response.status)) { clear(); return; }
        if (!response.ok) throw new Error('Session unavailable');
        const account = (await response.json()).account;
        if (!account || typeof account.subject !== 'string') throw new Error('Invalid account');
        if (account.subject !== subject) { clear(); return; }
        restore();
      } catch {
        if (!clearing) showRecovery();
      } finally { clearTimeout(timer); checking = null; }
    })();
    return checking;
  }

  window.StemSessionGuard = {
    start(value, onClear, onPause) { subject = value; cleanup = onClear || cleanup; pause = onPause || pause; },
    observe, check, clear,
  };
  document.getElementById('rack-retry')?.addEventListener('click', event => {
    if (!suspended) return;
    event.preventDefault(); event.stopImmediatePropagation(); void check();
  }, true);
  window.addEventListener('focus', () => void check());
  window.addEventListener('pageshow', event => { if (event.persisted) void check(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void check(); });
})();
