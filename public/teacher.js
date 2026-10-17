// Instructor console: authenticate, inspect the code-owned prompt, and edit
// only the versioned class amendment. The session lives in an HttpOnly cookie;
// no credential or session token is stored in browser storage.

const signinPanel = document.getElementById('signin-panel');
const signinForm = document.getElementById('signin-form');
const signinError = document.getElementById('signin-error');
const consolePanel = document.getElementById('console-panel');
const teacherWho = document.getElementById('teacher-who');
const signoutBtn = document.getElementById('signout');

const promptForm = document.getElementById('prompt-form');
const amendment = document.getElementById('amendment');
const amendmentCount = document.getElementById('amendment-count');
const amendmentMeta = document.getElementById('amendment-meta');
const changeNote = document.getElementById('change-note');
const changeNoteCount = document.getElementById('change-note-count');
const promptStatus = document.getElementById('prompt-status');
const effectivePromptMeta = document.getElementById('effective-prompt-meta');

const fixedPromptMeta = document.getElementById('fixed-prompt-meta');
const fixedPromptDetails = document.getElementById('fixed-prompt-details');
const fixedPromptScroll = document.getElementById('fixed-prompt-scroll');
const fixedPromptBody = document.getElementById('fixed-prompt-body');
const fixedPromptToggle = document.getElementById('fixed-prompt-toggle');
const fixedPromptToggleLabel = document.getElementById('fixed-prompt-toggle-label');

const previewBtn = document.getElementById('preview-btn');
const previewWrap = document.getElementById('preview-wrap');
const previewBody = document.getElementById('preview-body');

const historyList = document.getElementById('prompt-history');
const historyEmpty = document.getElementById('prompt-history-empty');
const historyMoreBtn = document.getElementById('prompt-history-more');

let maxChars = 2000;
let maxChangeNoteChars = 240;
let loadedAmendment = '';
let loadedRevision = 0;
let showingPromptTop = false;
let historyNextBeforeId = null;
let historyLoading = false;

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(body.error?.message || body.error || `Request failed (${res.status})`), {
      status: res.status,
    });
  }
  return body;
}

function showPanel(signedIn, teacher) {
  signinPanel.hidden = signedIn;
  consolePanel.hidden = !signedIn;
  if (signedIn) {
    const displayName = String(teacher.displayName || '').trim();
    teacherWho.textContent = /^instructor$/i.test(displayName) ? '' : displayName;
  }
}

function showStatus(message, isError = false) {
  promptStatus.hidden = !message;
  promptStatus.textContent = message;
  promptStatus.classList.toggle('error', isError);
}

function clearTeacherConsole() {
  clearSongSampleEditor();
  signinForm.reset();
  promptForm.reset();
  loadedAmendment = '';
  loadedRevision = 0;
  teacherWho.textContent = '';
  fixedPromptMeta.textContent = '';
  fixedPromptMeta.removeAttribute('title');
  effectivePromptMeta.textContent = '';
  effectivePromptMeta.removeAttribute('title');
  amendmentMeta.textContent = '';
  fixedPromptBody.replaceChildren();
  previewBody.replaceChildren();
  previewWrap.hidden = true;
  previewWrap.open = false;
  renderHistory([]);
  setHistoryPagination(false, null);
  showingPromptTop = false;
  fixedPromptToggle.setAttribute('aria-expanded', 'false');
  fixedPromptToggleLabel.textContent = 'TOP';
  paintCounts();
  showStatus('');
}

function shortHash(value) {
  return typeof value === 'string' && value ? value.slice(0, 12) : '—';
}

function formatUtc(value) {
  if (!value) return '—';
  const normalized = /(?:Z|[+-]\d\d:?\d\d)$/.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }) + ' UTC';
}

function paintCounts() {
  const used = amendment.value.trim().length;
  amendmentCount.textContent = `${used} / ${maxChars}`;
  amendmentCount.classList.toggle('error', used > maxChars);

  const noteUsed = changeNote.value.trim().length;
  changeNoteCount.textContent = `${noteUsed} / ${maxChangeNoteChars}`;
  changeNoteCount.classList.toggle('error', noteUsed > maxChangeNoteChars);
}

