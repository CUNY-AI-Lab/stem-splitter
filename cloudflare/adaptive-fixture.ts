// Local codec harness only. This file is never a production entrypoint.
import { composeStemAudio } from './adaptive-audio.ts';
import { validateStemAudio } from './audio-validator.ts';
import { NAMED_LAYERS, type SourceLayer } from '../src/separation/prominent-layers.ts';
export default { async fetch(request: Request, env: Pick<PreviewBindings,'AUDIO'>) {
  if(request.headers.get('x-fixture')!=='local-only')return new Response('Not found',{status:404});
  const path=new URL(request.url).pathname;
  const input=/^\/input\/(vocals|drums|bass|guitar|piano|other)$/.exec(path);
  if(input&&request.method==='PUT') {
    const length=Number(request.headers.get('content-length'));
    if(!request.body||!Number.isSafeInteger(length)||length<1||length>24*1024*1024)return new Response('Invalid length',{status:400});
    const bounded=new FixedLengthStream(length);
    await Promise.all([request.body.pipeTo(bounded.writable),env.AUDIO.put(input[1],bounded.readable)]);
    return new Response('ok');
  }
  const output=/^\/output\/(vocals|drums|bass|guitar|piano|other)$/.exec(path);
  if(output&&request.method==='GET') {const found=await env.AUDIO.get('output/'+output[1]);return found?new Response(found.body,{headers:{'content-type':'audio/mpeg'}}):new Response('Missing',{status:404});}
  if(path==='/compose'&&request.method==='POST') {
    const result=await composeStemAudio({
      requested:new URL(request.url).searchParams.get('mode')==='auto'?'auto':4,
      sources:[...NAMED_LAYERS,'other' as const].map(name=>({name,open:async()=>{const found=await env.AUDIO.get(name);if(!found)throw new Error('Missing input');return found.body;}})),
      write:async(name:SourceLayer,bytes)=>{if(!await validateStemAudio(bytes.buffer as ArrayBuffer))throw new Error('Invalid encoded MP3');const key='output/'+name;await env.AUDIO.put(key,bytes);return key;},
    });
    return Response.json(result);
  }
  return new Response('Not found',{status:404});
}};
