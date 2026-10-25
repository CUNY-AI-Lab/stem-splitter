import { parseGuestContact } from './contact.js';

/** Shared CAIL report footer: verified SSO or .edu contact, memory-only drafts. */
export function mountBugReport(container, { loginUrl = '/auth/start', loginClassName = '', path = () => location.pathname,
  sessionEndpoint = '/api/bug-reports/session', endpoint = '/api/bug-reports', guestEndpoint = '/api/bug-reports/guest' } = {}) {
  // Constant markup only. Names, reports and service replies use text/value.
  container.innerHTML = `<div class="bug-report">
    <button class="bug-report__trigger" type="button" aria-label="Report a bug" aria-haspopup="dialog" aria-expanded="false">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 2 2 2m4 0 2-2M9 7V6a3 3 0 0 1 6 0v1M6 10H2m4 4H2m4 4H2m16-8h4m-4 4h4m-4 4h4"/><rect x="6" y="7" width="12" height="14" rx="6"/><path d="M12 11v10"/></svg>
      <span class="bug-report__trigger-label" aria-hidden="true"><span>Report a bug</span><span class="bug-report__badge" hidden>Draft</span></span>
    </button>
    <section class="bug-report__panel" popover="manual" role="dialog" aria-modal="false" aria-label="Report a bug" tabindex="-1" hidden>
      <header class="bug-report__heading"><h2>Report a bug</h2>
        <button class="bug-report__close" type="button" aria-label="Close bug report"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
      </header>
      <form class="bug-report__form" aria-label="Report a bug" novalidate>
        <div class="bug-report__identity">
          <p class="bug-report__identity-status" role="status" aria-live="polite">Connecting…</p>
          <div class="bug-report__session" hidden>
            <a class="bug-report__login" target="_blank" rel="noopener noreferrer" aria-label="CUNY Login (opens a new tab)">CUNY Login</a>
            <button class="bug-report__guest-toggle" type="button" aria-expanded="false">No account?</button>
          </div>
          <fieldset class="bug-report__contact" hidden disabled><legend class="bug-report__sr-only">Your details</legend>
            <div class="bug-report__names">
              <label>First name<input name="firstName" autocomplete="given-name" maxlength="80" required><span class="bug-report__error" data-error="firstName" hidden></span></label>
              <label>Last name<input name="lastName" autocomplete="family-name" maxlength="80" required><span class="bug-report__error" data-error="lastName" hidden></span></label>
            </div>
            <label>Email<input name="email" type="email" autocomplete="email" inputmode="email" maxlength="254" placeholder="you@college.edu" required><span class="bug-report__error" data-error="email" hidden></span></label>
          </fieldset>
        </div>
        <div class="bug-report__field">
          <div class="bug-report__label"><label>What went wrong?<textarea name="description" required minlength="10" maxlength="4000" rows="4" placeholder="Explain in detail."></textarea></label><span class="bug-report__count" aria-hidden="true">0 / 4,000</span></div>
          <span class="bug-report__error" data-error="description" hidden></span>
        </div>
        <p class="bug-report__status" role="status" aria-live="polite" aria-atomic="true"></p>
        <div class="bug-report__actions"><button type="submit" disabled>Send</button></div>
      </form>
      <div class="bug-report__support"><a href="mailto:ailab@gc.cuny.edu" aria-label="Email CUNY AI Lab at ailab@gc.cuny.edu">ailab@gc.cuny.edu</a></div>
    </section>
  </div>`;
  const panel = container.querySelector('.bug-report__panel'), form = container.querySelector('form');
  const trigger = container.querySelector('.bug-report__trigger'), closeButton = container.querySelector('.bug-report__close');
  const badge = trigger.querySelector('.bug-report__badge'), count = form.querySelector('.bug-report__count');
  const instanceId = `bug-report-${crypto.randomUUID()}`;
  panel.id = instanceId; trigger.setAttribute('aria-controls', instanceId);
  const description = form.elements.namedItem('description'), status = form.querySelector('.bug-report__status');
  const submitButton = form.querySelector('[type="submit"]'), sessionControls = form.querySelector('.bug-report__session');
  const signIn = sessionControls.querySelector('a'), guestToggle = sessionControls.querySelector('button');
  const identity = form.querySelector('.bug-report__identity'), identityStatus = form.querySelector('.bug-report__identity-status');
  const contactFields = form.querySelector('.bug-report__contact');
  contactFields.id = `${instanceId}-contact`; guestToggle.setAttribute('aria-controls', contactFields.id);
  for (const field of ['firstName', 'lastName', 'email', 'description']) {
    const error = form.querySelector(`[data-error="${field}"]`); error.id = `${instanceId}-${field}-error`;
    form.elements.namedItem(field).setAttribute('aria-describedby', error.id);
  }
  signIn.href = loginUrl;
  for (const name of loginClassName.split(/\s+/).filter(Boolean)) signIn.classList.add(name);
  let actor = null, preferredName = '', session = 'loading', guestOpen = false, draftActor = null;
  let report = null, reportMode = null, snapshot = '', busy = false, checking = null, lastCheck = 0;
  let locked = false, done = false, terminal = false, disposed = false, cooldown = null;
  let isOpen = false, layoutFrame = null;
  const controllers = new Set(), nativePopover = typeof panel.showPopover === 'function';
  const show = (message, tone = 'info') => { status.textContent = message; panel.dataset.tone = tone; schedulePosition(); };
  const guestMode = () => locked ? reportMode === 'guest' : guestOpen && session !== 'signed-in' && !draftActor;
  const accountChanged = () => Boolean(draftActor && (session !== 'signed-in' || actor !== draftActor));
  const hasDraft = () => !done && (description.value.length > 0 || report !== null || ['firstName', 'lastName', 'email'].some(key => form.elements.namedItem(key).value.length > 0));
  const draftChanged = () => {
    const pending = hasDraft();
    badge.hidden = !pending && !done; badge.textContent = done ? 'Sent' : 'Draft';
    count.textContent = `${description.value.length.toLocaleString('en-US')} / 4,000`;
    if (container.dataset.reportDraft !== String(pending)) {
      container.dataset.reportDraft = String(pending);
      container.dispatchEvent(new CustomEvent('cail:report-draft', { bubbles: true, detail: { pending } }));
    }
  };
  const render = () => {
    const guest = guestMode(), changed = !guest && accountChanged();
    description.readOnly = busy || locked || done || terminal;
    submitButton.disabled = busy || Boolean(checking) || changed || (!guest && session !== 'signed-in') || done || terminal || Boolean(cooldown);
    identity.hidden = done;
    identityStatus.textContent = session === 'unavailable' ? 'CUNY Login is temporarily unavailable.'
      : changed ? 'Sign back in with your original account to send this draft.'
      : session === 'signed-in' && !guest ? (preferredName ? `Reporting as ${preferredName}` : 'Signed in with CUNY Login')
      : session === 'loading' ? 'Connecting…' : '';
    identityStatus.hidden = !identityStatus.textContent;
    sessionControls.hidden = (session === 'signed-in' && !changed) || (locked && guest) || done;
    guestToggle.disabled = busy || locked || Boolean(draftActor) || terminal;
    guestToggle.setAttribute('aria-expanded', String(guest));
    contactFields.hidden = !guest; contactFields.disabled = !guest || busy || locked || done || terminal;
    form.setAttribute('aria-busy', String(busy || Boolean(checking)));
    panel.dataset.state = done ? 'saved' : busy ? 'sending' : 'idle';
    draftChanged(); schedulePosition();
  };
  const fieldError = (field, message = '') => {
    const input = form.elements.namedItem(field), error = form.querySelector(`[data-error="${field}"]`);
    input.setAttribute('aria-invalid', String(Boolean(message)));
    error.textContent = message; error.hidden = !message;
    schedulePosition();
  };
  const contactValue = () => Object.fromEntries(['firstName', 'lastName', 'email'].map(key => [key, form.elements.namedItem(key).value]));
  function validate() {
    let first = null;
    if (guestMode()) {
      const parsed = parseGuestContact(contactValue());
      for (const field of ['firstName', 'lastName', 'email']) {
        const message = parsed.ok ? '' : parsed.errors[field] || '';
        fieldError(field, message); if (message && !first) first = field;
      }
    }
    const message = description.value.trim().length < 10 || description.value.length > 4000 ? 'Use 10–4,000 characters.' : '';
    fieldError('description', message); if (message && !first) first = 'description';
    if (first) form.elements.namedItem(first).focus();
    return !first;
  }
  const uncertain = () => {
    locked = true; submitButton.textContent = 'Check status';
    show(`Not confirmed. Check again. Ref: ${report.reportId}.`, 'attention');
  };
  const wait = seconds => {
    clearTimeout(cooldown);
    cooldown = setTimeout(() => { cooldown = null; if (!disposed) render(); }, seconds * 1000);
  };
  const codeOf = result => result?.code ?? result?.details?.code ?? result?.error?.code;
  async function fetchJson(url, options = {}, timeout = 30000) {
    const controller = new AbortController(); controllers.add(controller);
    const deadline = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal });
      return { response, result: await response.json() };
    } finally { clearTimeout(deadline); controllers.delete(controller); }
  }
  async function checkSession(force = false) {
    if (checking) return checking;
    if (busy || done || disposed || terminal || (!force && Date.now() - lastCheck < 2000)) return;
    checking = (async () => {
      try {
        const { response, result } = await fetchJson(sessionEndpoint, {}, 8000);
        if (disposed) return;
        if (response.ok && result?.ok === true && /^[0-9a-f]{64}$/.test(result.expectedActor)) {
          actor = result.expectedActor; session = 'signed-in';
          preferredName = typeof result.preferredName === 'string' ? result.preferredName.slice(0, 160) : '';
          if (!locked) guestOpen = false;
        } else {
          actor = null; preferredName = '';
          session = response.status === 401 || response.status === 403 ? 'signed-out' : 'unavailable';
        }
      } catch { if (!disposed) { actor = null; preferredName = ''; session = 'unavailable'; } }
    })();
    render();
    try { await checking; }
    finally { checking = null; lastCheck = Date.now(); if (!disposed) render(); }
  }
  const refreshSession = () => { if (isOpen && document.visibilityState === 'visible') void checkSession(); };
  async function submit(event) {
    event.preventDefault();
    if (busy || checking || done || terminal || cooldown || (!locked && !validate())) return;
    await checkSession(true);
    if (disposed || busy || (!guestMode() && (session !== 'signed-in' || accountChanged()))) return;
    if (!locked) {
      if (!validate()) return;
      const data = { description: description.value.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').trim(), path: path() };
      reportMode = guestMode() ? 'guest' : 'account';
      if (reportMode === 'guest') Object.assign(data, parseGuestContact(contactValue()).contact);
      else { data.expectedActor = actor; draftActor = actor; }
      const next = JSON.stringify(data);
      if (snapshot !== next) { snapshot = next; report = { reportId: crypto.randomUUID(), ...data }; }
    }
    busy = true; show(locked ? 'Checking…' : 'Sending…'); render();
    try {
      const { response, result } = await fetchJson(reportMode === 'guest' ? guestEndpoint : endpoint,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
      if (disposed) return;
      const code = codeOf(result);
      if (response.ok && result?.ok === true && result.status === 'saved' && result.reportId === report.reportId
        && typeof result.createdAt === 'string' && Number.isFinite(Date.parse(result.createdAt))) {
        done = true; locked = true; submitButton.textContent = 'Sent'; show(result.delivery === 'email' ? 'Report recorded. Email accepted for delivery.' : 'Sent. Thank you.', 'success');
      } else if (code === 'account_changed' || response.status === 401 || code === 'not_admitted' || code === 'admission_required') {
        actor = null; preferredName = ''; session = 'signed-out'; show('Sign in again to send this draft.', 'attention');
      } else if (code === 'invalid_contact' && !locked) {
        show('Check your details.', 'attention');
        for (const field of ['firstName', 'lastName', 'email']) fieldError(field, typeof result.fields?.[field] === 'string' ? result.fields[field].slice(0, 160) : '');
        const invalid = form.querySelector('input[aria-invalid="true"]');
        requestAnimationFrame(() => { if (!disposed && isOpen) invalid?.focus(); });
      } else if (code === 'idempotency_conflict') {
        terminal = true; show('Report changed. Copy your text and start again.', 'attention');
      } else if (code === 'invalid' && !locked) {
        show('Check your details and description.', 'attention');
      } else if (response.status === 429 || code === 'rate_limited') {
        const delay = result?.retryAfterSeconds ?? result?.details?.retryAfterSeconds ?? Number(response.headers.get('retry-after'));
        const seconds = Number.isSafeInteger(delay) && delay > 0 && delay <= 86400 ? delay : 60;
        submitButton.textContent = locked ? 'Check status' : 'Try again';
        show(`Try again in ${Math.ceil(seconds / 60)} min.`, 'attention'); wait(seconds);
      } else if (code === 'forbidden' || response.status === 403) {
        terminal = true; show('Couldn’t send. Copy your text before reloading.', 'attention');
      } else if (code === 'redmine_rejected') {
        terminal = true; show('Couldn’t send. Contact the Lab.', 'attention');
      } else {
        uncertain();
        if (Number.isSafeInteger(result?.retryAfterSeconds) && result.retryAfterSeconds > 0 && result.retryAfterSeconds <= 86400) wait(result.retryAfterSeconds);
      }
    } catch { if (!disposed) uncertain(); }
    finally { busy = false; if (!disposed) render(); }
  }
  function positionPanel() {
    if (!isOpen || disposed) return;
    const viewport = window.visualViewport;
    const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
    const leftEdge = (viewport?.offsetLeft ?? 0) + 12, topEdge = (viewport?.offsetTop ?? 0) + 12;
    const rightEdge = leftEdge + width - 24, bottomEdge = topEdge + height - 24;
    const anchor = trigger.getBoundingClientRect();
    const panelWidth = Math.min(408, width - 24);
    // Apps can reserve space above a fixed navigation or playback footer.
    const clearance = parseFloat(getComputedStyle(panel).scrollMarginBottom) || 0;
    const above = anchor.top - topEdge - 10 - clearance, below = bottomEdge - anchor.bottom - 10;
    const opensAbove = above >= Math.min(340, height - 24) || above >= below;
    panel.style.width = `${panelWidth}px`;
    panel.style.maxHeight = `${Math.max(120, Math.min(height - 24, opensAbove ? above : below))}px`;
    const panelHeight = panel.getBoundingClientRect().height;
    panel.style.left = `${Math.max(leftEdge, Math.min(anchor.right - panelWidth, rightEdge - panelWidth))}px`;
    panel.style.top = `${Math.max(topEdge, Math.min(opensAbove ? anchor.top - 10 - clearance - panelHeight : anchor.bottom + 10, bottomEdge - panelHeight))}px`;
    panel.dataset.placement = opensAbove ? 'above' : 'below';
  }
  function schedulePosition() {
    if (!isOpen || disposed || layoutFrame !== null) return;
    layoutFrame = requestAnimationFrame(() => { layoutFrame = null; positionPanel(); });
  }
  function closePanel(returnFocus = true) {
    if (!isOpen) return;
    isOpen = false;
    if (nativePopover) panel.hidePopover();
    panel.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    if (returnFocus && !disposed) trigger.focus({ preventScroll: true });
  }
  function togglePanel() {
    if (isOpen) { closePanel(); return; }
    isOpen = true; panel.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    if (nativePopover) panel.showPopover();
    render(); positionPanel(); closeButton.focus({ preventScroll: true });
    void checkSession(true);
  }
  const closeClick = () => closePanel();
  const toggleGuest = () => {
    if (busy || locked || draftActor || terminal) return;
    guestOpen = !guestOpen; render();
    if (guestOpen) form.elements.namedItem('firstName').focus();
  };
  const inputChanged = event => {
    const field = event.target.name;
    if (!['firstName', 'lastName', 'email', 'description'].includes(field)) return;
    if (field === 'description' && !locked) {
      if (!description.value.trim()) draftActor = null;
      else if (!draftActor && session === 'signed-in') draftActor = actor;
    }
    if (event.target.getAttribute('aria-invalid') === 'true') {
      if (field === 'description') fieldError(field, description.value.trim().length < 10 ? 'Use 10–4,000 characters.' : '');
      else { const parsed = parseGuestContact(contactValue()); fieldError(field, parsed.ok ? '' : parsed.errors[field] || ''); }
    }
    render();
  };
  const fieldBlur = event => {
    if (guestMode() && event.target.name === 'email' && event.target.value.trim()) {
      const parsed = parseGuestContact(contactValue()); fieldError('email', parsed.ok ? '' : parsed.errors.email || '');
    }
  };
  const outside = event => { if (isOpen && !panel.contains(event.target) && !trigger.contains(event.target)) closePanel(false); };
  const escape = event => { if (isOpen && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePanel(); } };
  const beforeUnload = event => { if (hasDraft()) { event.preventDefault(); event.returnValue = ''; } };
  const panelResize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedulePosition) : null;
  panelResize?.observe(panel);
  form.addEventListener('submit', submit); form.addEventListener('input', inputChanged); form.addEventListener('focusout', fieldBlur);
  guestToggle.addEventListener('click', toggleGuest); trigger.addEventListener('click', togglePanel); closeButton.addEventListener('click', closeClick);
  document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape, true);
  window.addEventListener('resize', schedulePosition); window.addEventListener('scroll', schedulePosition, true);
  window.visualViewport?.addEventListener('resize', schedulePosition); window.visualViewport?.addEventListener('scroll', schedulePosition);
  window.addEventListener('beforeunload', beforeUnload);
  window.addEventListener('focus', refreshSession); window.addEventListener('pageshow', refreshSession);
  document.addEventListener('visibilitychange', refreshSession);
  const sessionTimer = setInterval(refreshSession, 30000);
  render();
  const dispose = () => {
    disposed = true; closePanel(false); panelResize?.disconnect();
    for (const controller of controllers) controller.abort();
    clearTimeout(cooldown); clearInterval(sessionTimer); cancelAnimationFrame(layoutFrame);
    form.removeEventListener('submit', submit); form.removeEventListener('input', inputChanged); form.removeEventListener('focusout', fieldBlur);
    guestToggle.removeEventListener('click', toggleGuest); trigger.removeEventListener('click', togglePanel); closeButton.removeEventListener('click', closeClick);
    document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true);
    window.removeEventListener('resize', schedulePosition); window.removeEventListener('scroll', schedulePosition, true);
    window.visualViewport?.removeEventListener('resize', schedulePosition); window.visualViewport?.removeEventListener('scroll', schedulePosition);
    window.removeEventListener('beforeunload', beforeUnload);
    window.removeEventListener('focus', refreshSession); window.removeEventListener('pageshow', refreshSession);
    document.removeEventListener('visibilitychange', refreshSession);
    delete container.dataset.reportDraft; container.replaceChildren();
  };
  dispose.hasDraft = hasDraft;
  dispose.sessionChanged = () => checkSession(true);
  return dispose;
}