function paintMeta(record) {
  amendmentMeta.textContent = record.updatedBy
    ? `Saved by ${record.updatedBy} · ${formatUtc(record.updatedAt)}`
    : '';
  fixedPromptMeta.textContent = record.basePromptVersion;
  effectivePromptMeta.textContent = record.revision ? `Revision ${record.revision}` : '';
}

function appendWords(element, text) {
  if (element.textContent) element.append(document.createTextNode(' '));
  element.append(document.createTextNode(text));
}

/**
 * Render the prompt as readable Markdown-like structure without using
 * innerHTML. The production prompt remains plain text; this is a safe,
 * presentation-only view of headings, numbered rules, bullets, and paragraphs.
 */
function renderPromptMarkdown(text, target) {
  target.replaceChildren();
  let list = null;
  let listType = '';
  let item = null;
  let paragraph = null;

  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      list = null;
      listType = '';
      item = null;
      paragraph = null;
      continue;
    }

    const heading =
      trimmed.length < 100 &&
      (/^[A-Z][A-Z0-9 ’'"():,\/—-]+$/.test(trimmed) ||
        /^[A-Z][A-Z ]{4,}(?:\(|—)/.test(trimmed)) &&
      !/[.!?]$/.test(trimmed);
    if (heading) {
      list = null;
      listType = '';
      item = null;
      paragraph = null;
      const h = document.createElement('h4');
      h.textContent = trimmed;
      target.appendChild(h);
      continue;
    }

    const bullet = /^-\s+(.+)$/.exec(trimmed);
    const numbered = /^(\d+)\.\s+(.+)$/.exec(trimmed);
    if (bullet || numbered) {
      const nextType = bullet ? 'ul' : 'ol';
      if (!list || listType !== nextType) {
        list = document.createElement(nextType);
        target.appendChild(list);
        listType = nextType;
      }
      item = document.createElement('li');
      item.textContent = bullet ? bullet[1] : numbered[2];
      list.appendChild(item);
      paragraph = null;
      continue;
    }

    if (item && /^\s+/.test(raw)) {
      appendWords(item, trimmed);
      continue;
    }

    list = null;
    listType = '';
    item = null;
    if (!paragraph) {
      paragraph = document.createElement('p');
      target.appendChild(paragraph);
    }
    appendWords(paragraph, trimmed);
  }
}

function showPromptEnd() {
  showingPromptTop = false;
  fixedPromptToggle.setAttribute('aria-expanded', 'false');
  fixedPromptToggleLabel.textContent = 'TOP';
  fixedPromptScroll.scrollTo({ top: fixedPromptScroll.scrollHeight, behavior: 'smooth' });
}

