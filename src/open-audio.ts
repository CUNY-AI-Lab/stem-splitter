import { inspectAudio } from './link-import.ts';
import { retryAt, setCooldown } from './reliability/retry.ts';

export type OpenAudioProvider = 'commons' | 'ccmixter';
export type OpenAudioSelection = { provider: OpenAudioProvider; itemId: string; fileId: string };
export const OPEN_AUDIO_MAX_BYTES = 12 * 1024 * 1024;
const AGENT = 'StemSplitter/0.1 (https://github.com/CUNY-AI-Lab/stem-splitter)';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const CCMIXTER_API = 'https://ccmixter.org/api/query';
const PROVIDER_NAMES = { commons: 'Wikimedia Commons', ccmixter: 'ccMixter' } as const;
const REDIRECTS = new Set([301,302,303,307,308]);
const MIME = { mp3: ['audio/mpeg','audio/mp3'], wav: ['audio/wav','audio/x-wav','audio/wave'], flac: ['audio/flac','audio/x-flac'] } as const;
type Format = keyof typeof MIME;
export class OpenAudioError extends Error {
  constructor(readonly code: string, readonly retryable = false, readonly retryAfterSeconds?: number) {
    super(code === 'license_unverified' ? 'This recording does not have a supported, verified recording license.'
      : code === 'source_rate_limited' ? 'This audio source is busy. Try again after its retry interval.'
      : code === 'unsupported_audio' ? 'Choose an available MP3, WAV or FLAC recording.'
      : 'The selected recording could not be imported. Try another recording or upload a licensed file.');
    this.name = 'OpenAudioError';
  }
}
interface Context { db: D1Database; maximumSeconds: number; signal?: AbortSignal; deadline?: number }
export interface OpenAudioTrack {
  id: string; openAudio: OpenAudioSelection; title: string; artist: string;
  durationSec: number; bytes: number; sourceUrl: string; providerName: string;
  licenseName: string; licenseUrl: string;
}
interface Recording extends OpenAudioTrack {
  downloadUrl: string; fileName: string; format: Format; recordingCredit: string;
  attributionText: string; rightsEvidence: Record<string,string>;
}
const limited = (maximum: number) => maximum === 900 ? 900 : 300;
const mediaType = (response: Response) => response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
const cancel = (response: Response) => { void response.body?.cancel().catch(() => {}); };
const text = (value: unknown, maximum = 4096): string => {
  if (typeof value !== 'string' || value.length > maximum) return '';
  return value.replace(/<[^>]*>/g,' ').replace(/&#(x[0-9a-f]+|[0-9]+);/gi,(_,n:string)=>{
    const number=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);
    return number>0&&number<=0x10ffff?String.fromCodePoint(number):' ';
  }).replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'")
    .replace(/&nbsp;/gi,' ').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim();
};
function credit(value: unknown) {
  if(typeof value!=='string'||value.length>8192)return '';
  const links=[...value.matchAll(/href=["']((?:https?:)?\/\/[^"']+)["']/gi)].map(match=>text(match[1]));
  return [text(value,8192),...new Set(links)].filter(Boolean).join(' · ');
}
export function parseOpenAudioSelection(value: unknown): OpenAudioSelection | null {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='fileId,itemId,provider')return null;
  const {provider,itemId,fileId}=value as Record<string,unknown>;
  if(typeof provider!=='string'||!['commons','ccmixter'].includes(provider)||typeof itemId!=='string'||!/^[1-9][0-9]{0,11}$/.test(itemId)||typeof fileId!=='string')return null;
  if(provider==='commons'?fileId!=='original':!/^[1-9][0-9]{0,11}$/.test(fileId))return null;
  return {provider:provider as OpenAudioProvider,itemId,fileId};
}
export function openRecordingLicense(value: unknown): {url:string;name:string;code:string}|null {
  if(typeof value!=='string'||value.length>300)return null;
  let url:URL;try{url=new URL(value);}catch{return null;}
  if(!['http:','https:'].includes(url.protocol)||!['creativecommons.org','www.creativecommons.org'].includes(url.hostname)||url.port||url.username||url.password||url.search||url.hash)return null;
  const by=/^\/licenses\/by\/(1\.0|2\.0|2\.5|3\.0|4\.0)\/?(?:deed\.[a-z_-]+)?$/i.exec(url.pathname);
  if(by)return {url:`https://creativecommons.org/licenses/by/${by[1]}/`,name:`CC BY ${by[1]}`,code:`cc-by-${by[1]}`};
  const pd=/^\/publicdomain\/(zero|mark)\/1\.0\/?(?:deed\.[a-z_-]+)?$/i.exec(url.pathname);
  return pd?{url:`https://creativecommons.org/publicdomain/${pd[1].toLowerCase()}/1.0/`,name:pd[1].toLowerCase()==='zero'?'CC0 1.0':'Public Domain Mark 1.0',code:pd[1].toLowerCase()==='zero'?'cc0':'pd'}:null;
}
function downloadUrl(value: unknown,provider:OpenAudioProvider):string|null {
  if(typeof value!=='string'||value.length>2048)return null;
  let url:URL;try{url=new URL(value);}catch{return null;}
  if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||/%(?:2f|5c|00)/i.test(url.pathname))return null;
  if(provider==='commons'){
    if(url.hostname!=='upload.wikimedia.org'||!/^\/wikipedia\/commons\/[0-9a-f]\/[0-9a-f]{2}\/[^/]+$/.test(url.pathname))return null;
    if([...url.searchParams.keys()].some(key=>!['utm_source','utm_campaign','utm_content'].includes(key)))return null;
    url.search='';
  }else if(url.hostname!=='ccmixter.org'||!/^\/content\/[a-z0-9_.-]+\/[^/]+$/i.test(url.pathname)||url.search)return null;
  try{if(decodeURIComponent(url.pathname).split('/').some(part=>part==='.'||part==='..'||part.includes('\\')))return null;}catch{return null;}
  return url.href;
}
function formatFor(fileName:string,mime:string):Format|null {
  if(typeof fileName!=='string'||typeof mime!=='string')return null;
  const extension=fileName.split('.').at(-1)?.toLowerCase() as Format;
  return extension in MIME && (MIME[extension] as readonly string[]).includes(mime.toLowerCase())?extension:null;
}
async function pause(ms:number,signal?:AbortSignal) {
  if(signal?.aborted)throw new OpenAudioError('source_cancelled');
  await new Promise<void>((resolve,reject)=>{
    const finish=()=>{signal?.removeEventListener('abort',abort);resolve();};
    const timer=setTimeout(finish,ms);
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new OpenAudioError('source_cancelled'));};
    signal?.addEventListener('abort',abort,{once:true});
  });
}
/** Shared D1 gate: at most one provider request/second across isolates. */
async function slot(provider:OpenAudioProvider,context:Context) {
  const key='open-audio:'+provider;
  for(let attempt=0;attempt<3;attempt++){
    const now=Date.now();
    const row=await context.db.prepare(`INSERT INTO provider_cooldowns(provider,until_ms) VALUES(?,?)
      ON CONFLICT(provider) DO UPDATE SET until_ms=excluded.until_ms WHERE until_ms<=? RETURNING until_ms`).bind(key,now+1000,now).first();
    if(row)return;
    const pending=await context.db.prepare('SELECT until_ms FROM provider_cooldowns WHERE provider=?').bind(key).first<{until_ms:number}>();
    const wait=Math.max(1,(pending?.until_ms??now+1000)-now);
    if(wait>5000||Date.now()+wait>=(context.deadline??Infinity))throw new OpenAudioError('source_rate_limited',true,Math.ceil(wait/1000));
    await pause(wait+5,context.signal);
  }
  throw new OpenAudioError('source_rate_limited',true,1);
}
async function read(response:Response,maximum:number,deadline:number):Promise<ArrayBuffer> {
  const length=response.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length))||Number(length)>maximum)) {cancel(response);throw new OpenAudioError('source_too_large');}
  if(!response.body)throw new OpenAudioError('invalid_audio_response');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0,timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new OpenAudioError('source_timeout',true)),Math.max(1,deadline-Date.now()));});
  try{for(;;){const part=await Promise.race([reader.read(),timeout]);if(part.done)break;size+=part.value.byteLength;if(size>maximum)throw new OpenAudioError('source_too_large');chunks.push(part.value);}}
  finally{if(timer!==undefined)clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
  const out=new Uint8Array(size);let at=0;for(const chunk of chunks){out.set(chunk,at);at+=chunk.byteLength;}return out.buffer;
}
async function request(provider:OpenAudioProvider,url:string,context:Context,maximum:number,audio=false):Promise<{data:ArrayBuffer;mime:string}> {
  const deadline=Math.min(context.deadline??Infinity,Date.now()+(audio?60000:15000));
  const controller=new AbortController(),abort=()=>controller.abort();context.signal?.addEventListener('abort',abort,{once:true});
  if(context.signal?.aborted)controller.abort();
  const timer=setTimeout(abort,Math.max(1,deadline-Date.now()));let target=url;
  try{
    for(let hop=0,retries=0;;){
      if(controller.signal.aborted||Date.now()>=deadline)throw new OpenAudioError('source_timeout',true);
      await slot(provider,{...context,signal:controller.signal,deadline});
      const response=await fetch(target,{redirect:'manual',headers:{'User-Agent':AGENT,Accept:audio?'audio/mpeg,audio/wav,audio/flac':'application/json'},signal:controller.signal});
      if(REDIRECTS.has(response.status)){
        const location=response.headers.get('location');cancel(response);
        let next:string|null=null;try{next=downloadUrl(new URL(location??'',target).href,provider);}catch{}
        // Never change recording/host based on a redirect or follow API redirects.
        if(!audio||++hop>3||!location||next!==url)throw new OpenAudioError('source_redirect_refused');
        target=next;continue;
      }
      if(response.status===429||response.status===503){
        const until=retryAt(response.headers.get('retry-after'));cancel(response);await setCooldown(context.db,'open-audio:'+provider,until);
        if(retries++<1&&until-Date.now()<=5000&&until<deadline){await pause(Math.max(0,until-Date.now()),controller.signal);continue;}
        throw new OpenAudioError('source_rate_limited',true,Math.max(1,Math.ceil((until-Date.now())/1000)));
      }
      if(!response.ok){cancel(response);throw new OpenAudioError(response.status===403?'source_access_refused':'source_unavailable',response.status>=500);}
      const mime=mediaType(response);
      if(audio?!Object.values(MIME).some(values=>(values as readonly string[]).includes(mime)):!['application/json','text/plain'].includes(mime)) {cancel(response);throw new OpenAudioError(audio?'unsupported_audio':'metadata_invalid');}
      return {data:await read(response,maximum,deadline),mime};
    }
  }catch(error){if(error instanceof OpenAudioError)throw error;throw new OpenAudioError(controller.signal.aborted?'source_timeout':'source_unavailable',true);}
  finally{clearTimeout(timer);context.signal?.removeEventListener('abort',abort);}
}
async function json(provider:OpenAudioProvider,parameters:Record<string,string>,context:Context):Promise<any> {
  const url=new URL(provider==='commons'?COMMONS_API:CCMIXTER_API);for(const [key,value]of Object.entries(parameters))url.searchParams.set(key,value);
  const result=await request(provider,url.href,context,1024*1024);
  try{const data=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(result.data));if(data?.error)throw new OpenAudioError('source_unavailable',true);return data;}
  catch(error){if(error instanceof OpenAudioError)throw error;throw new OpenAudioError('metadata_invalid');}
}
function record(provider:OpenAudioProvider,selection:OpenAudioSelection,title:string,creator:string,sourceUrl:string,fileName:string,download:string,mime:string,bytes:number,durationSec:number,license:NonNullable<ReturnType<typeof openRecordingLicense>>,recordingCredit:string,evidence:Record<string,string>,context:Context):Recording|null {
  const format=formatFor(fileName,mime),url=downloadUrl(download,provider);
  if(!format||!url||!title||!creator||/^(unknown|unknown artist|various artists)$/i.test(creator)||!recordingCredit||!Number.isSafeInteger(bytes)||bytes<1024||bytes>OPEN_AUDIO_MAX_BYTES||!Number.isFinite(durationSec)||durationSec<=0||durationSec>limited(context.maximumSeconds))return null;
  return {id:`${provider}:${selection.itemId}:${selection.fileId}`,openAudio:selection,title,artist:creator,durationSec,bytes,sourceUrl,providerName:PROVIDER_NAMES[provider],licenseName:license.name,licenseUrl:license.url,
    fileName,downloadUrl:url,format,recordingCredit,attributionText:`${title} — ${creator}. ${license.name}: ${license.url} Source: ${sourceUrl}. Recording credit: ${recordingCredit}`,rightsEvidence:evidence};
}
const COMMONS_PROPS={action:'query',format:'json',formatversion:'2',prop:'imageinfo',iiprop:'url|size|mime|mediatype|extmetadata',maxlag:'5'};
function commons(page:any,context:Context):Recording|null {
  const info=page?.imageinfo?.[0],e=info?.extmetadata,value=(key:string)=>e?.[key]?.value;
  const license=openRecordingLicense(value('LicenseUrl'));
  if(page?.ns!==6||!Number.isSafeInteger(page.pageid)||!info||info.mediatype!=='AUDIO'||!license||text(value('Restrictions'))||text(value('License')).toLowerCase()!==license.code)return null;
  if(license.code==='pd'&&String(value('Copyrighted')).toLowerCase()!=='false')return null;
  const source=String(info.descriptionurl??'');if(!source.startsWith('https://commons.wikimedia.org/wiki/File:'))return null;
  let parsed:URL;try{parsed=new URL(source);}catch{return null;}if(parsed.origin!=='https://commons.wikimedia.org'||parsed.username||parsed.password||parsed.search||parsed.hash)return null;
  const title=text(value('ObjectName'))||text(page.title?.replace(/^File:/,'')),creator=text(value('Artist'));
  const recordingCredit=credit(value('Attribution'))||credit(value('Artist'));
  return record('commons',{provider:'commons',itemId:String(page.pageid),fileId:'original'},title,creator,source,text(page.title?.replace(/^File:/,'')),info.url,info.mime,info.size,info.duration,license,recordingCredit,
    {licenseUrl:String(value('LicenseUrl')),licenseCode:String(value('License')),creator:credit(value('Artist')),credit:recordingCredit,recordingPage:source},context);
}
function ccmixter(row:any,context:Context):Recording[] {
  const license=openRecordingLicense(row?.license_url),tags=typeof row?.upload_tags==='string'?row.upload_tags.split(',').map((tag:string)=>tag.trim().toLowerCase()):[];
  if(!license||!tags.includes('original')||tags.includes('remix')||/\bremix\b/i.test(row.upload_name??'')||!/^Attribution(?: \([0-9.]+\))?$/i.test(row.license_name??'')||!Number.isSafeInteger(row.upload_id)||!Array.isArray(row.files))return [];
  const source=String(row.file_page_url??'');if(!/^https:\/\/ccmixter\.org\/files\/[a-z0-9_.-]+\/[1-9][0-9]*$/i.test(source)||!source.endsWith('/'+row.upload_id))return [];
  const title=text(row.upload_name),creator=text(row.user_real_name)||text(row.user_name),description=text(row.upload_description_plain,8192);
  if(typeof row.upload_description_plain==='string'&&row.upload_description_plain.length>8192)return [];
  const recordingCredit=[creator,text(row.upload_extra?.featuring),description].filter(Boolean).join(' · ');
  return row.files.slice(0,8).flatMap((file:any)=>{
    const info=file.file_format_info,seconds=typeof info?.ps==='string'&&/^(?:[0-9]+:)?[0-5]?[0-9]:[0-5][0-9]$/.test(info.ps)?info.ps.split(':').reduce((n:number,p:string)=>n*60+Number(p),0):NaN;
    if(!Number.isSafeInteger(file.file_id)||file.file_is_remote!==0||info?.['media-type']!=='audio'||typeof file.file_name!=='string'||file.file_name.includes('/')||file.file_name.includes('\\'))return [];
    const track=record('ccmixter',{provider:'ccmixter',itemId:String(row.upload_id),fileId:String(file.file_id)},title,creator,source,file.file_name,file.download_url,info.mime_type,Number(file.file_rawsize),seconds,license,recordingCredit,
      {licenseUrl:row.license_url,licenseName:row.license_name,creator,credit:recordingCredit,recordingPage:source},context);
    return track?[track]:[];
  });
}
async function records(provider:OpenAudioProvider,parameters:Record<string,string>,context:Context):Promise<Recording[]> {
  const data=await json(provider,parameters,context);
  if(provider==='commons')return Array.isArray(data?.query?.pages)?data.query.pages.slice(0,8).flatMap((page:any)=>{const item=commons(page,context);return item?[item]:[];}):[];
  return Array.isArray(data)?data.slice(0,8).flatMap(row=>ccmixter(row,context)):[];
}
export async function searchOpenAudio(provider:OpenAudioProvider,query:string,context:Context):Promise<{results:OpenAudioTrack[]}> {
  const term=query.trim();if(term.length<2||term.length>120)throw new OpenAudioError('invalid_query');
  const matches=await records(provider,provider==='commons'?{...COMMONS_PROPS,generator:'search',gsrnamespace:'6',gsrsearch:`${term} filetype:audio intitle:mp3`,gsrlimit:'6'}:{f:'json',lic:'by',reqtags:'original',search:term,search_type:'all',limit:'6'},context);
  return {results:matches.slice(0,8).map(({downloadUrl,fileName,format,recordingCredit,attributionText,rightsEvidence,...track})=>track)};
}
export async function fetchOpenAudio(selection:OpenAudioSelection,context:Context) {
  if(!parseOpenAudioSelection(selection))throw new OpenAudioError('invalid_selection');
  context={...context,deadline:Math.min(context.deadline??Infinity,Date.now()+90000)};
  const items=await records(selection.provider,selection.provider==='commons'?{...COMMONS_PROPS,pageids:selection.itemId}:{f:'json',ids:selection.itemId,limit:'1'},context);
  const track=items.find(item=>item.openAudio.itemId===selection.itemId&&item.openAudio.fileId===selection.fileId);
  if(!track)throw new OpenAudioError('license_unverified');
  const {data,mime}=await request(selection.provider,track.downloadUrl,context,OPEN_AUDIO_MAX_BYTES,true);
  if(data.byteLength!==track.bytes)throw new OpenAudioError('source_changed');
  let inspected:ReturnType<typeof inspectAudio>;try{inspected=inspectAudio(new Uint8Array(data));}catch{throw new OpenAudioError('unsupported_audio');}
  if(inspected.format!==track.format||!(MIME[track.format] as readonly string[]).includes(mime)||inspected.durationSec>limited(context.maximumSeconds)||Math.abs(inspected.durationSec-track.durationSec)>Math.max(2,track.durationSec*.02))throw new OpenAudioError('unsupported_audio');
  return {data,title:track.title,fileName:track.fileName,contentType:MIME[track.format][0],durationSec:inspected.durationSec,
    attribution:{provider:selection.provider,providerName:track.providerName,itemId:selection.itemId,fileId:selection.fileId,title:track.title,creator:track.artist,sourceUrl:track.sourceUrl,licenseUrl:track.licenseUrl,licenseName:track.licenseName,fileName:track.fileName,
      recordingCredit:track.recordingCredit,attributionText:track.attributionText,rightsEvidence:track.rightsEvidence,verifiedAt:new Date().toISOString()}};
}
