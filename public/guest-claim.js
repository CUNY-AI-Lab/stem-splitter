(() => {
  const pending = new Map();
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
