import catalog from '../public/search-samples.json' with { type: 'json' };
import { verifyArchiveSample } from './archive.ts';
import type { Env } from './env';

export type SampleTrack = { artist: string; title: string; archiveId: string; archiveFile: string; durationSec?: number; verifiedAt?: string; genre?: string; importTestedAt?: string; importBytes?: number; exampleEligible?: boolean; itemTitle?: string };
export type SampleSettings = { enabled: boolean; holdMs: number; cadenceMs: number; reshuffle: boolean; tracks: SampleTrack[] };
export type SampleResource = { revision: number; settings: SampleSettings; updatedBy: string | null; updatedAt: string | null };
export const sampleTrackKey = (track: SampleTrack) => `${track.archiveId}/${track.archiveFile}`;
// Six complete, verified recordings spanning the requested musical styles.
const initialGenres=['jazz','electronic','country','funk','rock','folk'];
export const defaultSampleSettings = (): SampleSettings => ({enabled:true,holdMs:3500,cadenceMs:6000,reshuffle:true,
  tracks:initialGenres.map(genre=>catalog.find(track=>track.genre===genre)!).filter(Boolean),
});

export class SampleResourceError extends Error { status:400|409|502; constructor(message:string,status:400|409|502){super(message);this.status=status;} }
export function parseSampleSettings(value: unknown): SampleSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SampleResourceError('Invalid song settings.',400);
  const v=value as Record<string,unknown>;
  if (typeof v.enabled!=='boolean' || typeof v.reshuffle!=='boolean' || !Number.isInteger(v.holdMs) || !Number.isInteger(v.cadenceMs) ||
      (v.holdMs as number)<3000 || (v.holdMs as number)>15000 || (v.cadenceMs as number)<(v.holdMs as number)+600 || (v.cadenceMs as number)>30000 ||
      !Array.isArray(v.tracks) || v.tracks.length>64 || (v.enabled && !v.tracks.length)) throw new SampleResourceError('Choose up to 64 songs, a hold of at least 3 seconds, and a cadence at least 0.6 seconds longer than the hold.',400);
  const tracks=v.tracks.map(raw=>{
    if (!raw || typeof raw!=='object' || Array.isArray(raw)) throw new SampleResourceError('Invalid song.',400);
    const t=raw as Record<string,unknown>;
    for (const k of ['artist','title','archiveId','archiveFile']) if(typeof t[k]!=='string' || !(t[k] as string).trim() || (t[k] as string).length>(k==='archiveFile'?512:180) || /[\u0000-\u001f\u007f]/.test(t[k] as string)) throw new SampleResourceError('Each song needs an artist, title and exact Archive file.',400);
    if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(t.archiveId as string) || !(t.archiveFile as string).toLowerCase().endsWith('.mp3')) throw new SampleResourceError('Choose a public Archive MP3.',400);
    if(t.genre!==undefined && !['jazz','electronic','country','funk','rock','folk','other'].includes(t.genre as string))throw new SampleResourceError('Choose a valid musical style.',400);
    return {artist:(t.artist as string).trim(),title:(t.title as string).trim(),archiveId:t.archiveId as string,archiveFile:t.archiveFile as string,...(typeof t.genre==='string'?{genre:t.genre}:{})};
  });
  if(new Set(tracks.map(sampleTrackKey)).size!==tracks.length) throw new SampleResourceError('Each song can appear only once.',400);
  return {enabled:v.enabled,reshuffle:v.reshuffle,holdMs:v.holdMs as number,cadenceMs:v.cadenceMs as number,tracks};
}

export async function readSampleResource(db: Env['DB']): Promise<SampleResource> {
  let row: { revision:number; settings:string|null; updated_by:string|null; updated_at:string|null } | null;
  try {row=await db.prepare('SELECT revision, settings, updated_by, updated_at FROM song_sample_settings WHERE id = 1').first<typeof row>();}
  catch(error){if(!/no such table.*song_sample_settings/i.test(String(error)))throw error;row=null;}
  if(!row?.settings)return {revision:row?.revision??0,settings:defaultSampleSettings(),updatedBy:null,updatedAt:null};
  // Corruption must fail closed, never silently restore an instructor-disabled pool.
  const parsed=JSON.parse(row.settings);const valid=parseSampleSettings(parsed);
  const tracks=valid.tracks.map(t=>({...t,...(parsed.tracks.find((x:SampleTrack)=>sampleTrackKey(x)===sampleTrackKey(t)) || {})}));
  return {revision:row.revision,settings:{...valid,tracks},updatedBy:row.updated_by,updatedAt:row.updated_at};
}

