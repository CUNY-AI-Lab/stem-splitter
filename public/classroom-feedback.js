/* A report contains only the fields the visitor enters. Nothing from a
 * recording, account, or Listening Guy conversation is attached. */
(() => {
  const footer = document.querySelector('main footer') || document.querySelector('footer');
  if (!footer || document.getElementById('comment-form')) return;
  const section = document.createElement('section');
  section.className = 'bug-report';
  const open = document.createElement('button');
  open.type = 'button'; open.className = 'page-btn';
  open.textContent = 'Send us a comment';
  open.setAttribute('aria-expanded', 'false');
  open.setAttribute('aria-controls', 'comment-form');
  const form = document.createElement('form');
  form.id = 'comment-form'; form.className = 'teacher-form'; form.hidden = true;
  form.setAttribute('aria-label', 'Send us a comment');
  const help = document.createElement('p');
  help.id = 'comment-help'; help.className = 'account-help';
  help.textContent = 'Tell the CUNY AI Lab what you tried, what happened, and what you expected. Do not include passwords, private student information, or Listening Guy conversations.';
  form.setAttribute('aria-describedby', help.id);
  function field(labelText, name, maximum, type = 'text') {
    const label = document.createElement('label'); label.className = 'teacher-field';
    const title = document.createElement('span'); title.textContent = labelText;
    const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
    input.id = `comment-${name}`; input.name = name; input.required = true; input.maxLength = maximum;
    if (type === 'textarea') { input.rows = 5; input.minLength = 10; input.className = 'teacher-textarea'; }
    else { input.type = type; input.autocomplete = name; }
    label.append(title, input); form.append(label); return input;
  }
  form.append(help);
  const name = field('Your name', 'name', 120);
  const email = field('Your email', 'email', 254, 'email');
  const description = field('What happened?', 'description', 4000, 'textarea');
  const fields = [name, email, description];
  const actions = document.createElement('div'); actions.className = 'teacher-actions';
  const submit = document.createElement('button');
  submit.type = 'submit'; submit.className = 'page-btn'; submit.textContent = 'Send comment';
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'page-btn'; close.textContent = 'Close';
  actions.append(submit, close);
  const status = document.createElement('p');
  status.className = 'teacher-status'; status.id = 'comment-status';
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  form.append(actions, status); section.append(open, form); footer.append(section);

  let report = null, busy = false, terminal = false, retryAfter = 0, retryTimer = 0;
  function visibility(visible) {
    form.hidden = !visible; open.setAttribute('aria-expanded', String(visible));
    if (visible) (terminal || report ? close : name).focus(); else open.focus();
  }
  open.addEventListener('click', () => visibility(form.hidden));
  close.addEventListener('click', () => visibility(false));
  function uncertain() {
    terminal = true;
    status.textContent = `We could not confirm delivery. Your comment may already have been sent, so it will not be sent again. Reference: ${report.reportId}.`;
  }
  function allowRetry(seconds) {
    retryAfter = Date.now() + seconds * 1000;
    submit.textContent = 'Retry same comment';
    const update = () => {
      const remaining = Math.ceil((retryAfter - Date.now()) / 1000);
      submit.disabled = remaining > 0;
      status.textContent = remaining > 0
        ? `Your comment was not accepted. You can retry the same comment in ${remaining} seconds. Reference: ${report.reportId}.`
        : `Your comment was not accepted. You can retry the same comment. Reference: ${report.reportId}.`;
      if (remaining > 0) retryTimer = setTimeout(update, Math.min(remaining * 1000, 1000));
    };
    update();
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || terminal || Date.now() < retryAfter || !form.reportValidity()) return;
    if (!report) {
      const data = { name: name.value.trim(), email: email.value.trim(), description: description.value.trim() };
      if (!data.name || data.description.length < 10) {
        status.textContent = 'Enter your name and describe what happened in at least 10 characters.';
        return;
      }
      report = { reportId: crypto.randomUUID(), ...data };
    }
    busy = true; submit.disabled = true; fields.forEach(input => { input.disabled = true; });
    clearTimeout(retryTimer); status.textContent = 'Sending your comment…';
    const controller = new AbortController();
    // The receiver may have dispatched before a response is lost. Timeouts
    // and network errors must not turn into an automatic or fresh-ID retry.
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch('/api/bug-reports', {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report),
      });
      const result = await response.json();
      if (response.ok && result.ok === true && result.status === 'accepted' && result.reportId === report.reportId) {
        terminal = true;
        status.textContent = `Thank you. Your comment was accepted. Reference: ${report.reportId}.`;
      } else if (result.ok === false && result.code === 'invalid' && response.status === 400) {
        report = null; fields.forEach(input => { input.disabled = false; }); submit.disabled = false;
        status.textContent = 'Please check your name, email, and description, then send the corrected comment.';
      } else if (result.ok === false && result.retryable === true && ['unavailable', 'rate_limited'].includes(result.code)
        && (!result.reportId || result.reportId === report.reportId)) {
        const seconds = Number.isSafeInteger(result.retryAfterSeconds) && result.retryAfterSeconds > 0
          ? Math.min(result.retryAfterSeconds, 86400) : 1;
        allowRetry(seconds);
      } else if (result.ok === false && result.code === 'forbidden' && response.status === 403) {
        terminal = true;
        status.textContent = `This page could not send your comment. Reference: ${report.reportId}.`;
      } else uncertain();
    } catch { uncertain(); }
    finally { clearTimeout(timeout); busy = false; if (terminal) submit.disabled = true; }
  });
})();