function showPromptTop() {
  showingPromptTop = true;
  fixedPromptToggle.setAttribute('aria-expanded', 'true');
  fixedPromptToggleLabel.textContent = 'END';
  fixedPromptScroll.focus({ preventScroll: true });
  fixedPromptScroll.scrollTo({ top: 0, behavior: 'smooth' });
  requestAnimationFrame(() => {
    fixedPromptScroll.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function renderHistory(history, append = false) {
  if (!append) historyList.replaceChildren();

  for (const revision of history) {
    const item = document.createElement('li');
    item.className = 'teacher-history-item';

    const head = document.createElement('div');
    head.className = 'teacher-history-head';

    const title = document.createElement('strong');
    title.textContent = `REVISION ${revision.settingsRevision} · ${revision.changeNote}`;
    const time = document.createElement('span');
    time.className = 'mono';
    time.textContent = formatUtc(revision.createdAt);
    head.append(title, time);

    const trace = document.createElement('p');
    trace.className = 'teacher-history-trace mono';
    trace.textContent =
      `${revision.updatedBy.toUpperCase()} · BASE ${revision.basePromptVersion} ` +
      `${shortHash(revision.basePromptHash)} · EFFECTIVE ${shortHash(revision.effectivePromptHash)}`;
    trace.title =
      `Base policy SHA-256: ${revision.basePromptHash}\n` +
      `Effective policy SHA-256: ${revision.effectivePromptHash}`;

    const details = document.createElement('details');
    details.className = 'teacher-history-details';
    const summary = document.createElement('summary');
    summary.className = 'mono';
    summary.textContent = revision.amendment
      ? 'VIEW APPENDED SNAPSHOT'
      : 'VIEW EMPTY APPENDIX SNAPSHOT';
    const body = document.createElement('div');
    body.className = 'teacher-markdown teacher-history-snapshot';
    if (revision.amendment) {
      renderPromptMarkdown(revision.amendment, body);
    } else {
      const empty = document.createElement('p');
      empty.textContent = 'No appended class instructions.';
      body.appendChild(empty);
    }
    details.append(summary, body);
    item.append(head, trace, details);
    historyList.appendChild(item);
  }
  historyEmpty.hidden = historyList.children.length > 0;
}

function setHistoryPagination(hasMore, nextBeforeId) {
  historyNextBeforeId = hasMore && Number.isSafeInteger(nextBeforeId)
    ? nextBeforeId
    : null;
  historyMoreBtn.hidden = historyNextBeforeId === null;
}

async function loadPrompt() {
  const record = await api('/api/teacher/prompt');
  maxChars = record.maxChars ?? maxChars;
  maxChangeNoteChars = record.maxChangeNoteChars ?? maxChangeNoteChars;
  amendment.maxLength = maxChars;
  changeNote.maxLength = maxChangeNoteChars;
  amendment.value = record.amendment || '';
  loadedAmendment = amendment.value.trim();
  loadedRevision = record.revision ?? 0;
  renderPromptMarkdown(record.basePrompt || '', fixedPromptBody);
  paintCounts();
  paintMeta(record);
  renderHistory(record.history || []);
  setHistoryPagination(record.historyHasMore, record.historyNextBeforeId);
  requestAnimationFrame(() => {
    fixedPromptScroll.scrollTop = fixedPromptScroll.scrollHeight;
  });
}

signinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  signinError.hidden = true;
  try {
    const teacher = await api('/api/teacher/login', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('signin-username').value,
        password: document.getElementById('signin-password').value,
      }),
    });
    document.getElementById('signin-password').value = '';
    await loadPrompt();
    await loadSongSampleEditor();
    showPanel(true, teacher);
  } catch (error) {
    signinError.hidden = false;
    signinError.textContent = error.message;
  }
});

signoutBtn.addEventListener('click', async () => {
  signoutBtn.disabled = true;
  try {
    await api('/api/teacher/logout', { method: 'POST' });
    clearTeacherConsole();
    showPanel(false);
  } catch {
    showStatus('Sign out failed. Your session may still be active. Try again.', true);
  } finally {
    signoutBtn.disabled = false;
  }
});


amendment.addEventListener('input', paintCounts);
changeNote.addEventListener('input', paintCounts);

fixedPromptToggle.addEventListener('click', () => {
  if (showingPromptTop) showPromptEnd();
  else showPromptTop();
});

fixedPromptDetails.addEventListener('toggle', () => {
  if (!fixedPromptDetails.open) return;
  requestAnimationFrame(showPromptEnd);
});

promptForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const nextAmendment = amendment.value.trim();
  const changed = nextAmendment !== loadedAmendment;
  if (changed && !changeNote.value.trim()) {
    showStatus('Add a change note before saving.', true);
    changeNote.focus();
    return;
  }

  showStatus('SAVING…');
  try {
    const record = await api('/api/teacher/prompt', {
      method: 'PUT',
      body: JSON.stringify({
        amendment: amendment.value,
        changeNote: changeNote.value,
        expectedRevision: loadedRevision,
      }),
    });

    if (!record.changed) {
      showStatus('Nothing changed.');
      return;
    }

    changeNote.value = '';
    await loadPrompt();
    showStatus(
      record.guidesCleared ? 'Saved. Applies when a guide is generated.' : 'Saved.'
    );
    if (!previewWrap.hidden) await loadPreview();
  } catch (error) {
    showStatus(error.message, true);
  }
});

