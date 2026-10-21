/** Shared CAIL report footer: one anonymous field, memory-only drafts. */
export function mountBugReport(container, { path = () => location.pathname, endpoint = '/api/bug-reports' } = {}) {
  // Constant markup only. Report and service data are rendered as text/value.
  container.innerHTML = `<div class="bug-report">
    <button class="bug-report__trigger" type="button" aria-label="Report a problem" aria-haspopup="dialog" aria-expanded="false">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M8 18H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-6l-5 3v-3Z"/><path d="M8 9h8M8 13h5"/></svg>
      <span>Report a problem</span><span class="bug-report__badge" aria-hidden="true" hidden>Draft</span>
    </button>
    <section class="bug-report__panel" popover="manual" role="dialog" aria-modal="false" aria-label="Report a problem" tabindex="-1" hidden>
      <header class="bug-report__heading">
        <div><p class="bug-report__eyebrow">CUNY AI Lab · Support</p><h2>Report a problem</h2></div>
        <button class="bug-report__close" type="button" aria-label="Close bug report"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
      </header>
      <form class="bug-report__form" aria-label="Report a problem">
        <p class="bug-report__context" role="group" aria-label="Report page context"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/></svg><span>This page</span><strong></strong></p>
        <div class="bug-report__field">
          <div class="bug-report__label"><label>What went wrong?<textarea name="description" required minlength="10" maxlength="4000" rows="4" placeholder="What did you try, and what went wrong?" aria-describedby="bug-report-privacy"></textarea></label><span class="bug-report__count" aria-hidden="true">0 / 4,000</span></div>
        </div>
        <p id="bug-report-privacy" class="bug-report__help">No sign-in needed. Please leave out private information.</p>
        <p class="bug-report__status" role="status" aria-live="polite" aria-atomic="true"></p>
        <div class="bug-report__actions"><span class="bug-report__draft-note">Draft kept in this tab until reload.</span><button type="submit" disabled>Send report</button></div>
      </form>
    </section>
  </div>`;
  const panel = container.querySelector('.bug-report__panel'), form = container.querySelector('form');
  const trigger = container.querySelector('.bug-report__trigger'), closeButton = container.querySelector('.bug-report__close');
  const badge = trigger.querySelector('.bug-report__badge'), count = form.querySelector('.bug-report__count');
  const context = form.querySelector('.bug-report__context strong');
  // The preview uses fixed labels only; it never renders a URL, token, project name or account identifier.
  const pageLabels = new Map([['/', 'Workspace'], ['/p/:shared-map', 'Shared map'], ['/account.html', 'My account'],
    ['/teacher.html', 'Instructor'], ['/classroom.html', 'Class workspace']]);
  const instanceId = `bug-report-${crypto.randomUUID()}`;
  panel.id = instanceId; trigger.setAttribute('aria-controls', instanceId);
  form.querySelector('.bug-report__help').id = `${instanceId}-privacy`;
  const description = form.elements.namedItem('description'), status = form.querySelector('[role="status"]');
  description.setAttribute('aria-describedby', `${instanceId}-privacy`);
  const submitButton = form.querySelector('[type="submit"]');
  let report = null, snapshot = '', busy = false;
  let locked = false, done = false, terminal = false, disposed = false, cooldown = null, controller = null;
  let isOpen = false, layoutFrame = null;
  const nativePopover = typeof panel.showPopover === 'function';
  const show = (message, tone = 'info') => { status.textContent = message; panel.dataset.tone = tone; schedulePosition(); };
  const hasDraft = () => !done && (description.value.length > 0 || report !== null);
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
    description.readOnly = busy || locked || done || terminal;
    submitButton.disabled = busy || done || terminal || Boolean(cooldown);
    form.toggleAttribute('aria-busy', busy);
    if (busy) form.setAttribute('aria-busy', 'true');
    panel.dataset.state = done ? 'saved' : busy ? 'sending' : 'idle';
    context.textContent = pageLabels.get(locked && report ? report.path : path()) || 'Current page';
    draftChanged();
    schedulePosition();
  };
  const uncertain = () => {
    locked = true; submitButton.textContent = 'Check report status';
    show(`We could not confirm whether your report was sent. Keep this tab open and check again with the same report. Reference: ${report.reportId}.`, 'attention');
  };
  const wait = seconds => {
    clearTimeout(cooldown);
    cooldown = setTimeout(() => { cooldown = null; if (!disposed) render(); }, seconds * 1000);
  };
  const codeOf = result => result?.code ?? result?.details?.code ?? result?.error?.code;
  async function fetchJson(url, options = {}) {
    controller = new AbortController();
    const deadline = setTimeout(() => controller?.abort(), 30000);
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal });
      return { response, result: await response.json() };
    } finally { clearTimeout(deadline); controller = null; }
  }
  async function submit(event) {
    event.preventDefault();
    if (busy || done || terminal || cooldown) return;
    if (!locked && !form.reportValidity()) return;
    if (!locked) {
      const data = { description: description.value.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').trim(), path: path() };
      const next = JSON.stringify(data);
      if (snapshot !== next) { snapshot = next; report = { reportId: crypto.randomUUID(), ...data }; }
    }
    busy = true; show(locked ? 'Checking your report…' : 'Sending your report…'); render();
    try {
      const { response, result } = await fetchJson(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
      if (disposed) return;
      const code = codeOf(result);
      if (response.ok && result?.ok === true && result.status === 'accepted' && result.reportId === report.reportId) {
        done = true; locked = true; submitButton.textContent = 'Report sent';
        show(`Your report was accepted for email delivery. Thank you. Reference: ${report.reportId}.`, 'success');
      } else if (code === 'idempotency_conflict') {
        terminal = true; show('This report reference already belongs to different report text. Your description is still here. Keep a copy before starting another report in a new tab.', 'attention');
      } else if (code === 'invalid' && !locked) {
        submitButton.textContent = 'Try again'; show('Check the description (10–4000 characters), then try again.', 'attention');
      } else if (response.status === 429 || code === 'rate_limited') {
        const delay = result?.retryAfterSeconds ?? result?.details?.retryAfterSeconds ?? Number(response.headers.get('retry-after'));
        const seconds = Number.isSafeInteger(delay) && delay > 0 && delay <= 86400 ? delay : 60;
        submitButton.textContent = locked ? 'Check report status' : 'Try again';
        show(`Please wait ${Math.ceil(seconds / 60)} minute(s) before trying again. Your description is still here.`, 'attention'); wait(seconds);
      } else if ((code === 'unavailable' && result?.retryable === false) || code === 'forbidden' || response.status === 403) {
        terminal = true; show('This page could not submit the report. Your description is still here. Keep a copy before reopening the app.', 'attention');
      } else {
        uncertain();
        const seconds = result?.retryAfterSeconds;
        if (Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 86400) wait(seconds);
      }
    } catch { if (!disposed) uncertain(); }
    finally {
      busy = false;
      if (!disposed) {
        render();
        requestAnimationFrame(() => { if (!disposed && isOpen) status.scrollIntoView({ block: 'nearest' }); });
      }
    }
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
  }
  const closeClick = () => closePanel();
  const outside = event => { if (isOpen && !panel.contains(event.target) && !trigger.contains(event.target)) closePanel(false); };
  const escape = event => {
    if (isOpen && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePanel(); }
  };
  const beforeUnload = event => { if (hasDraft()) { event.preventDefault(); event.returnValue = ''; } };
  const panelResize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedulePosition) : null;
  panelResize?.observe(panel);
  form.addEventListener('submit', submit);
  description.addEventListener('input', draftChanged); trigger.addEventListener('click', togglePanel); closeButton.addEventListener('click', closeClick);
  document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape, true);
  window.addEventListener('resize', schedulePosition); window.addEventListener('scroll', schedulePosition, true);
  window.visualViewport?.addEventListener('resize', schedulePosition); window.visualViewport?.addEventListener('scroll', schedulePosition);
  window.addEventListener('beforeunload', beforeUnload); render();
  const dispose = () => {
    disposed = true; closePanel(false); panelResize?.disconnect(); controller?.abort(); clearTimeout(cooldown); cancelAnimationFrame(layoutFrame);
    form.removeEventListener('submit', submit);
    description.removeEventListener('input', draftChanged); trigger.removeEventListener('click', togglePanel); closeButton.removeEventListener('click', closeClick);
    document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true);
    window.removeEventListener('resize', schedulePosition); window.removeEventListener('scroll', schedulePosition, true);
    window.visualViewport?.removeEventListener('resize', schedulePosition); window.visualViewport?.removeEventListener('scroll', schedulePosition);
    window.removeEventListener('beforeunload', beforeUnload); delete container.dataset.reportDraft; container.replaceChildren();
  };
  dispose.hasDraft = hasDraft;
  // Reports contain no account identity; account changes do not change a draft.
  dispose.sessionChanged = () => {};
  return dispose;
}
