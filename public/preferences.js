/* Private presentation preferences. Server records win over unedited device
 * baselines; only explicit local changes enter the retry journal. */
(() => {
  const kinds = ['classChoice','modelChoice','benchTab','sampleRotation','rackLayout'];
  const actorOK = actor => /^(?:cail-[a-f0-9]{32}|guest-[a-f0-9]{64})$/.test(actor || '');
  const idOK = id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id);
  const uuidOK = id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id);
  const integer = n => Number.isSafeInteger(n) && n >= 0;
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const key = actor => `stem-preferences:v1:${actor}`;
  const read = name => { try { return localStorage.getItem(name); } catch { return null; } };
  const parse = text => { try { return JSON.parse(text); } catch { return null; } };
  function sampleKey(value) {
    if(typeof value!=='string'||value.length>641||/[\u0000-\u001f\u007f]/.test(value))return false;
    const slash=value.indexOf('/');if(slash<1)return false;
    const archiveId=value.slice(0,slash),archiveFile=value.slice(slash+1);
    return archiveId.length<=128&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(archiveId)
      &&archiveFile.length>0&&archiveFile.length<=512&&archiveFile.toLowerCase().endsWith('.mp3');
  }
  function valid(kind,value) {
    if (!kinds.includes(kind)) return false;
    if (value === null) return true;
    if (kind === 'classChoice') return typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
    if (kind === 'modelChoice') return typeof value === 'string' && value.length <= 80 && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value);
    if (kind === 'benchTab') return value === 'splitter' || value === 'remixer';
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const list = (items,limit,predicate) => Array.isArray(items) && items.length <= limit && items.every(predicate) && new Set(items).size === items.length;
    if (kind === 'sampleRotation') return Object.keys(value).length === 5
      && (integer(value.revision) || typeof value.revision === 'string' && value.revision.length > 0 && value.revision.length <= 128)
      && list(value.seen,64,sampleKey) && list(value.order,64,sampleKey)
      && (value.last === null || value.last === '' || sampleKey(value.last)) && integer(value.pass);
    return Object.keys(value).length === 2 && Array.isArray(value.entries) && value.entries.length <= 200
      && value.entries.every(row => row && Object.keys(row).length === 3 && idOK(row.jobId) && typeof row.collapsed === 'boolean' && integer(row.rank) && row.rank < 200)
      && new Set(value.entries.map(row=>row.jobId)).size === value.entries.length
      && new Set(value.entries.map(row=>row.rank)).size === value.entries.length
      && list(value.suppressedJobIds,200,idOK) && !value.suppressedJobIds.some(id=>value.entries.some(row=>row.jobId===id));
  }
  function load(actor) {
    const saved = parse(read(key(actor))), records = {}, pending = {};
    for (const kind of kinds) {
      const row = saved?.records?.[kind], write = saved?.pending?.[kind];
      if (row && integer(row.revision) && valid(kind,row.value)) records[kind] = row;
      if (write && uuidOK(write.requestId) && integer(write.baseRevision) && valid(kind,write.value)) pending[kind] = write;
    }
    return {records,pending};
  }
  function store(actor,state,changedKind=null,expected=null) {
    const latest=load(actor);
    for(const kind of kinds) {
      if(kind!==changedKind && latest.pending[kind])state.pending[kind]=latest.pending[kind];
      if(kind===changedKind && expected && latest.pending[kind] && !same(latest.pending[kind],expected))state.pending[kind]=latest.pending[kind];
    }
    try { localStorage.setItem(key(actor),JSON.stringify(state)); } catch { /* In-memory changes remain usable; no server acknowledgement is inferred. */ }
  }
  function legacy(actor) {
    const values = {classChoice:read(`stem-workspace-choice:v1:${actor}`),modelChoice:read('stem-split-choice-v1'),benchTab:read('benchTab'),sampleRotation:parse(read('stem-song-rotation-v1'))};
    const jobs = parse(read(`jobs:${actor}`));
    if (Array.isArray(jobs) && jobs.length) {
      const seen = new Set(), entries = [];
      for (const job of jobs) if (entries.length < 200 && idOK(job?.id) && !seen.has(job.id)) { seen.add(job.id); entries.push({jobId:job.id,collapsed:job.collapsed===true,rank:entries.length}); }
      if (entries.length) values.rackLayout = {entries,suppressedJobIds:[]};
    }
    return Object.fromEntries(Object.entries(values).filter(([kind,value])=>value!==null && valid(kind,value)));
  }
  function receipt(response,body,kind,write) {
    return body?.kind === kind && integer(body.revision) && body.revision > 0
      && (response.status === 200 && body.outcome === 'applied' && body.revision === write.baseRevision + 1
        || response.status === 409 && body.outcome === 'conflict');
  }
  const request = (actor,path,options={}) => (window.StemFetch || fetch)(path,{credentials:'same-origin',cache:'no-store',...options,
    headers:{'Content-Type':'application/json','X-Stem-Account':actor,...options.headers}});
  async function send(actor,kind,write,{signal,writeEndpoint,member,detectMissing=false}={}) {
    const response = await request(actor,writeEndpoint || '/api/account/preferences',{method:writeEndpoint?'POST':'PUT',signal,body:JSON.stringify({kind,...write}),...(member?{headers:{'X-Stem-Claim-Actor':member}}:{})});
    if (signal?.aborted || response.headers.get('X-Stem-Account') !== (member || actor)
      || member && response.headers.get('X-Stem-Guest-Account') !== actor) return null;
    const body = await response.json();
    if(signal?.aborted || member && body?.actor!==actor)return null;
    if(detectMissing && response.status===409 && body?.kind===kind && body.outcome==='conflict' && body.revision===null)
      return {missingSlot:true};
    return receipt(response,body,kind,write) ? body : null;
  }
  // Source handoff has independently verified member and guest contexts. It
  // never changes the active page actor and never reads another actor's cache.
  async function seed(actor,{signal,endpoint,writeEndpoint,records:provided,drain=true}={}) {
    if (!actorOK(actor) || signal?.aborted) return;
    let state = load(actor);
    await Promise.allSettled(kinds.map(async kind => {
      const write = state.pending[kind]; if (!drain || !write || signal?.aborted) return;
      try {
        const writeSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(2000)]):AbortSignal.timeout(2000);
        const ack = await send(actor,kind,write,{signal:writeSignal,writeEndpoint});
        if (!ack || signal?.aborted) return;
        state = load(actor);
        if (same(state.pending[kind],write)) {
          delete state.pending[kind];
          if (ack.outcome === 'applied') state.records[kind] = {value:write.value,revision:ack.revision};
          store(actor,state,kind,write);
        }
      } catch { /* Keep exact request and value for the next ordinary visit. */ }
    }));
    state = load(actor);
    const candidates = provided || {...legacy(actor),...Object.fromEntries(Object.entries(state.records).map(([kind,row])=>[kind,row.value]))};
    const records = kinds.filter(kind=>Object.hasOwn(candidates,kind) && !state.pending[kind] && valid(kind,candidates[kind])).map(kind=>({kind,value:candidates[kind]}));
    if (!records.length || signal?.aborted) return;
    const accepted=[];
    // Separate bounded slots so an oversized legacy rotation cannot block the
    // other preferences. The original value remains on the source device.
    await Promise.allSettled(records.map(async record => {
      const batch=[record];
      if(new TextEncoder().encode(JSON.stringify(batch)).byteLength>32000)return;
      const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(batch))));
      hash[6]=(hash[6]&15)|64;hash[8]=(hash[8]&63)|128;
      const hex=[...hash.slice(0,16)].map(n=>n.toString(16).padStart(2,'0')).join('');
      const requestId=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
      if(signal?.aborted)return;
      try {
        const response=await request(actor,endpoint || '/api/account/preferences/seed',{method:'POST',signal,body:JSON.stringify({requestId,records:batch})});
        if(response.headers.get('X-Stem-Account')!==actor || !response.ok || signal?.aborted)return;
        const body=await response.json();if(!signal?.aborted && Array.isArray(body.accepted))accepted.push(...body.accepted);
      } catch { /* Other slots can still seed within the shared deadline. */ }
    }));
    return {accepted};
  }

  async function claim(member,guest,jobIds) {
    if(!/^cail-[a-f0-9]{32}$/.test(member||'') || !/^guest-[a-f0-9]{64}$/.test(guest||'')
      || !Array.isArray(jobIds) || jobIds.some(id=>!idOK(id)))return;
    const signal=AbortSignal.timeout(5000);
    await Promise.allSettled(kinds.map(async kind=>{
      const before=load(guest),write=before.pending[kind];if(!write)return;
      try {
        const ack=await send(guest,kind,write,{signal,member,writeEndpoint:'/api/account/claim-guest/preferences/write'});
        if(!ack||signal.aborted)return;
        const state=load(guest);
        if(!same(state.pending[kind],write))return;
        delete state.pending[kind];
        if(ack.outcome==='applied')state.records[kind]={value:write.value,revision:ack.revision};
        store(guest,state,kind,write);
      }catch { /* Keep an unacknowledged guest operation under its original identity. */ }
    }));
    const state=load(guest), values={};
    for(const kind of kinds) if(!state.pending[kind] && state.records[kind])values[kind]=state.records[kind].value;
    if(values.rackLayout) {
      const allowed=new Set(jobIds);
      values.rackLayout={entries:values.rackLayout.entries.filter(row=>allowed.has(row.jobId)).map((row,rank)=>({...row,rank})),
        suppressedJobIds:values.rackLayout.suppressedJobIds.filter(id=>allowed.has(id))};
    }
    // The dedicated route checks both cookies and the exact claim. A guest CAS
    // can update only an unchanged claim-derived member slot. Ordinary member
    // choices win; remaining acknowledged guest values seed missing slots only.
    return seed(member,{records:values,drain:false,signal});
  }

  let current = null;
  function stop() { if (current) { current.controller.abort(); clearTimeout(current.timer); current = null; } }
  // Null is a real clear, not absence.
  function valueFor(state,values,kind) { return Object.hasOwn(state.pending,kind) ? state.pending[kind].value : values[kind]; }
  function notify(session,kind) { if (current===session) for (const listener of session.listeners) listener(kind,clone(valueFor(session.state,session.values,kind))); }
  function snapshotOK(preferences) {
    return preferences && typeof preferences==='object' && !Array.isArray(preferences)
      && Object.entries(preferences).every(([kind,row])=>kinds.includes(kind)
        && (row===null || row && integer(row.revision) && row.revision>0 && valid(kind,row.value)));
  }
  function missingSlot(session,kind,expected) {
    delete session.state.records[kind];
    // Expiry can remove the remote revision counter. Only a successful,
    // same-actor read of an absent slot permits a fresh create attempt. Never
    // infer absence from an error receipt or alter a newer local operation.
    if(expected?.baseRevision>0 && same(session.state.pending[kind],expected)
      && same(load(session.actor).pending[kind],expected)) {
      session.state.pending[kind]={...clone(expected),baseRevision:0,requestId:crypto.randomUUID()};
      store(session.actor,session.state,kind,expected);
    }
  }
  async function refresh(session) {
    const pendingAtRead=clone(session.state.pending);
    const response = await request(session.actor,'/api/account/preferences',{signal:AbortSignal.any([session.controller.signal,AbortSignal.timeout(3500)])});
    if (current!==session || !response.ok || response.headers.get('X-Stem-Account')!==session.actor) return false;
    const body = await response.json();
    if (current!==session || session.controller.signal.aborted || body.actor!==session.actor || !snapshotOK(body.preferences)) return false;
    for (const kind of kinds) {
      const row = body.preferences[kind];
      if (row==null) { missingSlot(session,kind,pendingAtRead[kind]); continue; }
      session.state.records[kind] = clone(row);
      if (!session.state.pending[kind]) { const changed=!same(session.values[kind],row.value); session.values[kind]=clone(row.value); if(changed)notify(session,kind); }
    }
    store(session.actor,session.state);
    return true;
  }
  async function flush(session) {
    if (current!==session || session.controller.signal.aborted) return;
    while(session.sending)await session.sending;
    if (current!==session || session.controller.signal.aborted) return;
    let finish;session.sending=new Promise(resolve=>{finish=resolve;});
    try {
      for (const kind of kinds) {
        const write = session.state.pending[kind]; if (!write) continue;
        try {
          const ack=await send(session.actor,kind,write,{signal:AbortSignal.any([session.controller.signal,AbortSignal.timeout(5000)]),detectMissing:true});
          if (current!==session || !ack) continue;
          if(ack.missingSlot) {
            const before=clone(session.state.pending[kind]);
            await refresh(session);
            const after=session.state.pending[kind];
            if(current===session && before?.baseRevision>0 && after?.baseRevision===0 && after.requestId!==before.requestId)schedule(session);
            continue;
          }
          const pending=session.state.pending[kind], persistedExpected=clone(pending);
          if (same(pending,write)) delete session.state.pending[kind];
          else if (pending && ack.outcome==='applied' && pending.baseRevision===write.baseRevision) { pending.baseRevision=ack.revision; pending.requestId=crypto.randomUUID(); schedule(session); }
          if (ack.outcome==='applied') { session.state.records[kind]={value:clone(write.value),revision:ack.revision}; if(!session.state.pending[kind])session.values[kind]=clone(write.value); }
          store(session.actor,session.state,kind,persistedExpected);
          if (ack.outcome==='conflict') await refresh(session);
        } catch { /* Journal stays intact on transport, scope or malformed receipt failure. */ }
      }
    } finally { session.sending=false;finish(); }
  }
  function schedule(session) { clearTimeout(session.timer); session.timer=setTimeout(()=>void flush(session),300); }
  function set(kind,value) {
    const session=current;
    if (!session || !valid(kind,value) || same(valueFor(session.state,session.values,kind),value)) return;
    session.values[kind]=clone(value);
    session.state.pending[kind]={requestId:crypto.randomUUID(),baseRevision:session.state.records[kind]?.revision || 0,value:clone(value)};
    store(session.actor,session.state,kind);notify(session,kind);schedule(session);
  }
  async function start(actor) {
    stop(); if(!actorOK(actor))return;
    const state=load(actor), session={actor,state,values:{...legacy(actor),...Object.fromEntries(Object.entries(state.records).map(([kind,row])=>[kind,row.value]))},controller:new AbortController(),listeners:new Set(),timer:null,sending:false};
    current=session;
    // Bound bootstrap independently of the lifetime controller. On an outage,
    // the verified actor's local journal is still available and retries later.
    const deadline=setTimeout(()=>session.bootstrap?.abort(),3500); session.bootstrap=new AbortController();
    const pendingAtRead=clone(state.pending);
    try {
      const response=await request(actor,'/api/account/preferences',{signal:AbortSignal.any([session.controller.signal,session.bootstrap.signal])});
      const body=await response.json();
      if(current!==session || !response.ok || response.headers.get('X-Stem-Account')!==actor || body.actor!==actor || !snapshotOK(body.preferences))return;
      const missing={};
      for(const kind of kinds) {
        const row=body.preferences[kind];
        if(row && integer(row.revision) && row.revision>0 && valid(kind,row.value)) {
          session.state.records[kind]=clone(row);
          if(!session.state.pending[kind])session.values[kind]=clone(row.value);
        } else {
          missingSlot(session,kind,pendingAtRead[kind]);
          if(Object.hasOwn(session.values,kind) && !session.state.pending[kind])missing[kind]=session.values[kind];
        }
      }
      store(actor,state);
      await seed(actor,{signal:AbortSignal.any([session.controller.signal,session.bootstrap.signal]),records:missing,drain:false});
      if(current!==session)return;
      await refresh(session);
    } catch { /* Local state is a fallback, never evidence that a server slot is absent. */ }
    finally { clearTimeout(deadline); if(current===session) { schedule(session);for(const kind of kinds)notify(session,kind); } }
  }
  window.StemPreferences={start,stop,seed,claim,set,get:kind=>current?clone(valueFor(current.state,current.values,kind)):undefined,
    subscribe(listener){if(!current)return()=>{};const session=current;session.listeners.add(listener);return()=>session.listeners.delete(listener);},

    flush:()=>current?flush(current):Promise.resolve(),valid};
  window.addEventListener?.('online',()=>{if(current)void flush(current);});
})();
