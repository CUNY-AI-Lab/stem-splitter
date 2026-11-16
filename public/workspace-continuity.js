(() => {
  const validActor = subject => /^(?:cail-[a-f0-9]{32}|guest-[a-f0-9]{64})$/.test(subject || '');
  const validJob = id => /^[a-zA-Z0-9-]{1,80}$/.test(id || '');
  const states = new Map();
  let actor = null, generation = 0, session = null, seeded = Promise.resolve([]);
  const normalize = value => window.StemListeningProgress?.normalize(value);
  const player = value => ({ position:value.position, rate:value.rate, muted:value.muted,
    solo:value.solo, loop:value.loop, guideOpen:value.guideOpen });
  const values = value => ({ listeningDraft:value?.draft || null,
    listeningPlayer:player(value || normalize({})) });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const journalKey = (subject,id) => `stem-ui-journal:${subject}:${id}`;
  function journal(subject,id) {
    try {
      const saved = JSON.parse(localStorage.getItem(journalKey(subject,id)) || 'null');
      if (!saved || typeof saved !== 'object') return {pending:{},cleared:false};
      const pending = {};
      for (const kind of ['listeningDraft','listeningPlayer']) {
        const record = saved.pending?.[kind];
        if (record?.kind !== kind || !Number.isSafeInteger(record.baseRevision) || record.baseRevision < 0
          || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(record.requestId || '')) continue;
        if (kind === 'listeningDraft' && !(record.value === null || typeof record.value === 'string' && record.value.length <= 2000)) continue;
        const value = kind === 'listeningPlayer' ? (record.value === null ? null : normalize(record.value)) : record.value;
        if (kind === 'listeningPlayer' && record.value !== null && !value) continue;
        pending[kind] = {kind,baseRevision:record.baseRevision,requestId:record.requestId,value:kind === 'listeningPlayer' && value ? player(value) : value};
      }
      return {pending,cleared:saved.cleared === true};
    } catch { return {pending:{},cleared:false}; }
  }
  function saveJournal(state) {
    try { localStorage.setItem(journalKey(state.actor,state.id),JSON.stringify({pending:state.pending,cleared:state.cleared})); } catch {}
  }
  const call = (path, options) => (window.StemFetch || window.fetch.bind(window))(path, options);
  const current = state => states.get(state.id) === state && actor === state.actor && generation === state.generation && !session?.signal.aborted;
  const timer = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function digest(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  // Read only keys belonging to the verified actor, including jobs outside the
  // visible rack. Keep original bytes locally until server acknowledgement.
  function snapshot(subject) {
    if (!validActor(subject)) return [];
    const prefix = `stem-listening:${subject}:`, records = [];
    try {
      const keys = Array.from({length:localStorage.length}, (_, i) => localStorage.key(i));
      for (const key of keys) {
        if (!key?.startsWith(prefix)) continue;
        const jobId = key.slice(prefix.length);
        if (!validJob(jobId)) continue;
        let raw;
        try { raw = JSON.parse(localStorage.getItem(key)); } catch { continue; }
        const saved = normalize(raw);
        if (!saved) continue;
        if (typeof raw.draft === 'string' && raw.draft.length <= 2000 && raw.draft !== '')
          records.push({jobId,kind:'listeningDraft',value:saved.draft});
        if (['position','rate','muted','solo','loop','guideOpen'].some(field => Object.hasOwn(raw, field)))
          records.push({jobId,kind:'listeningPlayer',value:player(saved)});
        for (const kind of ['pendingConversation','pendingChat','pendingGuide'])
          if (saved[kind]) records.push({jobId,kind,value:saved[kind]});
      }
    } catch { /* Unavailable browser storage must not prevent ordinary entry. */ }
    return records;
  }

  async function seed(subject, {endpoint='/api/account/ui-state/seed',signal,flushJournal=false,writeEndpoint} = {}) {
    try { return await seedRecords(subject,snapshot(subject),{endpoint,signal}); }
    finally { if (flushJournal && validActor(subject) && !signal?.aborted) await drainJournal(subject,{signal,writeEndpoint}); }
  }
  async function drainJournal(subject,{signal,writeEndpoint}) {
    const prefix = `stem-ui-journal:${subject}:`, cursorKey = `stem-ui-drain:${subject}`;
    let keys, after = '';
    try { keys = Array.from({length:localStorage.length},(_,i)=>localStorage.key(i))
      .filter(key=>key?.startsWith(prefix) && validJob(key.slice(prefix.length))).sort(); }
    catch { return; }
    try { const saved = localStorage.getItem(cursorKey); if (validJob(saved)) after = saved; } catch {}
    const next = keys.findIndex(key => key.slice(prefix.length) > after), start = next < 0 ? 0 : next;
    let attempted = 0;
    // This cursor schedules work only; it grants no access and contains no draft.
    // Bound parsing as well as writes, but advance past empty, corrupt and failed
    // journals so each later pending job gets a turn on subsequent source visits.
    for (let scanned = 0; scanned < Math.min(keys.length,256) && attempted < 64; scanned++) {
      if (signal?.aborted) return;
      const key = keys[(start + scanned) % keys.length];
      const jobId = key.slice(prefix.length);
      try { localStorage.setItem(cursorKey,jobId); } catch {}
      const stored = journal(subject,jobId);
      if (!Object.keys(stored.pending).length) continue;
      attempted++;
      for (const [kind,write] of Object.entries(stored.pending)) {
        if (signal?.aborted) return;
        let response;
        try {
          response = await call(writeEndpoint || `/api/jobs/${encodeURIComponent(jobId)}/ui-state`, {
            method:writeEndpoint ? 'POST' : 'PUT',credentials:'same-origin',cache:'no-store',signal,
            headers:{'Content-Type':'application/json','X-Stem-Account':subject},body:JSON.stringify(writeEndpoint ? {jobId,...write} : write),
          });
        } catch { if (signal?.aborted) return; else continue; }
        if (signal?.aborted) return;
        if (response.headers.get('X-Stem-Account') !== subject || (!response.ok && response.status !== 409)) continue;
        const latest = journal(subject,jobId);
        if (!same(latest.pending[kind],write)) continue;
        delete latest.pending[kind];
        if (response.ok && kind === 'listeningDraft') latest.cleared = false;
        try { localStorage.setItem(key,JSON.stringify(latest)); } catch {}
      }
    }
  }
  async function seedRecords(subject, records, {endpoint='/api/account/ui-state/seed',signal} = {}) {
    if (!validActor(subject)) return [];
    const acknowledgements = [];
    for (let offset = 0; offset < records.length && !signal?.aborted;) {
      const batch = [];
      let bytes = 0;
      while (offset < records.length && batch.length < 64) {
        const next = records[offset], size = new TextEncoder().encode(JSON.stringify(next)).byteLength;
        if (size > 256 * 1024) { offset++; continue; }
        if (batch.length && bytes + size > 480 * 1024) break;
        batch.push(next); bytes += size; offset++;
      }
      if (!batch.length) continue;
      const hash = await digest(batch);
      const requestId = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
      const response = await call(endpoint, {method:'POST',credentials:'same-origin',cache:'no-store',signal,
        headers:{'Content-Type':'application/json','X-Stem-Account':subject},body:JSON.stringify({requestId,records:batch})});
      if (!response.ok || response.headers.get('X-Stem-Account') !== subject) throw new Error('State seed unavailable');
      const result = await response.json();
      for (const receipt of Array.isArray(result.accepted) ? result.accepted : []) {
        const record = batch.find(item => item.jobId === receipt.jobId && item.kind === receipt.kind);
        if (record && ['applied','already-present','conflict'].includes(receipt.outcome) && Number.isSafeInteger(receipt.revision))
          acknowledgements.push({...record,revision:receipt.revision,outcome:receipt.outcome});
      }
    }
    return acknowledgements;
  }

  async function read(state) {
    const response = await call(`/api/jobs/${encodeURIComponent(state.id)}/ui-state`, {
      credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([session.signal,AbortSignal.timeout(5000)]),
      headers:{'X-Stem-Account':state.actor},
    });
    if (!response.ok || response.headers.get('X-Stem-Account') !== state.actor) throw new Error('State unavailable');
    const body = await response.json();
    if (!current(state) || body.actor !== state.actor || body.jobId !== state.id) throw new Error('State changed');
    return body.records || {};
  }

  async function hydrate(state) {
    try {
      const acknowledgements = await seeded;
      if (!current(state)) return;
      const records = await read(state), update = {}, previous = {...state.values};
      for (const kind of ['listeningDraft','listeningPlayer']) {
        const record = records[kind];
        state.revisions[kind] = record?.revision || 0;
        const ownSeed = acknowledgements.find(item => item.jobId === state.id && item.kind === kind);
        if (state.pending[kind]?.baseRevision === 0 && record && ['applied','already-present'].includes(ownSeed?.outcome) && ownSeed?.revision === record.revision
          && same(ownSeed.value,record.value) && same(ownSeed.value,state.initial[kind])) {
          // A new edit may follow our own seed while the first read is pending.
          // Only that exact, unchanged seed is a safe baseline for the edit.
          state.pending[kind].baseRevision = record.revision;
          saveJournal(state);
        }
        if (record && !state.edits[kind]) {
          state.values[kind] = record.value;
          if (kind === 'listeningDraft') update.draft = record.value || '';
          else Object.assign(update, player(normalize(record.value || {})));
        }
      }
      state.ready = true;
      if (current(state) && Object.keys(update).length) {
        const draftSeed = acknowledgements.find(item => item.jobId === state.id && item.kind === 'listeningDraft');
        const accepted = state.receive(update, {
          draftBaseline: state.initial.listeningDraft || '',
          draftPreserved: Boolean(draftSeed && same(draftSeed.value,state.initial.listeningDraft)),
        }) || {};
        if (accepted.draft === false) state.values.listeningDraft = previous.listeningDraft;
        if (accepted.player === false) state.values.listeningPlayer = previous.listeningPlayer;
      }
      void flush(state);
    } catch { /* Local work remains available; a later edit retries hydration. */ }
    finally { state.loading = null; }
  }

  async function flush(state) {
    if (!current(state) || state.saving) return;
    if (!state.ready) {
      if (!state.loading) state.loading = hydrate(state);
      return;
    }
    state.saving = true;
    try {
      for (const kind of ['listeningDraft','listeningPlayer']) {
        while (state.pending[kind] && current(state)) {
          if (kind === 'listeningPlayer' && state.playerDueAt > Date.now()) {
            clearTimeout(state.timer);
            state.timer = setTimeout(() => {void flush(state);},state.playerDueAt-Date.now());
            break;
          }
          const write = state.pending[kind];
          let response;
          for (let attempt = 0; attempt < 3 && current(state); attempt++) {
            if (attempt) await timer(attempt === 1 ? 250 : 750);
            if (!current(state)) return;
            try {
              response = await call(`/api/jobs/${encodeURIComponent(state.id)}/ui-state`, {
                method:'PUT',credentials:'same-origin',cache:'no-store',keepalive:true,signal:AbortSignal.any([session.signal,AbortSignal.timeout(5000)]),
                headers:{'Content-Type':'application/json','X-Stem-Account':state.actor},
                body:JSON.stringify(write),
              });
              if (response.status < 500) break;
            } catch { response = null; }
          }
          if (!current(state) || !response || response.headers.get('X-Stem-Account') !== state.actor) return;
          if (response.status === 409) {
            // The server retained the losing value. Do not rebase and replay it
            // over somebody's newer edit; only a subsequent user edit can save.
            const records = await read(state);
            state.revisions[kind] = records[kind]?.revision || 0;
            if (state.pending[kind] === write) {delete state.pending[kind];saveJournal(state);break;}
            continue;
          }
          if (!response.ok) return;
          const result = await response.json();
          if (!current(state)) return;
          const revision = result.revision ?? result.record?.revision;
          if (!Number.isSafeInteger(revision) || revision <= write.baseRevision) return;
          state.revisions[kind] = revision;
          if (kind === 'listeningPlayer') {
            state.playerSavedAt = Date.now();
            if (state.pending[kind] !== write && state.playerPositionOnly) state.playerDueAt = Date.now()+5000;
          }
          if (state.pending[kind] === write) {
            delete state.pending[kind];
            if (kind === 'listeningDraft') state.cleared = false;
          }
          else state.pending[kind].baseRevision = revision;
          saveJournal(state);
        }
      }
    } catch { /* Keep local bytes and the same idempotent request for retry. */ }
    finally { state.saving = false; }
  }

  window.StemUiState = {
    snapshot, seed, seedRecords,
    start(subject) {
      this.stop();
      if (!validActor(subject)) return;
      actor = subject; session = new AbortController();
      // Bound initial seeding separately; an unavailable server cannot hold the UI.
      const signal = AbortSignal.any([session.signal, AbortSignal.timeout(5000)]);
      seeded = seed(subject,{signal}).catch(() => []);
    },
    stop() {
      session?.abort(); generation++; actor = null;
      for (const state of states.values()) clearTimeout(state.timer);
      states.clear();
    },
    watch(subject, id, receive) {
      if (subject !== actor || !validJob(id)) return () => {};
      const saved = window.StemListeningProgress.read(subject,id);
      const stored = journal(subject,id);
      const edits = Object.fromEntries(Object.keys(stored.pending).map(kind => [kind,true]));
      if (stored.cleared) edits.listeningDraft = true;
      const state = {actor:subject,id,generation,receive,values:values(saved),initial:values(saved),revisions:{},edits,pending:stored.pending,cleared:stored.cleared,ready:false,loading:null,saving:false,playerDueAt:0,playerSavedAt:0};
      states.set(id,state);
      state.loading = hydrate(state);
      return () => { if (states.get(id) === state) {clearTimeout(state.timer);states.delete(id);} };
    },
    save(subject, id, input) {
      const state = states.get(id), saved = normalize(input);
      if (!state || !current(state) || state.actor !== subject || !saved) return;
      for (const [kind,value] of Object.entries(values(saved))) {
        if (same(value,state.values[kind])) continue;
        if (kind === 'listeningPlayer') {
          state.playerPositionOnly = same({...value,position:0},{...state.values[kind],position:0});
          state.playerDueAt = state.playerPositionOnly ? state.playerSavedAt+5000 : 0;
        }
        state.values[kind] = value; state.edits[kind] = true;
        if (kind === 'listeningDraft') state.cleared = value === null;
        state.pending[kind] = {kind,value,baseRevision:state.revisions[kind] || 0,requestId:crypto.randomUUID()};
      }
      saveJournal(state);
      clearTimeout(state.timer);
      state.timer = setTimeout(() => { void flush(state); }, 600);
    },
    flush() { for (const state of states.values()) {clearTimeout(state.timer);state.playerDueAt=0;void flush(state);} },
  };
})();