export async function saveSampleResource(db: Env['DB'], value: unknown, expectedRevision: unknown, actor: string): Promise<SampleResource> {
  if(!Number.isSafeInteger(expectedRevision) || (expectedRevision as number)<0)throw new SampleResourceError('Reload the song resource before saving.',400);
  const settings=parseSampleSettings(value), current=await readSampleResource(db);
  if(current.revision!==expectedRevision)throw new SampleResourceError('Another instructor changed these songs. Reload before saving.',409);
  // Reordering or changing cadence must work during an Archive outage. Verify
  // newly selected/renamed files; the public player rechecks every displayed file.
  let nextTrack=0;
  const verifyNext=async()=>{while(nextTrack<settings.tracks.length){
    const i=nextTrack++,t=settings.tracks[i],old=current.settings.tracks.find(x=>sampleTrackKey(x)===sampleTrackKey(t)&&x.artist===t.artist&&x.title===t.title);
    if(old&&old.durationSec&&old.durationSec<=300){settings.tracks[i]={...old,...t};continue;}
    const data=await verifyArchiveSample(`${t.artist} ${t.title}`,t.archiveId,t.archiveFile,300).catch(()=>null);
    if(!data?.results.length)throw new SampleResourceError(`Could not verify ${t.artist} — ${t.title}. Choose a complete recording of five minutes or less, or retry the verification.`,502);
    settings.tracks[i]={...t,durationSec:data.results[0].durationSec,itemTitle:data.results[0].itemTitle,verifiedAt:new Date().toISOString()};
  }};
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([Promise.all([verifyNext(),verifyNext(),verifyNext()]),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new SampleResourceError('Archive verification is busy. No changes were saved; try again.',502)),20000);})]);}finally{if(timer!==undefined)clearTimeout(timer);}
  const revision=current.revision+1,updatedAt=new Date().toISOString(),json=JSON.stringify(settings);
  const results=await db.batch([
    db.prepare('UPDATE song_sample_settings SET settings = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE id = 1 AND revision = ?').bind(json,actor,updatedAt,expectedRevision),
    db.prepare('INSERT INTO song_sample_revisions (revision, settings, updated_by, updated_at) SELECT ?, ?, ?, ? WHERE changes() = 1').bind(revision,json,actor,updatedAt),
  ]);
  if(results[0].meta.changes!==1)throw new SampleResourceError('Another instructor changed these songs. Reload before saving.',409);
  return {revision,settings,updatedBy:actor,updatedAt};
}

export async function instructorSampleResource(db:Env['DB']) {
  const resource=await readSampleResource(db);
  const tracks=[...catalog,...resource.settings.tracks].filter((t,i,a)=>a.findIndex(x=>sampleTrackKey(x)===sampleTrackKey(t))===i).filter(t=>t.durationSec&&t.durationSec<=300&&t.exampleEligible!==false);
  const urls=[...new Set(tracks.map(t=>'https://archive.org/details/'+encodeURIComponent(t.archiveId)))];
  const attribution="CASE WHEN json_valid(a.attribution) THEN a.attribution ELSE '{}' END";
  const rows=await db.prepare(`SELECT json_extract(${attribution},'$.sourceUrl') AS source_url, json_extract(${attribution},'$.fileName') AS file_name, COUNT(*) AS successful_runs
    FROM job_attributions a JOIN jobs j ON j.id=a.job_id WHERE j.status='done' AND json_extract(${attribution},'$.sourceUrl') IN (${urls.map(()=>'?').join(',')}) GROUP BY source_url,file_name`).bind(...urls).all<{source_url:string;file_name:string;successful_runs:number}>();
  return {...resource,catalog:tracks.map(t=>({...t,successfulRuns:rows.results.find(r=>r.source_url==='https://archive.org/details/'+encodeURIComponent(t.archiveId)&&r.file_name===t.archiveFile)?.successful_runs??0}))};
}

export async function publicSampleResource(db:Env['DB'], request:Request):Promise<Response> {
  const {revision,settings}=await readSampleResource(db);
  const body={revision,...settings,tracks:settings.enabled?settings.tracks:[]};
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body)));
  const version=revision+'-'+Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,16);
  const legacy=new URL(request.url).pathname==='/search-samples.json';
  const etag=`"song-samples-${version}-${legacy?'array':'snapshot'}"`;
  const headers={'Cache-Control':'public, max-age=0, must-revalidate',ETag:etag};
  if(request.headers.get('if-none-match')===etag)return new Response(null,{status:304,headers});
  return Response.json(legacy?body.tracks:{...body,version},{headers});
}