async function loadPreview() {
  const { prompt } = await api('/api/teacher/prompt/preview');
  renderPromptMarkdown(prompt, previewBody);
}

previewBtn.addEventListener('click', async () => {
  try {
    await loadPreview();
    previewWrap.hidden = false;
    previewWrap.open = true;
    previewWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    showStatus(error.message, true);
  }
});

historyMoreBtn.addEventListener('click', async () => {
  if (historyLoading || historyNextBeforeId === null) return;
  historyLoading = true;
  historyMoreBtn.disabled = true;
  historyMoreBtn.textContent = 'LOADING EARLIER REVISIONS…';
  try {
    const page = await api(
      `/api/teacher/prompt/history?before=${encodeURIComponent(historyNextBeforeId)}`
    );
    renderHistory(page.history || [], true);
    setHistoryPagination(page.historyHasMore, page.historyNextBeforeId);
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    historyLoading = false;
    historyMoreBtn.disabled = false;
    historyMoreBtn.textContent = 'LOAD EARLIER REVISIONS';
  }
});

(async function init() {
  let cail = false;
  try {
    const runtime = await api('/api/runtime');
    cail = runtime.authMode === 'cail';
    if (cail) {
      signinForm.hidden = true;
      signoutBtn.hidden = true;
      const message = document.createElement('p');
      message.textContent = 'Sign in with your CUNY account to open the system prompt.';
      signinPanel.append(message);
      if (runtime.loginUrl) {
        const link = document.createElement('a');
        link.className = 'account-button';
        link.href = `${runtime.loginUrl}?next=/teacher.html`;
        link.textContent = 'CUNY Login';
        signinPanel.append(link);
      }
    }
    const { teacher } = await api('/api/teacher/me');
    if (!teacher) {
      showPanel(false);
      if (cail) signinPanel.querySelector('p').textContent = 'Instructor access is required to edit the system prompt.';
      return;
    }
    if (cail) {
      const { account } = await api('/api/account');
      window.StemSessionGuard?.start(account.subject, () => { amendment.value = ''; changeNote.value = ''; fixedPromptBody.replaceChildren(); previewBody.replaceChildren(); historyList.replaceChildren(); clearSongSampleEditor(); });
      try { await window.StemGuestClaim.run(account); } catch { /* Preserve guest originals; retry on return to Splitter. */ }
    }
    await loadPrompt();
    await loadSongSampleEditor();
    showPanel(true, teacher);
  } catch {
    showPanel(false);
  }
})();


