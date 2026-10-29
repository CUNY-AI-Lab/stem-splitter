/* Private results belong to the active browser session. Revalidation keeps
 * the original page controls in place while private regions stay concealed. */
(() => {
  const privateSelectors = '#job-list, #folders, #shelf, #remix-deck, #upload-status, #account-details, #account-admin, #student-review, #account-reference, #account-footer, #console-panel, #course-discovery, #course-context';
  const originalFetch = window.fetch.bind(window);
  let subject = null, clearing = false, checking = null, suspended = false;
  let cleanup = () => {}, pause = () => {};
  let regions = [], recovery = null;
  let usageActor = null, usageSession = null, usageQueue = [], usageTimer = null, usageSending = false, usageFailures = 0;

  function scheduleUsage(delay = 250) {
    if (!usageTimer && !usageSending && usageQueue.length && usageFailures < 3) {
      usageTimer = setTimeout(() => { usageTimer = null; void flushUsage(); }, delay);
    }
  }

  async function flushUsage() {
    if (usageSending || !usageQueue.length || !usageActor || clearing) return;
    const actor = usageActor, batch = usageQueue.slice(0, 10);
    usageSending = true;
    try {
      const response = await originalFetch('/api/usage-events', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-Stem-Usage-Actor': actor },
        body: JSON.stringify({ events: batch }), signal: AbortSignal.timeout(5000),
      });
      if (actor !== usageActor) return;
      if ([401, 403, 409].includes(response.status)) { usageQueue = []; return; }
      if (!response.ok) throw new Error('Usage unavailable');
      usageQueue.splice(0, batch.length);
      usageFailures = 0;
    } catch {
      if (actor === usageActor) usageFailures++;
    } finally {
      usageSending = false;
      scheduleUsage(usageFailures ? 1000 * usageFailures : 250);
    }
  }

  function observeUsage(value, pageView = false) {
    if (clearing || !/^(?:cail-[0-9a-f]{32}|guest-[0-9a-f]{64})$/.test(value)) return;
    if (usageActor !== value) { usageActor = value; usageSession = null; usageQueue = []; }
    const day = new Date().toISOString().slice(0, 10), slot = `stem-usage-visit:${value}:${day}`;
    let visit;
    try { visit = sessionStorage.getItem(slot); } catch {}
    if (!/^[0-9a-f-]{36}$/.test(visit || '')) {
      visit = usageSession?.day === day ? usageSession.id : crypto.randomUUID();
      try { sessionStorage.setItem(slot, visit); } catch {}
    }
    if (usageSession?.id !== visit) {
      usageSession = { id: visit, day };
      usageQueue.push({ id: `visit-${visit}`, type: 'session_start' });
    }
    if (pageView) usageQueue.push({ id: crypto.randomUUID(), type: 'page_view' });
    usageFailures = 0;
    scheduleUsage();
  }

  // Counts contain no recording titles, conversation text or media identifiers.
  window.StemUsage = {
    record(type) {
      if (!usageActor || clearing || suspended || !['playback_start', 'playback_stop'].includes(type)) return;
      if (usageQueue.length < 30) usageQueue.push({ id: crypto.randomUUID(), type });
      scheduleUsage();
    },
  };
  window.addEventListener('pagehide', () => void flushUsage());

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
    if (window.StemReportDraft?.hasDraft()) {
      window.StemReportDraft.sessionChanged();
      const message = document.getElementById('rack-status') || document.getElementById('account-status');
      if (message) {
        message.textContent = 'Your session changed, so your saved work is hidden. Finish checking your report, then reload this page.';
        message.hidden = false;
      }
      return;
    }
    location.reload();
  }

  function observe(response) {
    const actor = response.headers.get('X-Stem-Account');
    if (subject && actor && actor !== subject) clear();
    if (clearing) throw Object.assign(new Error('Your session changed. Reload the page.'), { status: 401 });
    return response;
  }

  window.fetch = async function (input, options) {
    let sameOrigin = false, reportRequest = false;
    try {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      sameOrigin = url.origin === location.origin;
      reportRequest = sameOrigin && ['/api/bug-reports', '/api/bug-reports/session'].includes(url.pathname);
    } catch {}
    // A retained draft does not keep the old workspace alive or permit stale writes.
    // Report routes independently verify the session and compare its original actor.
    if (clearing && sameOrigin && !reportRequest) return Response.json({ error: {
      code: 'authentication_required', message: 'Your session changed. Reload the page to continue.',
    } }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    const response = await originalFetch(input, options);
    return sameOrigin && !reportRequest ? observe(response) : response;
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
        observeUsage(subject);
      } catch {
        if (!clearing) showRecovery();
      } finally { clearTimeout(timer); checking = null; }
    })();
    return checking;
  }

  window.StemSessionGuard = {
    start(value, onClear, onPause) {
      const firstView = subject !== value;
      subject = value; cleanup = onClear || cleanup; pause = onPause || pause;
      observeUsage(value, firstView);
    },
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
