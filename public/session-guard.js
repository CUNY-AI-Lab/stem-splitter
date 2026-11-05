/* Private results belong to the active browser session. Revalidation keeps
 * the original page controls in place while private regions stay concealed. */
(() => {
  const privateSelectors = '#job-list, #folders, #shelf, #remix-deck, #upload-status, #account-details, #account-admin, #student-review, #account-reference, #account-footer, #console-panel, #course-discovery, #course-context, .resplit-dialog';
  // Conceal private regions independently of their application-owned visibility.
  // Upload progress and membership results can change while a check is pending.
  const concealment = document.createElement('style');
  concealment.textContent = `html.stem-session-checking :is(${privateSelectors}) { display: none !important; }`;
  document.head.appendChild(concealment);
  const originalFetch = window.fetch.bind(window);
  let subject = null, clearing = false, checking = null, suspended = false;
  let cleanup = () => {}, pause = () => {};
  let regions = [], recovery = null;
  const navigation = document.querySelector('.workspace-nav');
  const signIn = document.getElementById('header-signin')?.closest('.account-nav');
  const instructorLink = navigation?.querySelector('[data-instructor-nav]');
  let navigationRequest = null, navigationGeneration = 0;
  let usageActor = null, usageSession = null, usageQueue = [], usageTimer = null, usageSending = false, usageFailures = 0;

  function signedIn() { return !clearing && /^cail-[0-9a-f]{32}$/.test(subject || ''); }

  function renderNavigation() {
    if (navigation) navigation.hidden = !signedIn() || suspended;
    if (signIn) signIn.hidden = signedIn();
  }

  function cancelNavigation() {
    navigationGeneration++;
    navigationRequest?.abort(); navigationRequest = null;
    if (instructorLink) instructorLink.hidden = true;
  }

  async function refreshNavigation() {
    cancelNavigation(); renderNavigation();
    if (!instructorLink || !signedIn() || suspended) return;
    const generation = navigationGeneration, actor = subject;
    const controller = new AbortController(); navigationRequest = controller;
    const timer = setTimeout(() => controller.abort(), 5000);
    const current = () => generation === navigationGeneration && actor === subject && signedIn() && !suspended;
    const read = async path => {
      const response = await originalFetch(path, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      if (!current()) throw new Error('Navigation changed');
      observe(response);
      if (!response.ok) throw new Error('Instructor access unavailable');
      return response.json();
    };
    try {
      // The same authority used by the console, including course instructors
      // whose application role is only "member". Never infer this from a name.
      const { teacher } = await read('/api/teacher/me');
      let destination = teacher ? '/teacher.html' : null;
      let cursor = null;
      const seen = new Set();
      const requested = new URLSearchParams(location.search).get('course');
      let prior = null;
      try { prior = localStorage.getItem(`stem-workspace-choice:v1:${actor}`); } catch {}
      for (let page = 0; !destination && page < 10; page++) {
        const result = await read(`/api/classroom/courses${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
        const available = Array.isArray(result.courses) ? result.courses.filter(course => course.capabilities?.instructorPanel === true) : [];
        const course = available.find(course => course.classId === requested) || available.find(course => course.classId === prior) || available[0];
        if (course) destination = `/teacher.html?course=${encodeURIComponent(course.classId)}`;
        cursor = result.nextCursor;
        if (!cursor || seen.has(cursor)) break;
        seen.add(cursor);
      }
      if (current() && destination) {
        instructorLink.href = destination;
        instructorLink.hidden = false;
      }
    } catch { /* Unverified capabilities never expose an instructor entry. */ }
    finally {
      clearTimeout(timer);
      if (navigationRequest === controller) navigationRequest = null;
    }
  }

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
    cancelNavigation();
    if (!suspended) {
      suspended = true;
      document.documentElement.classList.add('stem-session-checking');
      regions = [...document.querySelectorAll(privateSelectors)].map(element => ({
        element, inert: element.inert,
      }));
      for (const { element } of regions) {
        element.inert = true;
      }
    }
    renderNavigation();
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
    for (const { element, inert } of regions) {
      element.inert = inert;
    }
    document.documentElement.classList.remove('stem-session-checking');
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

  async function check({ conceal = true } = {}) {
    if (!subject || clearing) return;
    if (conceal) suspend();
    if (checking) return checking;
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
        void refreshNavigation();
        observeUsage(subject);
      } catch {
        if (!clearing) { suspend(); showRecovery(); }
      } finally { clearTimeout(timer); checking = null; }
    })();
    return checking;
  }

  window.StemSessionGuard = {
    start(value, onClear, onPause) {
      const firstView = subject !== value;
      subject = value; cleanup = onClear || cleanup; pause = onPause || pause;
      void refreshNavigation();
      observeUsage(value, firstView);
    },
    observe, check, clear,
  };
  document.getElementById('rack-retry')?.addEventListener('click', event => {
    if (!suspended) return;
    event.preventDefault(); event.stopImmediatePropagation(); void check();
  }, true);
  // Browser chrome, native pickers and window focus changes can fire this
  // while the document remains visible. Revalidate without tearing down a
  // known session on every click. A failure still conceals and pauses it;
  // actual tab returns and restored pages use the strict check below.
  window.addEventListener('focus', () => void check({ conceal: document.hidden }));
  window.addEventListener('pageshow', event => { if (event.persisted) void check(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void check(); });
})();