// Public song metadata only; teacher credentials remain in the existing session.
const sampleForm=document.getElementById('sample-settings-form');
const sampleSearch=document.getElementById('sample-search');
const sampleResults=document.getElementById('sample-search-results');
const sampleSelected=document.getElementById('sample-selected');
const sampleSettingsStatus=document.getElementById('sample-settings-status');
let selectedSamples=[],sampleCatalog=[],sampleRevision=0,sampleSearchTimer=0,sampleSearchAbort=null,sampleEditorGeneration=0;
const sampleKey=t=>`${t.archiveId}/${t.archiveFile}`;
function sampleEditorStatus(message,error=false){sampleSettingsStatus.textContent=message;sampleSettingsStatus.classList.toggle('error',error);}
function clearSongSampleEditor(){sampleEditorGeneration++;sampleSearchAbort?.abort();clearTimeout(sampleSearchTimer);selectedSamples=[];sampleCatalog=[];sampleRevision=0;sampleForm.reset();sampleSelected.replaceChildren();sampleResults.replaceChildren();document.getElementById('sample-search-status').textContent='';document.getElementById('sample-settings-meta').textContent='';sampleEditorStatus('');}
function renderSampleChoices(tracks){
  sampleResults.replaceChildren();
  for(const track of tracks.slice(0,24)){
    const button=document.createElement('button');button.type='button';button.setAttribute('role','option');
    const chosen=selectedSamples.some(t=>sampleKey(t)===sampleKey(track));button.disabled=chosen;button.setAttribute('aria-selected',String(chosen));
    const length=track.durationSec?` · ${Math.floor(Math.round(track.durationSec)/60)}:${String(Math.round(track.durationSec)%60).padStart(2,'0')}`:'';
    button.textContent=`${track.artist} — ${track.title}${length}${track.itemTitle&&track.itemTitle!==track.title?' · '+track.itemTitle:''}${chosen?' · selected':''}`;
    button.addEventListener('click',()=>{if(selectedSamples.length>=64)return sampleEditorStatus('Choose up to 64 songs.',true);selectedSamples.push({...track});renderSelectedSamples();renderSampleChoices(tracks);sampleEditorStatus('Unsaved song changes.');});
    sampleResults.append(button);
  }
}
function moveSample(from,to){if(to<0||to>=selectedSamples.length||from===to)return;const [track]=selectedSamples.splice(from,1);selectedSamples.splice(to,0,track);renderSelectedSamples();sampleSelected.children[to]?.focus();sampleEditorStatus('Unsaved song order.');}
function renderSelectedSamples(){
  sampleSelected.replaceChildren();
  selectedSamples.forEach((track,index)=>{
    const card=document.createElement('li');card.className='sample-card';card.draggable=true;card.tabIndex=0;card.dataset.key=sampleKey(track);card.setAttribute('aria-label',`${index+1}. ${track.artist} — ${track.title}`);
    const label=document.createElement('strong');label.textContent=`${index+1}. ${track.artist} — ${track.title}`;
    const meta=document.createElement('p');meta.className='teacher-help';
    const checked=track.verifiedAt?`Archive checked ${formatUtc(track.verifiedAt)}`:'Archive delivery verified when selected';
    meta.textContent=(track.genre?track.genre+' · ':'')+checked+(track.importTestedAt?' · complete import tested':'')+(track.durationSec?` · ${Math.round(track.durationSec)} seconds`:'')+(track.successfulRuns?` · ${track.successfulRuns} successful split${track.successfulRuns===1?'':'s'}`:'');
    const genre=document.createElement('select');genre.setAttribute('aria-label',`Musical style: ${track.title}`);for(const value of ['jazz','electronic','country','funk','rock','folk','other']){const option=document.createElement('option');option.value=value;option.textContent=value;genre.append(option);}genre.value=track.genre||'other';genre.addEventListener('change',()=>{track.genre=genre.value;sampleEditorStatus('Unsaved musical style.');});
    const actions=document.createElement('div');actions.className='sample-card-actions';
    for(const [text,delta] of [['Move up',-1],['Move down',1]]){const b=document.createElement('button');b.type='button';b.className='crate-page-btn';b.textContent=text;b.disabled=index+delta<0||index+delta>=selectedSamples.length;b.setAttribute('aria-label',`${text}: ${track.title}`);b.addEventListener('click',()=>moveSample(index,index+delta));actions.append(b);}
    const remove=document.createElement('button');remove.type='button';remove.className='crate-page-btn';remove.textContent='Remove';remove.setAttribute('aria-label',`Remove: ${track.title}`);remove.addEventListener('click',()=>{selectedSamples.splice(index,1);renderSelectedSamples();renderSampleChoices(sampleCatalog.filter(t=>`${t.artist} ${t.title}`.toLowerCase().includes(sampleSearch.value.toLowerCase())));sampleEditorStatus('Unsaved song changes.');});actions.append(remove);
    const grip=document.createElement('span');grip.className='sample-drag-handle';grip.draggable=false;grip.textContent='⠿';grip.setAttribute('aria-hidden','true');
    // Pointer dragging works with touch as well as a mouse; native card drag
    // remains a fallback. Capture keeps the gesture stable while auto-scrolling.
    let pointerDrag=null,dragFrame=0;
    const paintDrag=()=>{
      if(!pointerDrag)return;
      if(pointerDrag.y<70)window.scrollBy(0,-16);else if(pointerDrag.y>innerHeight-70)window.scrollBy(0,16);
      sampleSelected.querySelectorAll('.sample-drag-target').forEach(el=>el.classList.remove('sample-drag-target'));
      document.elementFromPoint(pointerDrag.x,pointerDrag.y)?.closest('.sample-card')?.classList.add('sample-drag-target');
      dragFrame=requestAnimationFrame(paintDrag);
    };
    const finishDrag=event=>{
      if(!pointerDrag||event.pointerId!==pointerDrag.id)return;
      const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('.sample-card');
      const to=selectedSamples.findIndex(t=>sampleKey(t)===target?.dataset.key),from=selectedSamples.findIndex(t=>sampleKey(t)===sampleKey(track));
      pointerDrag=null;cancelAnimationFrame(dragFrame);card.classList.remove('sample-dragging');sampleSelected.querySelectorAll('.sample-drag-target').forEach(el=>el.classList.remove('sample-drag-target'));
      if(grip.hasPointerCapture(event.pointerId))grip.releasePointerCapture(event.pointerId);
      if(event.type==='pointerup'&&from>=0&&to>=0)moveSample(from,to);
    };
    grip.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();pointerDrag={id:event.pointerId,x:event.clientX,y:event.clientY};grip.setPointerCapture(event.pointerId);card.classList.add('sample-dragging');dragFrame=requestAnimationFrame(paintDrag);});
    grip.addEventListener('pointermove',event=>{if(pointerDrag){pointerDrag.x=event.clientX;pointerDrag.y=event.clientY;}});
    grip.addEventListener('pointerup',finishDrag);grip.addEventListener('pointercancel',finishDrag);grip.addEventListener('lostpointercapture',finishDrag);
    card.append(grip,label,meta,genre,actions);
    card.addEventListener('dragstart',event=>{event.dataTransfer.setData('text/plain',sampleKey(track));event.dataTransfer.effectAllowed='move';});
    card.addEventListener('dragenter',event=>event.preventDefault());
    card.addEventListener('dragover',event=>{event.preventDefault();event.dataTransfer.dropEffect='move';});
    card.addEventListener('drop',event=>{event.preventDefault();const from=selectedSamples.findIndex(t=>sampleKey(t)===event.dataTransfer.getData('text/plain'));if(from>=0)moveSample(from,index);});
    card.addEventListener('keydown',event=>{if(event.target!==card||!['ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();moveSample(index,index+(event.key==='ArrowUp'?-1:1));});
    sampleSelected.append(card);
  });
}
async function loadSongSampleEditor(){
  const generation=sampleEditorGeneration;
  try{
    const resource=await api('/api/teacher/song-samples');if(generation!==sampleEditorGeneration)return;
    sampleRevision=resource.revision;sampleCatalog=resource.catalog||[];
    selectedSamples=resource.settings.tracks.map(t=>({...sampleCatalog.find(c=>sampleKey(c)===sampleKey(t)),...t}));
    document.getElementById('samples-enabled').checked=resource.settings.enabled;
    document.getElementById('samples-reshuffle').checked=resource.settings.reshuffle;
    document.getElementById('samples-hold').value=resource.settings.holdMs/1000;
    document.getElementById('samples-cadence').value=resource.settings.cadenceMs/1000;
    document.getElementById('sample-settings-meta').textContent=resource.updatedBy?`Revision ${resource.revision} · Saved ${formatUtc(resource.updatedAt)}`:'Six Archive-verified starting examples. Add songs from the full catalog or search.';
    renderSelectedSamples();renderSampleChoices(sampleCatalog);sampleEditorStatus('');return true;
  }catch(error){sampleEditorStatus(error.message,true);return false;}
}
async function streamSampleSearch(query,signal,receive){
  const response=await fetch('/api/music/search?examples=1&q='+encodeURIComponent(query),{credentials:'same-origin',headers:{Accept:'application/x-ndjson'},signal});
  if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error(error.error||'Archive search is temporarily unavailable.');}
  if(!response.headers.get('content-type')?.includes('application/x-ndjson')){receive(await response.json());return;}
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',bytes=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>2000000)throw new Error('Try a more specific artist or title.');buffer+=decoder.decode(value,{stream:true});let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(line){const event=JSON.parse(line);if(event.error)throw new Error(typeof event.error==='string'?event.error:'Archive search was interrupted.');receive(event);}}}if(buffer.trim())receive(JSON.parse(buffer));}finally{await reader.cancel().catch(()=>{});}
}
sampleSearch.addEventListener('keydown',event=>{if(event.key==='Enter')event.preventDefault();});
sampleSearch.addEventListener('input',()=>{
  clearTimeout(sampleSearchTimer);sampleSearchAbort?.abort();
  const query=sampleSearch.value.trim(),generation=sampleEditorGeneration;
  const local=sampleCatalog.filter(t=>`${t.artist} ${t.title}`.toLowerCase().includes(query.toLowerCase()));renderSampleChoices(local);
  const status=document.getElementById('sample-search-status');
  if(/^(?:https?:\/\/|archive\.org\/)/i.test(query)){renderSampleChoices([]);status.textContent='Search by artist or song title.';return;}
  status.textContent=query.length>=2?'Checking Internet Archive…':'';
  if(query.length<2)return;
  sampleSearchTimer=setTimeout(async()=>{
    const controller=new AbortController();sampleSearchAbort=controller;
    try{
      const loaded=new Map(local.map(t=>[sampleKey(t),t]));
      await streamSampleSearch(query,controller.signal,response=>{
        if(controller.signal.aborted||generation!==sampleEditorGeneration||sampleSearch.value.trim()!==query)return;
        const remote=(response.results||[]).map(t=>({artist:t.artist||t.fileCreator||t.itemCreator,title:t.title,archiveId:t.archiveId,archiveFile:t.archiveFile,durationSec:t.durationSec,itemTitle:t.itemTitle,verifiedAt:new Date().toISOString()})).filter(t=>t.artist&&t.archiveId&&t.archiveFile);
        for(const track of remote)loaded.set(sampleKey(track),{...loaded.get(sampleKey(track)),...track});renderSampleChoices([...loaded.values()]);status.textContent=loaded.size?'Choose a recording. More matches load as they are verified.':'Checking Internet Archive…';
      });
      if(!controller.signal.aborted&&generation===sampleEditorGeneration)status.textContent=loaded.size?'Choose a recording to add.':'No verified recording found. Try another artist or title.';
    }catch(error){if(!controller.signal.aborted)status.textContent=local.length?'Showing verified catalog matches. Archive search is temporarily unavailable.':error.message;}
  },250);
});
sampleForm.addEventListener('submit',async event=>{
  event.preventDefault();const generation=sampleEditorGeneration;const button=document.getElementById('samples-save');button.disabled=true;sampleEditorStatus('Verifying new songs and saving…');
  try{
    const settings={enabled:document.getElementById('samples-enabled').checked,reshuffle:document.getElementById('samples-reshuffle').checked,holdMs:Math.round(Number(document.getElementById('samples-hold').value)*1000),cadenceMs:Math.round(Number(document.getElementById('samples-cadence').value)*1000),tracks:selectedSamples};
    await api('/api/teacher/song-samples',{method:'PUT',body:JSON.stringify({expectedRevision:sampleRevision,settings})});
    if(generation!==sampleEditorGeneration)return;
    if(!await loadSongSampleEditor())throw new Error('Saved, but the readback failed. Reload saved songs before editing again.');sampleEditorStatus('Saved. Open search fields refresh within 30 seconds.');
  }catch(error){if(generation===sampleEditorGeneration)sampleEditorStatus(error.message,true);}finally{button.disabled=false;}
});
document.getElementById('samples-reload').addEventListener('click',()=>{sampleEditorGeneration++;sampleSearchAbort?.abort();void loadSongSampleEditor();});
