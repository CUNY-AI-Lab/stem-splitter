(() => {
  const pending = new Map();
  // UI progress is scoped to its account and recording. Server ownership and
  // transcripts remain authoritative; this cache retains draft/player state and
  // unacknowledged requests until their server confirmation arrives.
  const progressKey = (subject, jobId) => `stem-listening:${subject}:${jobId}`;
  const normalize = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const stem = name => typeof name === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(name);
    const pendingConversation = value.pendingConversation;
    const pending = pendingConversation && Number.isSafeInteger(pendingConversation.revision) && pendingConversation.revision >= 0
      && Array.isArray(pendingConversation.entries) && pendingConversation.entries.length <= 60
      && pendingConversation.entries.every(entry => entry && ['you','coach','action'].includes(entry.kind) && typeof entry.text === 'string' && entry.text.trim() && entry.text.length <= 3000)
      ? {revision:pendingConversation.revision,entries:pendingConversation.entries.map(({kind,text})=>({kind,text}))} : null;
    const request = value.pendingChat;
    const chat = request && typeof request.messageId === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(request.messageId) && Array.isArray(request.messages)
      && request.messages.length > 0 && request.messages.length <= 12 && request.messages.at(-1)?.role === 'user'
      && request.messages.every(turn => turn && ['user','assistant'].includes(turn.role) && typeof turn.content === 'string' && turn.content.trim() && turn.content.length <= 2000)
      ? {messageId:request.messageId,messages:request.messages.map(({role,content})=>({role,content})),
        ...(Number.isFinite(request.durationSec) && request.durationSec > 0 ? {durationSec:request.durationSec} : {}),
        ...(Number.isSafeInteger(request.revision) && request.revision >= 0 ? {revision:request.revision} : {})} : null;
    const guide = value.pendingGuide && typeof value.pendingGuide.messageId === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value.pendingGuide.messageId)
      ? {messageId:value.pendingGuide.messageId,...(Number.isFinite(value.pendingGuide.durationSec) && value.pendingGuide.durationSec > 0 ? {durationSec:value.pendingGuide.durationSec} : {})} : null;
    return { ...(pending ? {pendingConversation:pending} : {}), ...(chat ? {pendingChat:chat} : {}), ...(guide ? {pendingGuide:guide} : {}), draft: typeof value.draft === 'string' ? value.draft.slice(0, 2000) : '',
      position: Number.isFinite(value.position) && value.position >= 0 ? Math.min(value.position, 86400) : 0,
      rate: [0.5, 0.75, 1, 1.25, 1.5].includes(value.rate) ? value.rate : 1,
      muted: Array.isArray(value.muted) ? value.muted.filter(stem).slice(0, 24) : [],
      solo: value.solo && stem(value.solo.stem) && ['behind', 'only'].includes(value.solo.stage)
        ? {stem:value.solo.stem,stage:value.solo.stage} : null,
      guideOpen: value.guideOpen === true,
      loop: value.loop && Number.isFinite(value.loop.start) && value.loop.start >= 0
        && Number.isFinite(value.loop.end) && value.loop.end > value.loop.start && value.loop.end <= 86400
        ? {start:value.loop.start,end:value.loop.end} : null,
    };
  };
  window.StemListeningProgress = {
    read(subject, jobId) { try { return normalize(JSON.parse(localStorage.getItem(progressKey(subject, jobId)) || 'null')); } catch { return null; } },
    save(subject, jobId, value) { try { if (subject) localStorage.setItem(progressKey(subject, jobId), JSON.stringify(normalize(value))); } catch {} },
  };
  window.StemGuestClaim = { run(account) {
    if (account?.quotaClass !== 'member' || !/^cail-[0-9a-f]{32}$/.test(account.subject)) return Promise.resolve([]);
    const subject = account.subject;
    if (pending.has(subject)) return pending.get(subject);
    const attempt = (async () => {
      const response = await fetch('/api/account/claim-guest', { method: 'POST', credentials: 'same-origin',
        cache: 'no-store', headers: { 'X-Stem-Claim-Actor': subject }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Guest splits could not be saved to your account yet. Reload to try again; the originals are preserved.');
      if (response.headers.get('X-Stem-Account') !== subject) throw new Error('Your account changed. Reload before saving guest splits.');
      const result = await response.json();
      if (!Array.isArray(result.claimedJobIds) || result.claimedJobIds.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(id))) throw new Error('Guest save confirmation was unavailable. Reload to try again.');
      // Server-confirmed ownership is authoritative. Browser IDs never go to the claim API.
      if (!/^jobs:guest-[0-9a-f]{64}$/.test(result.guestStorageKey ?? '')) return [];
      const allowed = new Set(result.claimedJobIds);
      const guestSubject = result.guestStorageKey.slice(5);
      for (const id of allowed) {
        const saved = window.StemListeningProgress.read(guestSubject, id);
        if (saved && !window.StemListeningProgress.read(subject, id)) window.StemListeningProgress.save(subject, id, saved);
      }
      try {
        const guest = JSON.parse(localStorage.getItem(result.guestStorageKey) || '[]');
        const key = `jobs:${subject}`, existing = JSON.parse(localStorage.getItem(key) || '[]');
        const layout = Array.isArray(guest) ? guest.filter(job=>job && allowed.has(job.id))
          .map(job=>({id:job.id,collapsed:job.collapsed===true})) : [];
        const merged = new Map(layout.map(job=>[job.id,job]));
        for (const job of Array.isArray(existing) ? existing : []) if(job && typeof job.id==='string') merged.set(job.id,job);
        localStorage.setItem(key,JSON.stringify([...merged.values()]));
        // Retain the guest cache even after confirmation; never delete local originals.
        return layout;
      } catch { return []; } // Account persistence already succeeded, even with storage unavailable.
    })().finally(()=>{pending.delete(subject);});
    pending.set(subject, attempt);
    return attempt;
  }};
})();
