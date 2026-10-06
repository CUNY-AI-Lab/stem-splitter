/** Structural preflight only. Settlement additionally requires validateMp3Pcm
 * with the trusted platform decoder; frame headers alone are insufficient. */
export function validMp3Frames(data: ArrayBuffer): boolean {
  const b=new Uint8Array(data);let offset=0,frames=0,signature=-1;
  if(b.length>=10&&b[0]===73&&b[1]===68&&b[2]===51) {
    if([b[6],b[7],b[8],b[9]].some(v=>v>127))return false;
    offset=10+((b[6]<<21)|(b[7]<<14)|(b[8]<<7)|b[9])+(b[5]&16?10:0);
    if(offset>256*1024||offset>=b.length)return false;
  }
  for(;offset+4<=b.length;) {
    if(b.length-offset===128&&b[offset]===84&&b[offset+1]===65&&b[offset+2]===71)return frames>=2;
    if(b[offset]!==255||(b[offset+1]&0xe0)!==0xe0)return false;
    const version=(b[offset+1]>>3)&3,layer=(b[offset+1]>>1)&3,rateIndex=(b[offset+2]>>2)&3,bitrateIndex=b[offset+2]>>4;
    if(version===1||layer!==1||rateIndex===3||bitrateIndex===0||bitrateIndex===15)return false;
    const rate=[44100,48000,32000][rateIndex]/(version===3?1:version===2?2:4);
    const bitrate=(version===3?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[bitrateIndex];
    const current=(version<<4)|rateIndex;
    if(signature!==-1&&signature!==current)return false;signature=current;
    const length=Math.floor((version===3?144000:72000)*bitrate/rate)+((b[offset+2]>>1)&1);
    if(length<24||offset+length>b.length)return false;
    offset+=length;frames++;
  }
  return offset===b.length&&frames>=2;
}

export interface PcmDecoder {
  ready: Promise<unknown>;
  decode(bytes: Uint8Array): { errors: unknown[]; channelData: Float32Array[]; samplesDecoded: number; sampleRate: number };
  free(): void;
}

/** Reject semantic side-info errors which tolerant decoders may conceal as
 * silence. These are MPEG Layer III syntax constraints, not an audio-quality
 * heuristic: a legitimate silent stem remains valid. */
export function mp3FrameInfo(data: ArrayBuffer): { frames: number; seconds: number; sampleRate: number } | null {
  if(data.byteLength>32*1024*1024||!validMp3Frames(data))return null;
  const bytes=new Uint8Array(data);let offset=0,frames=0,seconds=0,availableMain=0,sampleRate=0;
  if(bytes[0]===73&&bytes[1]===68&&bytes[2]===51)offset=10+((bytes[6]<<21)|(bytes[7]<<14)|(bytes[8]<<7)|bytes[9])+(bytes[5]&16?10:0);
  while(offset+4<=bytes.length) {
    if(bytes.length-offset===128&&bytes[offset]===84&&bytes[offset+1]===65&&bytes[offset+2]===71)break;
    const version=(bytes[offset+1]>>3)&3,channels=(bytes[offset+3]>>6)===3?1:2;
    sampleRate=[44100,48000,32000][(bytes[offset+2]>>2)&3]/(version===3?1:version===2?2:4);
    const bitrate=(version===3?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[bytes[offset+2]>>4];
    const length=Math.floor((version===3?144000:72000)*bitrate/sampleRate)+((bytes[offset+2]>>1)&1);
    const sideBytes=version===3?(channels===1?17:32):(channels===1?9:17),headerBytes=4+(bytes[offset+1]&1?0:2);
    if(length<headerBytes+sideBytes)return null;
    let bit=(offset+headerBytes)*8;
    const take=(count:number)=>{let value=0;while(count--)value=(value<<1)|((bytes[bit>>3]>>(7-(bit++&7)))&1);return value;};
    const mainBegin=take(version===3?9:8);
    if(mainBegin>availableMain)return null;
    take(version===3?(channels===1?5:3):channels);
    if(version===3)take(channels*4);
    let codedBits=0;
    for(let block=0;block<(version===3?2:1)*channels;block++) {
      codedBits+=take(12);
      if(take(9)>288)return null;
      take(8);take(version===3?4:9);
      if(take(1)) {
        if(take(2)===0)return null;
        take(1);
        for(let table=0;table<2;table++)if([4,14].includes(take(5)))return null;
        take(9);
      } else {
        for(let table=0;table<3;table++)if([4,14].includes(take(5)))return null;
        if(take(4)+take(3)>20)return null;
      }
      if(version===3)take(1);
      take(2);
    }
    const mainBytes=length-headerBytes-sideBytes;
    if(codedBits>(mainBegin+mainBytes)*8)return null;
    availableMain=Math.min(availableMain+mainBytes,version===3?511:255);
    seconds+=(version===3?1152:576)/sampleRate;frames++;offset+=length;
  }
  return seconds<=900.1?{frames,seconds,sampleRate}:null;
}

/** Decode the entire bounded input in small chunks and discard PCM immediately.
 * The adapter supplies a pinned, locally bundled decoder, never a browser claim.
 * Tolerant decoders cannot prove freedom from all corruption; syntax preflight,
 * reported errors, finite PCM, expected duration and nonempty output all gate
 * settlement. No inference about artistic content or silence is made. */
export async function validateMp3Pcm(data: ArrayBuffer,create:()=>PcmDecoder): Promise<boolean> {
  const frames=mp3FrameInfo(data);if(!frames)return false;
  let decoder:PcmDecoder|undefined;
  try {
    decoder=create();await decoder.ready;
    const bytes=new Uint8Array(data);let samples=0;
    // At most 8192 synchronous chunks, <=131072 samples/channel per chunk.
    // A 15-minute limit bounds work independently of a host's frozen clock.
    for(let offset=0;offset<bytes.length;offset+=4096) {
      const part=decoder.decode(bytes.subarray(offset,offset+4096));
      if(part.errors.length||!Number.isSafeInteger(part.samplesDecoded)||part.samplesDecoded<0||part.samplesDecoded>131072)return false;
      if(part.samplesDecoded) {
        if(part.sampleRate!==frames.sampleRate||part.channelData.length<1||part.channelData.length>2)return false;
        for(const channel of part.channelData) {
          if(channel.length!==part.samplesDecoded)return false;
          for(const sample of channel)if(!Number.isFinite(sample))return false;
        }
        samples+=part.samplesDecoded;
      }
    }
    const decoded=samples/frames.sampleRate;
    // MP3 delay/padding and one metadata frame may be omitted by the decoder.
    return decoded>0 && decoded<=900.1 && decoded<=frames.seconds+0.1 && frames.seconds-decoded<=0.5;
  } catch {return false;}
  finally {if(decoder)try {decoder.free();}catch { /* A failed decoder never settles success. */ }}
}
