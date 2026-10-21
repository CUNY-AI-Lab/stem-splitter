import test from 'node:test';
import assert from 'node:assert/strict';
import { handleBugReport, type BugReportService } from './bug-reports.ts';
const origin='https://report.test';
const report={reportId:'77000000-0000-4000-8000-000000000001',description:'The button stayed unavailable after the operation.',path:'/'};
const headers={origin,'content-type':'application/json','cf-connecting-ip':'192.0.2.5'};
const request=(data:unknown=report,extra:Record<string,string>={})=>new Request(origin+'/api/bug-reports',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(data)});
type Submission=Parameters<BugReportService['submitPublic']>[0];
function fixture(){
 const calls:Submission[]=[];
 const options={origin,release:'fixture-release',limiter:{limit:async()=>({success:true})},service:{submitPublic:async(input:Submission)=>{calls.push(input);return {ok:true as const,status:'accepted' as const,reportId:input.reportId};}}};
 return {options,calls};
}
test('anonymous reporting forwards only the description, sanitized context and daily IP digest',async()=>{
 const {options,calls}=fixture();const response=await handleBugReport(request(report,{cookie:'private-session',authorization:'private-token','x-cail-subject':'forged'}),options);
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,status:'accepted',reportId:report.reportId});assert.equal(calls.length,1);
 assert.deepEqual(Object.keys(calls[0]).sort(),['description','origin','path','rateDay','rateKey','release','reportId']);assert.match(calls[0].rateKey,/^[a-f0-9]{64}$/);
 assert.equal(calls[0].rateDay,new Date().toISOString().slice(0,10));assert.doesNotMatch(JSON.stringify(calls),/private-session|private-token|forged|192\.0\.2\.5/);assert.match(response.headers.get('cache-control')!,/no-store/);
});
test('identity, recipients, extra context, controls and oversized bodies never reach the receiver',async()=>{
 const {options,calls}=fixture();for(const data of [null,[],{...report,subject:'forged'},{...report,email:'a@example.edu'},{...report,recipient:'a@example.edu'},{...report,expectedActor:'a'.repeat(64)},{...report,release:'forged'},{...report,attachment:'private'},{...report,name:'Name'},{...report,reportId:'bad'},{...report,description:'short'},{...report,description:'a'.repeat(4001)},{...report,description:'before\0after'}]) assert.equal((await handleBugReport(request(data),options)).status,400);
 assert.equal((await handleBugReport(new Request(origin+'/api/bug-reports',{method:'POST',headers,body:' '.repeat(17000)}),options)).status,400);assert.equal(calls.length,0);
});
test('only exact same-origin JSON POST reaches the email service',async()=>{
 const {options,calls}=fixture();for(const extra of [{origin:''},{origin:'null'},{origin:'https://foreign.test'},{'sec-fetch-site':'cross-site'},{referer:'https://foreign.test/private'}]) assert.equal((await handleBugReport(request(report,extra),options)).status,403);
 assert.equal((await handleBugReport(request(report,{'content-type':'text/plain'}),options)).status,400);assert.equal((await handleBugReport(new Request(origin+'/api/bug-reports'),options)).status,405);assert.equal((await handleBugReport(new Request(origin+'/api/bug-reports/session'),options)).status,404);
 assert.equal((await handleBugReport(new Request(origin+'/api/bug-reports?secret=x',{method:'POST',headers,body:JSON.stringify(report)}),options)).status,400);assert.equal(calls.length,0);
});
test('missing capability, release, trusted IP or limiter fails closed; ingress limits remain',async()=>{
 const {options,calls}=fixture();for(const change of [{service:undefined},{limiter:undefined},{release:undefined},{release:'bad release'}])assert.equal((await handleBugReport(request(),{...options,...change})).status,503);
 assert.equal((await handleBugReport(request(report,{'cf-connecting-ip':''}),options)).status,503);
 const response=await handleBugReport(request(),{...options,limiter:{limit:async()=>({success:false})}});assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'60');assert.equal(calls.length,0);
});
test('normalization preserves plain text without extra attachments',async()=>{
 const {options,calls}=fixture();assert.equal((await handleBugReport(request({...report,description:'  A button\r\n<img src=x>\tdid not work.  '}),options)).status,200);assert.equal(calls[0].description,'A button\n<img src=x> did not work.');
});
test('ambiguous or malformed acknowledgements never become success or automatic retries',async()=>{
 const {options}=fixture();for(const result of [null,{ok:true,status:'saved',reportId:report.reportId},{ok:true,status:'accepted',reportId:crypto.randomUUID()}]){
 let called=0;const service={submitPublic:async()=>{called++;return result;}} as BugReportService;const response=await handleBugReport(request(),{...options,service});assert.deepEqual(await response.json(),{ok:false,code:'delivery_unknown',retryable:false});assert.equal(called,1);}
 const response=await handleBugReport(request(),{...options,service:{submitPublic:async()=>{throw new Error('private details');}}});assert.deepEqual(await response.json(),{ok:false,code:'delivery_unknown',retryable:false});
});
test('failure receipts strip private fields and bound retry delays',async()=>{
 const {options}=fixture();const response=await handleBugReport(request(),{...options,service:{submitPublic:async()=>({ok:false,code:'rate_limited',retryable:true,retryAfterSeconds:60,private:'secret'})}});assert.equal(response.status,429);assert.deepEqual(await response.json(),{ok:false,code:'rate_limited',retryable:true,retryAfterSeconds:60});
 const unknown=await handleBugReport(request(),{...options,service:{submitPublic:async()=>({ok:false,code:'delivery_unknown',retryable:true})}});assert.deepEqual(await unknown.json(),{ok:false,code:'delivery_unknown',retryable:false});
});
test('cancelled requests do not start email submission',async()=>{
 const {options,calls}=fixture(),controller=new AbortController();controller.abort();await handleBugReport(new Request(request(),{signal:controller.signal}),options);assert.equal(calls.length,0);
});

test('cancellation during the daily digest does not dispatch an email',async()=>{
 const {options,calls}=fixture(),controller=new AbortController();
 const original=crypto.subtle.digest.bind(crypto.subtle);
 crypto.subtle.digest=async(algorithm,data)=>{const value=await original(algorithm,data);controller.abort();return value;};
 try {await handleBugReport(new Request(request(),{signal:controller.signal}),options);assert.equal(calls.length,0);}
 finally {crypto.subtle.digest=original;}
});
