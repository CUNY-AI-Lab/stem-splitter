import { inspectAudio } from './link-import.ts';
import { retryAt, setCooldown } from './reliability/retry.ts';

export type OpenAudioProvider = 'commons' | 'ccmixter' | 'freesound' | 'loc';
export type OpenAudioSelection = { provider: OpenAudioProvider; itemId: string; fileId: string };
export const OPEN_AUDIO_MAX_BYTES = 12 * 1024 * 1024;
const AGENT = 'StemSplitter/0.1 (https://github.com/CUNY-AI-Lab/stem-splitter)';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const CCMIXTER_API = 'https://ccmixter.org/api/query';
const PROVIDER_NAMES = { commons: 'Wikimedia Commons', ccmixter: 'ccMixter', freesound: 'Freesound', loc: 'Library of Congress' } as const;
const OPENVERSE_API = 'https://api.openverse.org/v1/audio/';
const LOC_MANIFEST = 'https://data.labs.loc.gov/jukebox/manifest.json';
const LOC_RIGHTS = 'https://data.labs.loc.gov/jukebox/README.html#rights-statement';
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
interface Context { db: D1Database; maximumSeconds: number; signal?: AbortSignal; deadline?: number; cache?: { origin: string; storage: Pick<Cache, 'match' | 'put'> } }
export interface OpenAudioTrack {
  id: string; openAudio: OpenAudioSelection; title: string; artist: string;
  durationSec: number; bytes: number; sourceUrl: string; providerName: string;
  licenseName: string; licenseUrl: string; fileDescription?: string;
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
  if(typeof provider!=='string'||!['commons','ccmixter','freesound','loc'].includes(provider)||typeof itemId!=='string'||typeof fileId!=='string')return null;
  if(provider==='freesound') {
    if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(itemId)||!/^[1-9][0-9]{0,11}$/.test(fileId))return null;
  } else {
    if(!/^[1-9][0-9]{0,11}$/.test(itemId))return null;
    if(provider==='commons'?fileId!=='original':provider==='loc'?fileId!=='1':!/^[1-9][0-9]{0,11}$/.test(fileId))return null;
  }
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
  }else if(provider==='freesound') {
    if(url.hostname!=='cdn.freesound.org'||!/^\/previews\/[0-9]+\/[1-9][0-9]*_[1-9][0-9]*-hq\.mp3$/.test(url.pathname)||url.search)return null;
  }else if(provider==='loc') {
    if(url.hostname!=='data.labs.loc.gov'||!/^\/jukebox\/audio\/jukebox-[1-9][0-9]*_1\.mp3$/.test(url.pathname)||url.search)return null;
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
async function slot(provider:string,context:Context,spacing=1000) {
  const key='open-audio:'+provider;
  for(let attempt=0;attempt<3;attempt++){
    const now=Date.now();
    const row=await context.db.prepare(`INSERT INTO provider_cooldowns(provider,until_ms) VALUES(?,?)
      ON CONFLICT(provider) DO UPDATE SET until_ms=excluded.until_ms WHERE until_ms<=? RETURNING until_ms`).bind(key,now+spacing,now).first();
    if(row)return;
    const pending=await context.db.prepare('SELECT until_ms FROM provider_cooldowns WHERE provider=?').bind(key).first<{until_ms:number}>();
    const wait=Math.max(1,(pending?.until_ms??now+1000)-now);
    if(wait>5000||Date.now()+wait>=(context.deadline??Infinity))throw new OpenAudioError('source_rate_limited',true,Math.ceil(wait/1000));
    await pause(wait+5,context.signal);
  }
  throw new OpenAudioError('source_rate_limited',true,1);
}
async function openverseLease(context: Context): Promise<number> {
  const until = Math.min(context.deadline ?? Infinity, Date.now() + 5000);
  while (Date.now() < until) {
    if (context.signal?.aborted) throw new OpenAudioError('source_cancelled');
    const now = Date.now(), lease = now + 90000;
    const row = await context.db.prepare(`INSERT INTO provider_cooldowns(provider,until_ms) VALUES(?,?)
      ON CONFLICT(provider) DO UPDATE SET until_ms=excluded.until_ms WHERE until_ms<=? RETURNING until_ms`)
      .bind('open-audio:openverse', lease, now).first();
    if (row) return lease;
    const pending = await context.db.prepare('SELECT until_ms FROM provider_cooldowns WHERE provider=?').bind('open-audio:openverse').first<{until_ms:number}>();
    const remaining = Math.max(1, (pending?.until_ms ?? now + 3100) - Date.now());
    if (remaining > 90000) throw new OpenAudioError('source_rate_limited', true, Math.ceil(remaining / 1000));
    await pause(Math.min(250, remaining), context.signal);
  }
  throw new OpenAudioError('source_rate_limited', true, 5);
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
async function request(provider:OpenAudioProvider,url:string,context:Context,maximum:number,audio=false,html=false):Promise<{data:ArrayBuffer;mime:string}> {
  const deadline=Math.min(context.deadline??Infinity,Date.now()+(audio?60000:15000));
  const controller=new AbortController(),abort=()=>controller.abort();context.signal?.addEventListener('abort',abort,{once:true});
  if(context.signal?.aborted)controller.abort();
  const timer=setTimeout(abort,Math.max(1,deadline-Date.now()));let target=url;
  try{
    for(let hop=0,retries=0;;){
      if(controller.signal.aborted||Date.now()>=deadline)throw new OpenAudioError('source_timeout',true);
      const gate = new URL(url).hostname === 'api.openverse.org' ? 'openverse' : provider;
      const lease = gate==='openverse' ? await openverseLease({...context,signal:controller.signal,deadline}) : 0;
      if(!lease)await slot(gate,{...context,signal:controller.signal,deadline});
      let notBefore = 0;
      try {
      if(controller.signal.aborted)throw new OpenAudioError('source_cancelled');
      const response=await fetch(target,{redirect:'manual',headers:{'User-Agent':AGENT,Accept:audio?'audio/mpeg,audio/wav,audio/flac':html?'text/html':'application/json'},signal:controller.signal});
      if(REDIRECTS.has(response.status)){
        const location=response.headers.get('location');cancel(response);
        let next:string|null=null;try{next=downloadUrl(new URL(location??'',target).href,provider);}catch{}
        // Never change recording/host based on a redirect or follow API redirects.
        if(!audio||++hop>3||!location||next!==url)throw new OpenAudioError('source_redirect_refused');
        target=next;continue;
      }
      if(response.status===429||response.status===503){
        const until=retryAt(response.headers.get('retry-after'));cancel(response);notBefore=until;
        if(!lease)await setCooldown(context.db,'open-audio:'+gate,until);
        if(retries++<1&&until-Date.now()<=5000&&until<deadline){await pause(Math.max(0,until-Date.now()),controller.signal);continue;}
        throw new OpenAudioError('source_rate_limited',true,Math.max(1,Math.ceil((until-Date.now())/1000)));
      }
      if(!response.ok){cancel(response);throw new OpenAudioError(response.status===403?'source_access_refused':'source_unavailable',response.status>=500);}
      let mime=mediaType(response);
      // LC Labs publishes both its JSON manifest and MP3s as binary/octet-stream.
      // Only these pinned dataset URLs get this exception; audio is still inspected below.
      const datasetBinary=provider==='loc'&&(url===LOC_MANIFEST||Boolean(downloadUrl(url,'loc')))&&['application/octet-stream','binary/octet-stream'].includes(mime);
      if(!datasetBinary&&(audio?!Object.values(MIME).some(values=>(values as readonly string[]).includes(mime)):html?mime!=='text/html':!['application/json','text/plain'].includes(mime))) {cancel(response);throw new OpenAudioError(audio?'unsupported_audio':'metadata_invalid');}
      if(datasetBinary&&audio)mime='audio/mpeg';
      return {data:await read(response,maximum,deadline),mime};
      } finally {
        if(lease)await context.db.prepare('UPDATE provider_cooldowns SET until_ms=? WHERE provider=? AND until_ms=?')
          .bind(Math.max(Date.now()+3100,notBefore),'open-audio:openverse',lease).run();
      }
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
  const matches=provider==='freesound'?await searchFreesound(term,context):provider==='loc'?await searchLoc(term,context):await records(provider,provider==='commons'?{...COMMONS_PROPS,generator:'search',gsrnamespace:'6',gsrsearch:`${term} filetype:audio intitle:mp3`,gsrlimit:'6'}:{f:'json',lic:'by',reqtags:'original',search:term,search_type:'all',limit:'6'},context);
  return {results:matches.slice(0,8).map(({downloadUrl,fileName,format,recordingCredit,attributionText,rightsEvidence,...track})=>track)};
}
/** A catalog URL is only a lookup hint; Commons must verify the actual file. */
export async function resolveCommonsRecordingPage(sourceUrl:string,context:Context):Promise<{results:OpenAudioTrack[]}> {
  let url:URL;try{url=new URL(sourceUrl);}catch{return {results:[]};}
  if(url.origin!=='https://commons.wikimedia.org'||url.username||url.password||url.search||url.hash||!url.pathname.startsWith('/wiki/File:'))return {results:[]};
  let title:string;try{title=decodeURIComponent(url.pathname.slice('/wiki/'.length));}catch{return {results:[]};}
  if(title.length>300||/[|\x00-\x1f\x7f]/.test(title))return {results:[]};
  const matches=await records('commons',{...COMMONS_PROPS,titles:title},context);
  return {results:matches.filter(track=>{try{return decodeURIComponent(new URL(track.sourceUrl).pathname).replaceAll('_',' ')===decodeURIComponent(url.pathname).replaceAll('_',' ');}catch{return false;}})
    .map(({downloadUrl,fileName,format,recordingCredit,attributionText,rightsEvidence,...track})=>track)};
}
export async function fetchOpenAudio(selection:OpenAudioSelection,context:Context) {
  if(!parseOpenAudioSelection(selection))throw new OpenAudioError('invalid_selection');
  context={...context,deadline:Math.min(context.deadline??Infinity,Date.now()+90000)};
  const items=selection.provider==='freesound'?[await freshFreesound(selection,context)]:selection.provider==='loc'?[await locRecording(selection.itemId,await locManifest(context,true),context)]:await records(selection.provider,selection.provider==='commons'?{...COMMONS_PROPS,pageids:selection.itemId}:{f:'json',ids:selection.itemId,limit:'1'},context);
  const track=items.find(item=>item&&item.openAudio.itemId===selection.itemId&&item.openAudio.fileId===selection.fileId);
  if(!track)throw new OpenAudioError('license_unverified');
  const {data,mime}=await request(selection.provider,track.downloadUrl,context,OPEN_AUDIO_MAX_BYTES,true);
  if(data.byteLength!==track.bytes)throw new OpenAudioError('source_changed');
  let inspected:ReturnType<typeof inspectAudio>;try{inspected=inspectAudio(new Uint8Array(data));}catch{throw new OpenAudioError('unsupported_audio');}
  if(inspected.format!==track.format||!(MIME[track.format] as readonly string[]).includes(mime)||inspected.durationSec>limited(context.maximumSeconds)||Math.abs(inspected.durationSec-track.durationSec)>Math.max(2,track.durationSec*.02))throw new OpenAudioError('unsupported_audio');
  return {data,title:track.title,fileName:track.fileName,contentType:MIME[track.format][0],durationSec:inspected.durationSec,
    attribution:{provider:selection.provider,providerName:track.providerName,itemId:selection.itemId,fileId:selection.fileId,title:track.title,creator:track.artist,sourceUrl:track.sourceUrl,licenseUrl:track.licenseUrl,licenseName:track.licenseName,fileName:track.fileName,
      recordingCredit:track.recordingCredit,attributionText:track.attributionText,rightsEvidence:track.rightsEvidence,...(track.fileDescription?{fileDescription:track.fileDescription}:{}),verifiedAt:new Date().toISOString()}};
}

async function catalogJson(provider: OpenAudioProvider, url: string, context: Context, maximum = 1024 * 1024): Promise<any> {
  const { data } = await request(provider, url, context, maximum);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data)); }
  catch { throw new OpenAudioError('metadata_invalid'); }
}

/** Openverse is an index. Only Freesound's exact, licensed MP3 rendition is eligible. */
function freesound(row: any, context: Context): Recording | null {
  const source = typeof row?.foreign_landing_url === 'string' ? row.foreign_landing_url : '';
  const page = /^https:\/\/freesound\.org\/people\/([a-z0-9_.-]+)\/sounds\/([1-9][0-9]*)\/?$/i.exec(source);
  const license = openRecordingLicense(row?.license_url);
  const selection = parseOpenAudioSelection({ provider: 'freesound', itemId: row?.id, fileId: page?.[2] });
  const audio = typeof row?.url === 'string' && /^https:\/\/cdn\.freesound\.org\/previews\/([0-9]+)\/([1-9][0-9]*)_([1-9][0-9]*)-hq\.mp3$/.exec(row.url);
  if (!page || !selection || !audio || audio[2] !== page[2] || Number(audio[1]) !== Math.floor(Number(page[2]) / 1000)
    || row.source !== 'freesound' || row.provider !== 'freesound' || row.filetype !== 'mp3' || !license
    || row.creator !== page[1] || !['by', 'cc0', 'pdm'].includes(row.license)
    || (row.license === 'by' ? license.code !== `cc-by-${row.license_version}` : license.code !== (row.license === 'cc0' ? 'cc0' : 'pd'))) return null;
  const creator = text(row.creator), title = text(row.title);
  const track = record('freesound', selection, title, creator, source.replace(/\/?$/, '/'), `${page[2]}-hq.mp3`, row.url,
    'audio/mpeg', row.filesize, Number(row.duration) / 1000, license, `${creator}; Freesound MP3 preview`,
    { licenseUrl: license.url, creator, recordingPage: source, catalogUrl: OPENVERSE_API + selection.itemId + '/', rendition: 'MP3 preview' }, context);
  if (track) track.fileDescription = 'MP3 preview';
  return track;
}

async function searchFreesound(query: string, context: Context): Promise<Recording[]> {
  const url = new URL(OPENVERSE_API);
  for (const [key, value] of Object.entries({ q: query, source: 'freesound', license: 'by,cc0,pdm', extension: 'mp3', page_size: '8' })) url.searchParams.set(key, value);
  const data = await catalogJson('freesound', url.href, context);
  if (!Array.isArray(data?.results)) throw new OpenAudioError('metadata_invalid');
  return data.results.slice(0, 8).flatMap((row: any) => { const track = freesound(row, context); return track ? [track] : []; });
}

function attribute(tag: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name}=["']([^"']*)["']`, 'i').exec(tag);
  return match ? text(match[1], 8192) : '';
}

async function freshFreesound(selection: OpenAudioSelection, context: Context): Promise<Recording | null> {
  const row = await catalogJson('freesound', OPENVERSE_API + selection.itemId + '/', context);
  const track = freesound(row, context);
  if (!track || track.openAudio.itemId !== selection.itemId || track.openAudio.fileId !== selection.fileId) return null;
  // Recheck the original source, not just potentially stale index metadata. Never
  // use the authenticated original-download endpoint or substitute another file.
  const { data } = await request('freesound', track.sourceUrl, context, 1024 * 1024, false, true);
  const html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data);
  const meta = new Map([...html.matchAll(/<meta\b[^>]*>/gi)].map(match => [attribute(match[0], 'property'), attribute(match[0], 'content')]));
  const licenses = [...html.matchAll(/<a\b[^>]*>/gi)].filter(match => attribute(match[0], 'title') === 'Go to the full license text')
    .map(match => openRecordingLicense(attribute(match[0], 'href')));
  const sharedFiles = [...html.matchAll(/<div\b[^>]*>/gi)].filter(match => attribute(match[0], 'id') === 'share-link')
    .map(match => attribute(match[0], 'data-static-file-url'));
  if (meta.get('og:url') !== track.sourceUrl || meta.get('og:audio:artist') !== track.artist || meta.get('og:audio:title') !== track.title
    || licenses.length !== 1 || licenses[0]?.url !== track.licenseUrl || sharedFiles.length !== 1 || sharedFiles[0] !== track.downloadUrl) return null;
  track.rightsEvidence.sourceLicenseUrl = licenses[0].url;
  track.rightsEvidence.sourceRenditionUrl = sharedFiles[0];
  return track;
}

type LocFile = { id: string; filename: string; bytes: number; url: string; md5: string };
async function locManifest(context: Context, fresh = false): Promise<Map<string, LocFile>> {
  const storage = context.cache?.storage ?? (typeof caches !== 'undefined' && 'default' in caches ? caches.default : undefined);
  const key = new Request(LOC_MANIFEST);
  let data: any;
  if (storage && !fresh) { try { const hit = await storage.match(key); if (hit?.ok) data = await hit.json(); } catch {} }
  if (!data) {
    data = await catalogJson('loc', LOC_MANIFEST, context, 1536 * 1024);
    if (storage && !context.signal?.aborted) { try { await storage.put(key, Response.json(data, { headers: { 'Cache-Control': 'public, max-age=3600' } })); } catch {} }
  }
  if (data?.cols?.join(',') !== 'filename,item_id,md5,size,object_key' || !Array.isArray(data.rows) || data.rows.length > 10000) throw new OpenAudioError('metadata_invalid');
  const files = new Map<string, LocFile>();
  for (const row of data.rows) {
    if (!Array.isArray(row) || row.length !== 5) continue;
    const id = /^https?:\/\/www\.loc\.gov\/item\/jukebox-([1-9][0-9]*)\/$/.exec(row[1])?.[1];
    if (!id || row[0] !== `jukebox-${id}_1.mp3` || row[4] !== `data.labs.loc.gov/jukebox/audio/${row[0]}`
      || !/^[a-f0-9]{32}$/.test(row[2]) || !Number.isSafeInteger(row[3]) || row[3] < 1024 || row[3] > OPEN_AUDIO_MAX_BYTES) continue;
    files.set(id, { id, filename: row[0], bytes: row[3], url: 'https://' + row[4], md5: row[2] });
  }
  return files;
}

async function locRecording(id: string, manifest: Map<string, LocFile>, context: Context): Promise<Recording | null> {
  const file = manifest.get(id); if (!file) return null;
  const source = `https://www.loc.gov/item/jukebox-${id}/`;
  const data = await catalogJson('loc', source + '?fo=json&at=item,resources', context);
  const item = data?.item, year = typeof item?.date === 'string' && /^(19[01][0-9]|192[0-2])(?:-[0-9]{2}){0,2}$/.test(item.date);
  const rights = Array.isArray(item?.rights) ? item.rights.map((value: unknown) => text(value, 16384)).join(' ') : '';
  if (!year || item?.access_restricted !== false || item?.profile !== 'jukebox'
    || ![source, source.replace('https:', 'http:')].includes(item?.id)
    || !String(item?.item?.recording_repository ?? '').includes('Recorded Sound Section, Library of Congress')
    || !item?.location?.includes('united states') || !/recordings published prior to 1923.*public domain/i.test(rights)) return null;
  const media = (data.resources ?? []).flatMap((resource: any) => Array.isArray(resource.files) ? resource.files.flat() : [])
    .find((entry: any) => entry?.mediaType === 'A' && entry?.canDownload === true && Number.isFinite(entry.duration));
  if (!media) return null;
  const credits: string[] = (Array.isArray(item.contributor_names) ? item.contributor_names : []).map((value: unknown) => text(value)).filter(Boolean);
  const names = [...new Set(credits.map(value => value.split(' -- ')[0]))];
  const primary: string[] = Array.isArray(item.contributor_primary) ? item.contributor_primary.map((value: unknown) => text(value).toLowerCase()) : [];
  const performers = names.filter(name => primary.includes(name.toLowerCase()));
  const creator = (performers.length ? performers : names).join(' · ');
  // Dataset membership, not composition age or a generic collection flag, is the
  // rights evidence. LC Labs explicitly publishes this pre-1923 subset as public domain.
  return record('loc', { provider: 'loc', itemId: id, fileId: '1' }, text(item.title), creator, source, file.filename, file.url,
    'audio/mpeg', file.bytes, media.duration, { url: LOC_RIGHTS, name: 'Public domain (United States)', code: 'loc-pd-us' },
    `${credits.join(' · ')}. Library of Congress, National Jukebox.`,
    { recordingPage: source, recordingDate: item.date, dataset: 'https://data.labs.loc.gov/jukebox/', manifest: LOC_MANIFEST,
      manifestMd5: file.md5, rightsStatement: LOC_RIGHTS, rightsScope: 'United States; pre-1923 recording in the published LC Labs dataset' }, context);
}

