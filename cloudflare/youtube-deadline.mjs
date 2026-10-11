export class DeadlineError extends Error { constructor(){super('source_timeout');this.code='source_timeout';} }

/** Bound awaited SDK work without changing any source request or browser settings. */
export function createBrowserDeadline(deadline,{now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,onExpire=()=>{}}={}){
 let expired=false,disposed=false,rejectDeadline;
 const failure=new DeadlineError();
 const timeout=new Promise((_,reject)=>{rejectDeadline=reject;});timeout.catch(()=>{});
 const expire=()=>{if(expired)return;expired=true;rejectDeadline(failure);try{Promise.resolve(onExpire()).catch(()=>{});}catch{}};
 const remaining=deadline-now();
 const timer=setTimer(expire,Math.max(0,remaining));
 if(!Number.isFinite(deadline)||remaining<=0)expire();
 const run=(operation,onLate)=>{
  if(expired||disposed||now()>=deadline){if(!disposed)expire();return Promise.reject(failure);}
  const pending=Promise.resolve().then(()=>{
   if(expired||disposed||now()>=deadline){if(!disposed)expire();throw failure;}
   return operation();
  }).then(value=>{
   if(expired||now()>=deadline){expire();if(onLate){try{Promise.resolve(onLate(value)).catch(()=>{});}catch{}}throw failure;}
   return value;
  });
  return Promise.race([pending,timeout]);
 };
 return Object.freeze({run,expired:()=>expired,dispose:()=>{disposed=true;clearTimer(timer);}});
}
