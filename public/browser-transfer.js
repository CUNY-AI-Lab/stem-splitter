(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const status = $('transfer-status'), begin = $('transfer-begin'), review = $('transfer-review');
  const state = window.StemBrowserStateTransfer;
  const SOURCE_ORIGIN = 'https://stem-splitter.ailab-452.workers.dev';
  const DESTINATION_ORIGIN = 'https://tools.ailab.gc.cuny.edu';
  const isSupportedTarget = () => location.origin === DESTINATION_ORIGIN && window.StemPath?.base === '/stem-splitter';
  const referencedJobIds = data => [...new Set([
    ...(Array.isArray(data?.jobs) ? data.jobs.map(job => job?.id) : []),
    ...(Array.isArray(data?.playback) ? data.playback.map(item => item?.jobId) : []),
    ...(Array.isArray(data?.recovery) ? data.recovery.map(item => item?.jobId) : []),
  ].filter(id => typeof id === 'string'))];
  let subject = null, proof = null, stagedId = null, popup = null, channel = null, payload = null;
  let flowTimer = null, readyListener = null, accountGeneration = 0, identityCheck = 0;
  const actor = () => subject ? { subject, generation: accountGeneration } : null;
  const actorIsCurrent = saved => Boolean(saved && saved.generation === accountGeneration && saved.subject === subject);
  function stopFlow({ closePopup = true, keepProof = false } = {}) {
    clearTimeout(flowTimer); flowTimer = null;
    if (readyListener) window.removeEventListener('message', readyListener);
    readyListener = null;
    try { channel?.port1.close(); channel?.port2?.close(); } catch {}
    channel = null;
    if (closePopup) try { popup?.close(); } catch {}
    popup = null; if (!keepProof) proof = null; begin.disabled = false;
  }
  function clearPrivateReview() {
    payload = null; stagedId = null; review.hidden = true;
    $('transfer-stage-list').replaceChildren();
    $('transfer-recovery-preview').hidden = true; $('transfer-recovery-text').value = ''; $('transfer-recovery-title').textContent = '';
  }
  async function verifyActor(saved) {
    if (!actorIsCurrent(saved)) throw new Error('Your account changed. Sign in to the account that saved this recovery copy.');
    const current = await currentSubject();
    if (!actorIsCurrent(saved) || current !== saved.subject) throw new Error('Your account changed. Sign in to the account that saved this recovery copy.');
    return current;
  }
  async function refreshSubject() {
    const check = ++identityCheck, generation = accountGeneration;
    try {
      const current = await currentSubject();
      if (check !== identityCheck || generation !== accountGeneration) return;
      if (current !== subject) {
        accountGeneration++; stopFlow(); clearPrivateReview(); subject = current;
        $('transfer-start').hidden = false;
        status.textContent = 'Account changed. Recovery copies are now shown for the current account.';
        showStages();
      }
    } catch {
      if (check !== identityCheck || generation !== accountGeneration) return;
      accountGeneration++; stopFlow(); clearPrivateReview(); subject = null; $('transfer-start').hidden = true;
      status.textContent = 'Sign in to the matching Tools account to view recovery copies.';
    }
  }
  const call = async (path, body) => {
    const response = await window.StemFetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('Recovery could not be verified. Reload and try again.');
    return response.json();
  };
  async function currentSubject() {
    if (!isSupportedTarget()) throw new Error('Browser recovery is available from the Stem Splitter account in Tools.');
    const response = await window.StemFetch('/api/account', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Sign in or restore the same guest session first.');
    const account = (await response.json()).account;
    if (!/^(?:cail-[0-9a-f]{32}|guest-[0-9a-f]{64})$/.test(account?.subject || '')) throw new Error('Account unavailable.');
    return account.subject;
  }
  async function callAs(saved, path, body) {
    await verifyActor(saved);
    const result = await call(path, body);
    await verifyActor(saved);
    return result;
  }
  async function freshScopes(current, saved) {
    if (saved) await verifyActor(saved);
    const requests = [
      window.StemFetch('/api/separation-options', { cache: 'no-store', signal: AbortSignal.timeout(10000) }),
      window.StemFetch('/api/song-samples', { cache: 'no-store', signal: AbortSignal.timeout(10000) }),
    ];
    if (current.startsWith('cail-')) requests.push(window.StemFetch('/api/classroom/courses', { cache: 'no-store', signal: AbortSignal.timeout(10000) }));
    const responses = await Promise.all(requests);
    if (saved) await verifyActor(saved);
    if (responses.some(response => !response.ok)) throw new Error('Your current split and class access could not be checked.');
    const models = await responses[0].json(), samples = await responses[1].json();
    const courses = current.startsWith('cail-') ? await responses[2].json() : { courses: [] };
    if (saved) await verifyActor(saved);
    const courseIds = new Set(['personal', ...(courses.courses || []).map(course => course.classId).filter(id => typeof id === 'string')]);
    const splitChoices = new Set((models.models || []).map(model => model.id).filter(id => typeof id === 'string'));
    const sampleIds = new Set((samples.tracks || []).map(track => `${track.archiveId}/${track.archiveFile}`).filter(id => typeof id === 'string'));
    return { courseIds, splitChoices, sampleIds };
  }
  function showStages() {
    const savedActor = actor();
    const list = $('transfer-stage-list'); list.replaceChildren();
    if (!savedActor) return;
    for (const record of state.listStages(savedActor.subject)) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${new Date(record.createdAt).toLocaleString()} · ${record.payload.jobs.length} splits · ${record.payload.recovery.length} saved notes`;
      const select = document.createElement('button'); select.type = 'button'; select.textContent = 'Review';
      select.addEventListener('click', async () => {
        select.disabled = true;
        try {
          await verifyActor(savedActor);
          const fresh = await freshScopes(savedActor.subject, savedActor);
          const current = await callAs(savedActor, '/api/browser-transfer/reauthorize', { jobIds: referencedJobIds(record.payload) });
          const filtered = state.normalizePayload(record.payload, savedActor.subject, current.allowedJobIds || [], fresh.courseIds, fresh.splitChoices, fresh.sampleIds);
          if (!filtered) throw new Error('This saved copy could not be checked.');
          const effectiveId = JSON.stringify(filtered) === JSON.stringify(record.payload) ? record.id : state.stage(savedActor.subject, filtered);
          if (!effectiveId) throw new Error('This browser is low on storage. The saved copy is unchanged.');
          if (!actorIsCurrent(savedActor)) return;
          stagedId = effectiveId; showReview(state.getStage(effectiveId, savedActor.subject), savedActor);
        }
        catch (error) { if (actorIsCurrent(savedActor)) { if (/account changed|sign in/i.test(error.message)) await refreshSubject(); status.textContent = error.message; } }
        finally { select.disabled = false; }
      });
      li.append(label, select); list.append(li);
    }
  }
  function showReview(record, savedActor = actor()) {
    if (!actorIsCurrent(savedActor) || !record || record.subject !== savedActor.subject) return;
    const data = record.payload; payload = data; stagedId = record.id;
    $('transfer-counts').textContent = `${data.jobs.length} splits, ${data.playback.length} listening positions, and ${Object.keys(data.preferences).length} preferences are ready. The original copy stays on its browser.`;
    const conflicts = $('transfer-conflicts'); conflicts.replaceChildren();
    const importedIds = new Set(data.jobs.map(job => job.id));
    let savedJobs = [];
    try { savedJobs = JSON.parse(localStorage.getItem(`jobs:${savedActor.subject}`) || '[]'); } catch {}
    const existingIds = new Set((Array.isArray(savedJobs) ? savedJobs : []).map(job => job?.id).filter(id => typeof id === 'string'));
    const duplicateCount = [...importedIds].filter(id => existingIds.has(id)).length;
    const progressConflicts = data.playback.filter(item => window.StemListeningProgress?.read(savedActor.subject, item.jobId)).length;
    for (const text of [`${duplicateCount} splits already appear here; their current order is kept.`, `${progressConflicts} listening positions already exist; current progress is kept.`]) {
      const li = document.createElement('li'); li.textContent = text; conflicts.append(li);
    }
    $('transfer-pending').textContent = data.recovery.length
      ? `${data.recovery.length} unfinished Listening Guy notes are saved for review. No messages will be sent.`
      : 'No unfinished Listening Guy notes.';
    if (!actorIsCurrent(savedActor)) return;
    review.hidden = false; showStages(); paintRecovery(record, savedActor);
  }
  function paintRecovery(record, savedActor) {
    if (!actorIsCurrent(savedActor) || record.subject !== savedActor.subject) return;
    const list = $('transfer-stage-list');
    for (const item of record.payload.recovery) {
      const li = document.createElement('li');
      const title = document.createElement('span'); title.textContent = `Split ${item.jobId}: `;
      li.append(title);
      for (const field of ['draft', 'pendingConversation', 'pendingChat', 'pendingGuide']) if (field in item) {
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = field === 'draft' ? 'Restore draft' : field === 'pendingGuide' ? 'Review guide request' : `Review ${field.replace('pending', '').toLowerCase()}`;
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await verifyActor(savedActor);
            const access = await callAs(savedActor, '/api/browser-transfer/reauthorize', { jobIds: [item.jobId] });
            if (!access.allowedJobIds?.includes(item.jobId)) throw new Error('This split is no longer available to this account. The saved copy is unchanged.');
          if (field === 'draft') {
            const result = state.restoreRecovery(record.id, savedActor.subject, item.jobId, field);
            status.textContent = result.ok ? 'Draft restored. No request was sent.' : result.reason === 'conflict' ? 'A draft is already saved for this split. The recovery copy is unchanged.' : 'Recovery copy is unavailable.';
            return;
          }
          const detail = field === 'pendingConversation' ? item.pendingConversation.entries.map(entry => `${entry.kind}: ${entry.text}`).join('\n\n')
            : field === 'pendingChat' ? item.pendingChat.messages.map(turn => `${turn.role}: ${turn.content}`).join('\n\n')
              : 'An unfinished guide request was recorded. It will not be replayed. Open this split and explicitly request a new guide if you still want one.';
          $('transfer-recovery-title').textContent = `${field.replace('pending', 'Unfinished ').replace(/^./, value => value.toUpperCase())} · split ${item.jobId}`;
          $('transfer-recovery-text').value = detail;
          $('transfer-recovery-preview').hidden = false;
          status.textContent = field === 'pendingGuide' ? 'This is a backup only. Open the split to ask for a new guide.' : 'This is a backup only. Review or copy it here; it will not be sent.';
          } catch (error) {
            if (actorIsCurrent(savedActor)) {
              if (/account changed/i.test(error.message)) await refreshSubject();
              status.textContent = error.message || 'This recovery copy is unavailable.';
            }
          } finally { button.disabled = false; }
        });
        li.append(button);
        if (field !== 'draft') {
          const open = document.createElement('a');
          open.href = window.StemPath(`/?job=${encodeURIComponent(item.jobId)}`);
          open.target = '_blank'; open.rel = 'noopener'; open.textContent = 'Open split';
          li.append(open);
        }
      }
      list.append(li);
    }
  }
  async function beginTransfer() {
    if (!isSupportedTarget()) { status.textContent = 'Browser recovery is available from the Stem Splitter account in Tools.'; return; }
    const savedActor = actor();
    if (!savedActor) { status.textContent = 'Sign in to the matching Tools account first.'; return; }
    begin.disabled = true;
    popup = window.open('about:blank', 'stem-browser-recovery', 'popup,width=620,height=640');
    if (!popup) { begin.disabled = false; status.textContent = 'Allow the recovery window, then try again.'; return; }
    try {
      await verifyActor(savedActor);
      const issued = await callAs(savedActor, '/api/browser-transfer/proof', {});
      proof = issued.proof;
      if (issued.sourceOrigin !== SOURCE_ORIGIN || issued.destinationOrigin !== DESTINATION_ORIGIN || location.origin !== issued.destinationOrigin) throw new Error('Browser recovery is not available on this site yet.');
      popup.location.replace(new URL('/browser-transfer-source.html', issued.sourceOrigin).href);
      status.textContent = 'Waiting for the original Stem Splitter site…';
      flowTimer = setTimeout(() => { if (actorIsCurrent(savedActor)) { status.textContent = 'The two sites did not connect. You can try again.'; stopFlow(); } }, 30000);
      readyListener = event => {
        if (event.origin !== issued.sourceOrigin || event.source !== popup || event.data?.type !== 'stem-browser-transfer-ready') return;
        clearTimeout(flowTimer); flowTimer = null;
        window.removeEventListener('message', readyListener); readyListener = null;
        channel = new MessageChannel();
        flowTimer = setTimeout(() => { if (actorIsCurrent(savedActor)) { status.textContent = 'The original site did not finish sending. You can try again.'; stopFlow(); } }, 30000);
        channel.port1.onmessage = async message => {
          clearTimeout(flowTimer); flowTimer = null;
          try {
            if (message.data?.type !== 'stem-browser-transfer-data') throw new Error('The source account could not be checked. Try again.');
            await verifyActor(savedActor);
            const scopes = await freshScopes(savedActor.subject, savedActor);
            const candidate = state.normalizePayload(message.data.payload, savedActor.subject, referencedJobIds(message.data.payload), scopes.courseIds, scopes.splitChoices, scopes.sampleIds);
            if (!candidate) throw new Error('The saved data could not be read. Try again.');
            const allowed = await callAs(savedActor, '/api/browser-transfer/stage', { proof, jobIds: referencedJobIds(candidate) });
            const normalized = state.normalizePayload(candidate, savedActor.subject, allowed.allowedJobIds || [], scopes.courseIds, scopes.splitChoices, scopes.sampleIds);
            if (!normalized) throw new Error('No available data could be saved. The original copy is unchanged.');
            if (!actorIsCurrent(savedActor)) throw new Error('Your account changed. The original copy is unchanged.');
            stagedId = state.stage(savedActor.subject, normalized);
            if (!stagedId) throw new Error('This browser is low on storage. Free space and try again; the original copy is unchanged.');
            const record = state.getStage(stagedId, savedActor.subject);
            if (!actorIsCurrent(savedActor)) return;
            status.textContent = 'Your data is ready to review.';
            showReview(record, savedActor);
            stopFlow({ keepProof: true });
          } catch (error) {
            if (actorIsCurrent(savedActor)) {
              status.textContent = error.message || 'The data could not be saved.';
              if (/account changed/i.test(error.message)) await refreshSubject();
              if (actorIsCurrent(savedActor)) stopFlow();
            }
          }
        };
        channel.port1.start();
        try { popup.postMessage({ type: 'stem-browser-transfer-start', proof }, issued.sourceOrigin, [channel.port2]); }
        catch { if (actorIsCurrent(savedActor)) { status.textContent = 'The original site could not be reached. Try again.'; stopFlow(); } }
      };
      window.addEventListener('message', readyListener);
    } catch (error) { if (actorIsCurrent(savedActor)) { status.textContent = error.message || 'Browser recovery could not start.'; stopFlow(); } }
  }
  $('transfer-apply').addEventListener('click', async () => {
    const savedActor = actor(), transferProof = proof;
    if (!savedActor) return;
    $('transfer-apply').disabled = begin.disabled = true;
    try {
      await verifyActor(savedActor);
      if (transferProof) {
        await callAs(savedActor, '/api/browser-transfer/consume', { proof: transferProof });
        if (actorIsCurrent(savedActor) && proof === transferProof) proof = null;
      }
      const selectedStage = stagedId;
      const sourceRecord = state.getStage(selectedStage, savedActor.subject);
      if (!sourceRecord) throw new Error('That recovery copy is no longer available.');
      const fresh = await freshScopes(savedActor.subject, savedActor);
      const current = await callAs(savedActor, '/api/browser-transfer/reauthorize', { jobIds: referencedJobIds(sourceRecord.payload) });
      const filtered = state.normalizePayload(sourceRecord.payload, savedActor.subject, current.allowedJobIds || [], fresh.courseIds, fresh.splitChoices, fresh.sampleIds);
      if (!filtered) throw new Error('Current access could not be confirmed. The staged recovery copy is preserved.');
      const effectiveId = JSON.stringify(filtered) === JSON.stringify(sourceRecord.payload) ? selectedStage : state.stage(savedActor.subject, filtered);
      if (!effectiveId) throw new Error('Browser storage is full. The staged copy is preserved; current state is unchanged.');
      await verifyActor(savedActor);
      if (!actorIsCurrent(savedActor)) return;
      if (!state.activate(effectiveId, savedActor.subject)) throw new Error('Browser storage is full. The staged copy remains available; current state is unchanged.');
      if (!actorIsCurrent(savedActor)) return;
      status.textContent = 'Recovery state is active for this account. Existing local work and all saved recovery copies remain available.';
      $('transfer-open').hidden = false;
      showStages();
    } catch (error) {
      if (actorIsCurrent(savedActor)) {
        if (/account changed|sign in|matching Tools account/i.test(error.message)) await refreshSubject();
        if (actorIsCurrent(savedActor)) status.textContent = error.message || 'Your data could not be applied.';
      }
    }
    finally { if (actorIsCurrent(savedActor)) { $('transfer-apply').disabled = false; begin.disabled = false; } }
  });
  begin.addEventListener('click', beginTransfer);
  window.addEventListener('focus', () => void refreshSubject());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refreshSubject(); });
  const initialGeneration = accountGeneration;
  currentSubject().then(value => {
    if (initialGeneration !== accountGeneration) return;
    if (subject !== value) { subject = value; accountGeneration++; }
    $('transfer-start').hidden = false; status.textContent = 'Your account is ready. Keep the original browser open while you move data.'; showStages();
  }).catch(error => { if (initialGeneration === accountGeneration) status.textContent = error.message; });
})();
