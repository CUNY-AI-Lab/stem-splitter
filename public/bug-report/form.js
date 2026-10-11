/** CAIL bug-report footer v1: framework-independent, same-origin and memory-only.
 * The same module is vendored by Systems Mapping. Keep the two copies in sync.
 */
export function mountBugReport(container) {
  // This template is constant. User-entered values are only read from form controls.
  container.innerHTML = `<details class="bug-report">
    <summary>Having trouble? Report a bug</summary>
    <form class="bug-report__form" aria-label="Report a bug">
      <p>Send a bug report to the CUNY AI Lab at <a href="mailto:ailab@gc.cuny.edu">ailab@gc.cuny.edu</a>.</p>
      <fieldset>
        <label>Name<input name="name" autocomplete="name" required maxlength="120"></label>
        <label>Email<input name="email" type="email" autocomplete="email" required maxlength="254"></label>
        <label>Description of the bug<textarea name="description" required minlength="10" maxlength="4000" rows="5" aria-describedby="bug-report-privacy"></textarea></label>
      </fieldset>
      <p id="bug-report-privacy" class="bug-report__help">Include what you tried and what went wrong. Avoid passwords or sensitive information. Only your entries, the app name, and a report reference are emailed. No app content is attached.</p>
      <p class="bug-report__status" role="status" aria-live="polite" aria-atomic="true"></p>
      <button type="submit">Send bug report</button>
    </form>
  </details>`;
  const form = container.querySelector('form'), fields = form.querySelector('fieldset');
  const status = form.querySelector('[role="status"]'), button = form.querySelector('button');
  let report = null, snapshot = '', busy = false, locked = false, done = false, disposed = false;
  let controller = null, cooldown = null;
  const show = message => { status.textContent = message; };
  const freeze = () => { locked = true; fields.disabled = true; };
  const uncertain = () => {
    freeze(); button.textContent = 'Check report status';
    show(`We could not confirm whether your report was sent. Check its status using this same form. Reference: ${report.reportId}.`);
  };
  const wait = seconds => {
    button.disabled = true;
    cooldown = setTimeout(() => { cooldown = null; if (!disposed && !done) button.disabled = false; }, seconds * 1000);
  };
  async function submit(event) {
    event.preventDefault(); if (busy || done || cooldown) return;
    if (!locked && !form.reportValidity()) return;
    if (!locked) {
      const data = Object.fromEntries(['name', 'email', 'description'].map(key => [key, form.elements.namedItem(key).value.trim()]));
      const next = JSON.stringify(data);
      if (snapshot !== next) { snapshot = next; report = { reportId: crypto.randomUUID(), ...data }; }
    }
    busy = true; fields.disabled = true; button.disabled = true; form.setAttribute('aria-busy', 'true');
    show(locked ? 'Checking your report…' : 'Sending your report…');
    controller = new AbortController(); const deadline = setTimeout(() => controller?.abort(), 30000);
    try {
      const response = await fetch('/api/bug-reports', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report), signal: controller.signal });
      const result = await response.json();
      if (disposed) return;
      if (response.ok && result.ok === true && result.status === 'accepted' && result.reportId === report.reportId) {
        done = true; freeze(); button.textContent = 'Report sent';
        show(`Your report was accepted for delivery to the CUNY AI Lab. Thank you. Reference: ${report.reportId}.`);
      } else if (result.ok === false && result.code === 'delivery_unknown') {
        uncertain();
      } else if (result.ok === false && result.code === 'idempotency_conflict') {
        freeze(); done = true; show('This report reference could not be reused. Please email ailab@gc.cuny.edu and include your description.');
      } else if (result.ok === false && ['unavailable', 'rate_limited'].includes(result.code)) {
        button.textContent = locked ? 'Check report status' : 'Try again';
        const seconds = Number.isSafeInteger(result.retryAfterSeconds) && result.retryAfterSeconds > 0 && result.retryAfterSeconds <= 86400 ? result.retryAfterSeconds : 60;
        show(result.code === 'rate_limited'
          ? `Too many reports have been submitted. Your description is still here. Try again in ${Math.ceil(seconds / 60)} minute(s), or email the Lab.`
          : locked ? 'We could not check your report. It may already have been sent. Keep this form open and check again later.'
          : 'We could not send your report. Your description is still here. Try again later, or email the Lab.');
        if (result.retryable === true) wait(seconds);
        else { done = true; freeze(); }
      } else if (result.ok === false && result.code === 'invalid' && !locked) {
        show('Please check your name, email, and description (10–4000 characters), then try again.');
        button.textContent = 'Try again';
      } else if (result.ok === false && result.code === 'forbidden' && !locked) {
        show('This page could not submit your report. Keep your description and email ailab@gc.cuny.edu.');
        done = true;
      } else uncertain();
    } catch { if (!disposed) uncertain(); }
    finally {
      clearTimeout(deadline); controller = null; busy = false;
      if (!disposed) {
        form.removeAttribute('aria-busy'); fields.disabled = locked || done; button.disabled = done || Boolean(cooldown);
        // Keep the result and next action visible when status text grows inside
        // a short phone viewport. Never reopen a disclosure the user closed.
        requestAnimationFrame(() => { if (!disposed && container.querySelector('details').open) button.scrollIntoView({ block: 'nearest' }); });
      }
    }
  }
  form.addEventListener('submit', submit);
  return () => {
    disposed = true; controller?.abort(); clearTimeout(cooldown); form.removeEventListener('submit', submit);
    container.replaceChildren();
  };
}