async function searchLoc(query: string, context: Context): Promise<Recording[]> {
  context = { ...context, deadline: Math.min(context.deadline ?? Infinity, Date.now() + 25000) };
  const url = new URL('https://www.loc.gov/collections/national-jukebox/');
  for (const [key, value] of Object.entries({ fo: 'json', q: query, c: '6', at: 'results', dates: '1900/1922',
    fa: 'partof_repository:recorded sound section, library of congress|location:united states' })) url.searchParams.set(key, value);
  const [data, manifest] = await Promise.all([catalogJson('loc', url.href, context), locManifest(context)]);
  if (!Array.isArray(data?.results)) throw new OpenAudioError('metadata_invalid');
  const ids = [...new Set<string>(data.results.map((row: any) => /^https?:\/\/www\.loc\.gov\/item\/jukebox-([1-9][0-9]*)\/$/.exec(row?.id)?.[1])
    .filter((id: string | undefined) => id && manifest.has(id)))].slice(0, 4);
  const results: Recording[] = [];
  for (const id of ids) {
    if (context.signal?.aborted) throw new OpenAudioError('source_cancelled');
    try { const track = await locRecording(id, manifest, context); if (track) results.push(track); }
    catch (error) { if (!results.length) throw error; break; }
  }
  return results;
}
