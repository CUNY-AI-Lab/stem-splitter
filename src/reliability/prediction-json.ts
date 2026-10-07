/** Strip a single inline audio value before JSON text allocation. JSON.parse
 * still validates the complete metadata document and its exact output.audio
 * location. The audio bytes are decoded in small base64 chunks, never as a
 * whole UTF-16 string. Provider URLs follow the normal bounded download path. */
export function parsePredictionJson(data:ArrayBuffer,maximumInlineBytes:number):{value:unknown;inlineAudio?:ArrayBuffer;inlineTooLarge?:boolean} {
  const bytes=new Uint8Array(data),metadataLimit=256*1024;
  const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});
  const white=(n:number)=>n===32||n===10||n===13||n===9;
  let start=-1,end=-1,payload=-1;
  for(let i=0;i<bytes.length;i++) {
    if(bytes[i]!==34)continue;
    const token=i++;let escaped=false;
    while(i<bytes.length&&bytes[i]!==34){if(bytes[i]===92){escaped=true;i++;}i++;}
    if(i>=bytes.length)throw new Error('invalid_prediction_json');
    if(escaped||i-token!==6||decoder.decode(bytes.subarray(token+1,i))!=='audio')continue;
    let next=i+1;while(white(bytes[next]))next++;
    if(bytes[next++]!==58)continue;while(white(bytes[next]))next++;
    if(bytes[next]!==34)continue;
    let comma=next+1;while(comma<Math.min(next+128,bytes.length)&&bytes[comma]!==44&&bytes[comma]!==34)comma++;
    if(bytes[comma]!==44)continue;
    const header=decoder.decode(bytes.subarray(next+1,comma));
    if(!/^data:(?:audio\/[a-z0-9.+-]+|application\/octet-stream);base64$/i.test(header))continue;
    start=next;payload=comma+1;end=payload;
    while(end<bytes.length&&bytes[end]!==34)end++;
    if(end>=bytes.length)throw new Error('invalid_prediction_json');
    break;
  }
  if(start<0) {
    if(bytes.length>metadataLimit)throw new Error('prediction_metadata_too_large');
    return {value:JSON.parse(decoder.decode(bytes))};
  }
  if(bytes.length-(end-start+1)>metadataLimit)throw new Error('prediction_metadata_too_large');
  const length=end-payload;
  if(length%4)throw new Error('invalid_prediction_base64');
  let padding=0;if(bytes[end-1]===61)padding++;if(bytes[end-2]===61)padding++;
  const decodedLength=length/4*3-padding;
  const marker='inline:'+crypto.randomUUID();
  const text=decoder.decode(bytes.subarray(0,start))+JSON.stringify(marker)+decoder.decode(bytes.subarray(end+1));
  const value=JSON.parse(text);
  if(!value||typeof value!=='object'||value.output?.audio!==marker)throw new Error('invalid_prediction_audio_location');
  if(decodedLength>maximumInlineBytes)return {value,inlineTooLarge:true};
  const audio=new Uint8Array(decodedLength);let offset=0;
  for(let at=payload;at<end;at+=16384) {
    const chunk=decoder.decode(bytes.subarray(at,Math.min(at+16384,end)));
    if(!/^[A-Za-z0-9+/]*={0,2}$/.test(chunk)||(at+16384<end&&chunk.includes('=')))throw new Error('invalid_prediction_base64');
    const binary=atob(chunk);
    for(let j=0;j<binary.length;j++)audio[offset++]=binary.charCodeAt(j);
  }
  if(offset!==decodedLength)throw new Error('invalid_prediction_base64');
  return {value,inlineAudio:audio.buffer};
}
