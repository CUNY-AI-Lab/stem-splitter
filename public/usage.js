/* Discrete, content-free product diagnostics. Playback never waits for this.
 * In-memory queue only: at most 50 events, one network retry, no offline archive.
 * Stable IDs make that retry idempotent; page close/offline/rate limits can lose
 * events. These are observations, not billing or guaranteed delivery receipts. */
(() => {
  let active=false,course='personal',queue=[],timer=null,sending=false,generation=0,controller=null;
  const allowed=new Set(['session_start','page_view','playback_start','playback_stop','seek','download_intent']);
  function record(type,detail={}) {
    if(!active||!allowed.has(type)||queue.length>=50)return;
    const event={id:crypto.randomUUID(),type};
    if(typeof detail.jobId==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(detail.jobId))event.jobId=detail.jobId;
    if(Number.isFinite(detail.durationMs))event.durationMs=Math.min(86400000,Math.max(0,Math.round(detail.durationMs)));
    if(Number.isFinite(detail.position))event.positionBucket=Math.min(90,Math.max(0,Math.floor(detail.position/10)));
    queue.push(event);if(!timer)timer=setTimeout(flush,1200);
  }
  async function flush() {
    clearTimeout(timer);timer=null;
    if(sending||!active||!queue.length)return;
    sending=true;const current=generation;controller=new AbortController();const batch=queue.splice(0,10);
    try {
      for(let attempt=0;attempt<2;attempt++) {
        if(!active||generation!==current)break;
        try {
          const response=await fetch('/api/usage-events',{method:'POST',credentials:'same-origin',keepalive:true,signal:AbortSignal.any([AbortSignal.timeout(5000),controller.signal]),
            headers:{'Content-Type':'application/json','X-Stem-Course':course},body:JSON.stringify({events:batch})});
          if(response.ok||response.status<500)break;
        }catch{}
        if(attempt===0)await new Promise(resolve=>setTimeout(resolve,2000));
      }
    }finally{sending=false;if(queue.length&&active)timer=setTimeout(flush,1200);}
  }
  window.StemUsage={record,setCourse(value){course=typeof value==='string'?value:'personal';},start(){
    if(active)return;generation++;active=true;record('session_start');record('page_view');
  },clear(){generation++;controller?.abort();active=false;queue=[];clearTimeout(timer);timer=null;}};
  window.addEventListener('pagehide',()=>void flush());
})();
