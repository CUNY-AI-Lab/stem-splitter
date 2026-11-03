/** Requested extractions stay separate from fixed core stems and detector labels. */
export async function mountInstrumentTargets(container, { jobId, request }) {
  const base = `/api/jobs/${encodeURIComponent(jobId)}/instrument-targets`;
  const section = document.createElement('section');
  section.className = 'instrument-targets';
  const heading = document.createElement('h3'); heading.textContent = 'Extract an instrument';
  const help = document.createElement('p');
  help.textContent = 'Request a sound such as saxophone, trumpet or piano. These experimental extractions are additional tracks, not a detected instrument list or replacements for your splits.';
  const form = document.createElement('form');
  const label = document.createElement('label'); label.textContent = 'Instrument or sound';
  const input = document.createElement('input'); input.type = 'text'; input.maxLength = 80; input.required = true;
  input.setAttribute('aria-label', 'Instrument or sound'); input.placeholder = 'For example, saxophone'; label.append(input);
  const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Request extraction';
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Refresh status';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const list = document.createElement('ul');
  form.append(label, submit); section.append(heading, help, form, refresh, status, list); container.append(section);
  let busy = false;
  const draw = targets => {
    list.replaceChildren();
    for (const target of targets) {
      const li = document.createElement('li');
      const name = document.createElement('strong'); name.textContent = `Requested: ${target.target}`;
      const state = document.createElement('p');
      state.textContent = target.needsConfirmation ? 'The request could not be confirmed. Do not submit it again; ask for support.'
        : target.status === 'succeeded' ? 'Experimental extraction ready. It may contain other instruments.'
        : target.status === 'failed' ? 'Extraction did not complete. Your original splits are unchanged.'
        : target.status === 'queued' ? 'Request saved. Extraction has not started.'
        : 'Extraction is being prepared. Refresh to check its status.';
      li.append(name, state);
      if (target.status === 'queued') {
        const start = document.createElement('button'); start.type = 'button';
        start.textContent = `Start saved request: ${target.target}`;
        start.disabled = targets.some(t => t.status === 'processing');
        start.addEventListener('click', () => requestTarget(target.target, false));
        li.append(start);
      }
      if (target.outputAvailable) {
        const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none'; audio.muted = true;
        audio.setAttribute('aria-label', `Preview requested ${target.target} extraction`);
        audio.src = `${base}/${encodeURIComponent(target.id)}/audio`;
        const download = document.createElement('a'); download.href = audio.src; download.download = `${target.target}.wav`;
        download.textContent = 'Download extraction'; li.append(audio, download);
      }
      list.append(li);
    }
    submit.disabled = targets.length >= 2 || targets.some(t => ['processing', 'queued'].includes(t.status));
    status.textContent = targets.length >= 2 ? 'This recording has reached its two additional target requests.' : '';
  };
  const load = async (poll = false) => {
    let data = await request(base);
    if (poll) {
      for (const target of data.targets.filter(t => t.status === 'processing' && !t.needsConfirmation))
        await request(`${base}/${encodeURIComponent(target.id)}`);
      data = await request(base);
    }
    draw(data.targets);
  };
  const requestTarget = async (target, clearDraft = true) => {
    if (busy) return;
    busy = true; submit.disabled = true; refresh.disabled = true;
    try { await request(base, { method: 'POST', body: JSON.stringify({ target }) }); if (clearDraft) input.value = ''; await load(); }
    catch (error) {
      // A lost HTTP reply may conceal an accepted provider request. Preserve the
      // draft and read durable state instead of repeating the POST.
      try { await load(); } catch { /* The draft remains available. */ }
      status.textContent = `${error.message || 'The request could not be confirmed.'} Refresh status before submitting again.`;
    } finally { busy = false; refresh.disabled = false; }
  };
  form.addEventListener('submit', event => { event.preventDefault(); void requestTarget(input.value.trim()); });
  refresh.addEventListener('click', async () => {
    if (busy) return; busy = true; refresh.disabled = true;
    try { await load(true); } catch { status.textContent = 'Status is unavailable. Try refreshing later; no new extraction was started.'; }
    finally { busy = false; refresh.disabled = false; }
  });
  try { await load(); }
  catch { status.textContent = 'Instrument extraction could not be loaded. Try refreshing its status.'; submit.disabled = true; }
  return section;
}
