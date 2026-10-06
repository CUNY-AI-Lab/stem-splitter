/* A page belongs to one verified account. Never carry its visible drafts or
 * private data through sign-out, a second sign-in, or a restored browser page. */
(() => {
  let subject=null, clearing=false, checking=null, cleanup=()=>{};
  function clear() {
    if(clearing)return;clearing=true;
    cleanup();
    for(const audio of document.querySelectorAll('audio'))audio.pause();
    const main=document.querySelector('main');
    if(main){const message=document.createElement('p');message.setAttribute('role','status');message.textContent='Your account changed. Reloading your workspace…';main.replaceChildren(message);}
    location.reload();
  }
  function observe(response) {
    const actor=response.headers.get('X-Stem-Account');
    if(subject&&actor&&actor!==subject){clear();throw Object.assign(new Error('Your account changed. Reload the page.'),{status:401});}
    return response;
  }
  async function check() {
    if(!subject||clearing)return;
    if(checking)return checking;
    checking=(async()=>{try{const response=observe(await fetch('/api/account',{cache:'no-store',credentials:'same-origin'}));if([401,403].includes(response.status)){clear();return;}if(response.ok&&(await response.json()).account?.subject!==subject)clear();}catch{/* An outage does not change an identity. */}finally{checking=null;}})();
    return checking;
  }
  window.StemSessionGuard={start(value,onClear){subject=value;cleanup=onClear||cleanup;},observe,check,clear};
  window.addEventListener('focus',()=>void check());
  window.addEventListener('pageshow',event=>{if(event.persisted&&subject)clear();});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void check();});
})();
