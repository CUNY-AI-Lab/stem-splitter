// Public configuration carries only the widget site key. The server verifies
// the challenge and owns the HttpOnly guest cookie, limits, and private work.
(() => {
  let scriptReady;
  function loadWidget() {
    if (window.turnstile) return Promise.resolve();
    if (!scriptReady) scriptReady = new Promise((resolve,reject) => {
      const script=document.createElement('script');
      script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async=true;
      script.addEventListener('load',()=>window.turnstile ? resolve() : reject(new Error('The guest check did not load. Try again.')),{once:true});
      script.addEventListener('error',()=>{scriptReady=null;reject(new Error('The guest check could not connect. Try again.'));},{once:true});
      document.head.append(script);
    });
    return scriptReady;
  }
  window.StemGuest = {
    mount(container,configuration,state={}) {
      if (!container || configuration?.enabled !== true || configuration.canStart === false || !configuration.siteKey) return;
      const panel=document.createElement('section');
      panel.className='guest-access account-overview';
      panel.setAttribute('aria-label','Guest access');
      const description=document.createElement('p');
      description.className='account-help';
      description.textContent=state.active
        ? 'Guest session: 5 successful splits and 25 Listening Guy questions per UTC day. Failed splits and replies with no usable output return their place.'
        : 'Try as a guest: 5 successful splits and 25 Listening Guy questions per UTC day. Your guest work stays separate from CUNY accounts and courses.';
      const privacy=document.createElement('p');
      privacy.className='account-help';
      privacy.textContent='Guest access lasts 7 days in this browser. Clearing its cookie or ending the session removes access to its saved work. Guest limits are per browser session; abuse protection also applies.';
      const button=document.createElement('button');
      button.type='button';button.className='account-button';
      button.textContent=state.active ? 'Refresh guest check' : 'Continue as guest';
      const status=document.createElement('p');status.className='account-help';status.setAttribute('role','status');
      if(state.verificationRequired)status.textContent='Complete a fresh guest check before your first split or question today.';
      const widget=document.createElement('div');
      let widgetId;
      button.addEventListener('click',async()=>{
        button.disabled=true;status.textContent='Loading the guest check…';
        try {
          await loadWidget();
          if(widgetId!==undefined){window.turnstile.reset(widgetId);status.textContent='Complete the guest check.';return;}
          widgetId=window.turnstile.render(widget,{sitekey:configuration.siteKey,action:'stem_guest',size:'compact',
            callback:async token=>{
              status.textContent='Starting your guest session…';
              try {
                const response=await fetch('/auth/guest',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
                const result=await response.json();
                if(!response.ok)throw new Error(result.error?.message || 'The guest session could not start. Try again.');
                location.reload();
              }catch(error){status.textContent=error.message;button.disabled=false;window.turnstile.reset(widgetId);}
            },
            'error-callback':()=>{status.textContent='The guest check could not complete. Try again.';button.disabled=false;},
            'expired-callback':()=>{status.textContent='The guest check expired. Try again.';button.disabled=false;},
          });
          status.textContent='Complete the guest check.';
        }catch(error){status.textContent=error.message;button.disabled=false;}
      });
      const links=document.createElement('p');links.className='account-help';
      const login=document.createElement('a');login.href='/auth/login';login.textContent='CUNY Login';
      const access=document.createElement('a');access.href='https://ailab.gc.cuny.edu/request-access/';access.textContent='Request Lab access';
      links.append(login,' · ',access);
      panel.append(description,privacy,button,status,widget,links);container.append(panel);
    },
  };
})();
