import { parseVideoSource } from './video-source.ts';
import { YouTubeError, type YouTubeAudio } from './youtube.ts';
import { readBoundedResponse, responseMediaType } from './http/bounded-response.ts';

const AUDIO_LIMIT = 12 * 1024 * 1024;
const METADATA_LIMIT = 2 * 1024 * 1024;
const INIT_LIMIT = 128 * 1024;
const SEGMENT_LIMIT = 2 * 1024 * 1024;
const MAX_SEGMENTS = 256;
const MAX_DURATION = 900;
const HTML_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-us,en;q=0.5', 'Sec-Fetch-Mode': 'navigate',
};
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const invalid = () => new YouTubeError('This video did not provide usable audio.', 'invalid_audio_response');
type VimeoFailureStage = 'player_http' | 'player_redirect' | 'player_privacy' | 'manifest_http' | 'manifest_protection' | 'segment_http' | 'segment_protection';
interface VimeoFailureDiagnostic { stage: VimeoFailureStage; httpStatus?: number }
class VimeoImportError extends YouTubeError {
  readonly diagnostic: Readonly<VimeoFailureDiagnostic>;
  constructor(message: string, code: string, stage: VimeoFailureStage, httpStatus?: number) {
    super(message, code);
    this.diagnostic = Object.freeze({ stage, ...(Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599 ? { httpStatus } : {}) });
  }
}
/** Internal, fixed fields only. Public responses continue to use YouTubeError.code. */
export function vimeoFailureDiagnostic(error: unknown): VimeoFailureDiagnostic | undefined {
  return error instanceof VimeoImportError ? { ...error.diagnostic } : undefined;
}
const denied = (stage: VimeoFailureStage, status?: number) => new VimeoImportError(
  'This source does not allow this import. Choose a permitted audio file.', 'youtube_source_denied', stage, status);
const tooLarge = () => new YouTubeError('This video’s audio exceeds the import size limit.', 'audio_too_large');
const timedOut = () => new YouTubeError('This video import timed out. Try again later.', 'youtube_fetch_timeout');

/** Parse one JSON object without evaluating scripts or accepting trailing script text. */
export function parseVimeoPlayerConfig(html: string): ObjectValue {
  if (html.length > METADATA_LIMIT) throw invalid();
  const match = /\b(?:playerConfig|config)\s*=\s*(?=\{)/.exec(html);
  if (!match) throw invalid();
  const start = match.index + match[0].length;
  let depth = 0, quoted = false, escaped = false;
  for (let at = start; at < html.length; at++) {
    const character = html[at];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{') { if (++depth > 64) throw invalid(); }
    else if (character === '}' && --depth === 0) {
      try { return object(JSON.parse(html.slice(start, at + 1))); } catch { throw invalid(); }
    }
  }
  throw invalid();
}

export function vimeoCdnUrl(value: unknown, base?: string): string {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x20\x7f\\]/.test(value)) throw invalid();
  let url: URL;
  try { url = new URL(value, base); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !(url.hostname === 'vimeocdn.com' || url.hostname.endsWith('.vimeocdn.com'))) throw invalid();
  return url.href;
}

function rejectProtection(value: ObjectValue): void {
  for (const name of ['drm', 'drm_info', 'is_drm', 'encrypted', 'encryption', 'content_protection', 'widevine', 'fairplay', 'playready', 'license_url']) {
    const flag = value[name];
    if (flag !== undefined && flag !== null && flag !== false && flag !== '') throw denied('manifest_protection');
  }
}

export function vimeoPlayerMetadata(config: ObjectValue, videoId: string, unlistedHash?: string) {
  const video = object(config.video), request = object(config.request);
  if (String(video.id) !== videoId) throw invalid();
  if (config.view !== 1 || !['anybody', ...(unlistedHash ? ['unlisted'] : [])].includes(String(video.privacy))) throw denied('player_privacy');
  if (unlistedHash && video.unlisted_hash !== unlistedHash) throw denied('player_privacy');
  if (video.embed_permission !== undefined && video.embed_permission !== 'public') throw denied('player_privacy');
  if (video.live_event || video.is_live) throw new YouTubeError('Live streams cannot be imported.', 'live_stream');
  if (!finite(video.duration) || video.duration <= 0) throw invalid();
  if (video.duration > MAX_DURATION) throw new YouTubeError('Choose a video shorter than 15 minutes.', 'video_too_long');
  const files = object(video.files || request.files), dash = object(files.dash);
  for (const entry of [config, video, request, files, dash]) rejectProtection(entry);
  if (typeof dash.default_cdn !== 'string') throw invalid();
  const cdn = object(object(dash.cdns)[dash.default_cdn]);
  const manifestUrl = vimeoCdnUrl(cdn.url);
  const title = typeof video.title === 'string' ? video.title.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200) : '';
  return { title: title || 'Vimeo audio', durationSec: video.duration, manifestUrl };
}

interface Box { type: string; start: number; end: number; payload: number }
function boxes(data: Uint8Array, start = 0, end = data.byteLength): Box[] {
  const result: Box[] = [], view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = start; at < end;) {
    if (at + 8 > end || result.length > 4096) throw invalid();
    let size = view.getUint32(at), header = 8;
    if (size === 1) {
      if (at + 16 > end) throw invalid();
      const extended = view.getBigUint64(at + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
      size = Number(extended); header = 16;
    }
    if (size < header || at + size > end) throw invalid();
    const type = String.fromCharCode(...data.subarray(at + 4, at + 8));
    result.push({ type, start: at, end: at + size, payload: at + header }); at += size;
  }
  return result;
}
function children(data: Uint8Array, parent: Box): Box[] { return boxes(data, parent.payload, parent.end); }
function one(list: Box[], type: string): Box {
  const found = list.filter(box => box.type === type);
  if (found.length !== 1) throw invalid();
  return found[0];
}
function clearBoxes(data: Uint8Array, list: Box[], stage: 'manifest_protection' | 'segment_protection', depth = 0): void {
  if (depth > 12) throw invalid();
  for (const box of list) {
    if (['pssh', 'sinf', 'tenc', 'senc', 'saiz', 'saio', 'enca', 'encv'].includes(box.type)) throw denied(stage);
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf'].includes(box.type)) clearBoxes(data, children(data, box), stage, depth + 1);
  }
}
export function validateVimeoInitialization(data: Uint8Array): void {
  if (data.byteLength < 32 || data.byteLength > INIT_LIMIT) throw invalid();
  const top = boxes(data); clearBoxes(data, top, 'manifest_protection');
  if (top[0]?.type !== 'ftyp' || top.some(box => !['ftyp', 'moov', 'free'].includes(box.type))) throw invalid();
  const moov = one(top, 'moov'), trak = one(children(data, moov), 'trak');
  const mdia = one(children(data, trak), 'mdia'), mediaChildren = children(data, mdia);
  const handler = one(mediaChildren, 'hdlr');
  if (handler.end - handler.payload < 12 || String.fromCharCode(...data.subarray(handler.payload + 8, handler.payload + 12)) !== 'soun') throw invalid();
  const stbl = one(children(data, one(mediaChildren, 'minf')), 'stbl');
  const stsd = one(children(data, stbl), 'stsd');
  if (stsd.end - stsd.payload < 8 || new DataView(data.buffer, data.byteOffset).getUint32(stsd.payload + 4) !== 1) throw invalid();
  const entries = boxes(data, stsd.payload + 8, stsd.end), entry = one(entries, 'mp4a');
  if (entries.length !== 1 || entry.end - entry.payload < 28) throw invalid();
  clearBoxes(data, boxes(data, entry.payload + 28, entry.end), 'manifest_protection');
}
export function validateVimeoSegment(data: Uint8Array): void {
  const top = boxes(data); clearBoxes(data, top, 'segment_protection');
  if (!top.some(box => box.type === 'moof') || !top.some(box => box.type === 'mdat') ||
      top.some(box => !['styp', 'sidx', 'moof', 'mdat', 'emsg', 'prft', 'free'].includes(box.type))) throw invalid();
}

export interface VimeoAudioPlan {
  init: Uint8Array; segments: Array<{ url: string; size: number }>; durationSec: number; totalBytes: number; bitrate: number;
}
export function vimeoAudioPlan(manifest: unknown, manifestUrl: string, videoDuration: number): VimeoAudioPlan {
  const root = object(manifest); rejectProtection(root);
  if (!Array.isArray(root.audio) || root.audio.length > 32) throw invalid();
  const base = vimeoCdnUrl(root.base_url, manifestUrl), plans: VimeoAudioPlan[] = [];
  let oversized = false;
  for (const raw of root.audio) {
    const audio = object(raw); rejectProtection(audio);
    if (audio.mime_type !== 'audio/mp4' || audio.codecs !== 'mp4a.40.2' || !['isom', 'mp42'].includes(String(audio.format))) continue;
    if (!finite(audio.duration) || audio.duration <= 0 || audio.duration > MAX_DURATION || Math.abs(audio.duration - videoDuration) > 2 ||
        !integer(audio.bitrate) || audio.bitrate <= 0 || audio.bitrate > 1_000_000 ||
        !integer(audio.channels) || audio.channels < 1 || audio.channels > 8 ||
        !integer(audio.sample_rate) || audio.sample_rate < 8000 || audio.sample_rate > 192000 ||
        !Array.isArray(audio.segments) || audio.segments.length < 1 || audio.segments.length > MAX_SEGMENTS) throw invalid();
    if (typeof audio.init_segment !== 'string' || audio.init_segment.length > Math.ceil(INIT_LIMIT / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audio.init_segment)) throw invalid();
    let init: Uint8Array;
    try { init = Uint8Array.from(atob(audio.init_segment), character => character.charCodeAt(0)); } catch { throw invalid(); }
    validateVimeoInitialization(init);
    const audioBase = vimeoCdnUrl(audio.base_url, base), segments: VimeoAudioPlan['segments'] = [];
    let end = 0, totalBytes = init.byteLength;
    for (const rawSegment of audio.segments) {
      const segment = object(rawSegment);
      if (!finite(segment.start) || !finite(segment.end) || segment.start < 0 || segment.end <= segment.start ||
          Math.abs(segment.start - end) > 0.05 || segment.end - segment.start > 30 || segment.end > audio.duration + 0.05 ||
          !integer(segment.size) || segment.size < 16 || segment.size > SEGMENT_LIMIT) throw invalid();
      segments.push({ url: vimeoCdnUrl(segment.url, audioBase), size: segment.size });
      end = segment.end; totalBytes += segment.size;
    }
    if (Math.abs(end - audio.duration) > 0.05) throw invalid();
    if (totalBytes > AUDIO_LIMIT) { oversized = true; continue; }
    plans.push({ init, segments, durationSec: audio.duration, totalBytes, bitrate: audio.bitrate });
  }
  plans.sort((a, b) => b.bitrate - a.bitrate);
  if (!plans.length) throw oversized ? tooLarge() : invalid();
  return plans[0];
}

export interface VimeoFetchOptions { deadline?: number; fetchImpl?: typeof fetch; now?: () => number }
export async function fetchVimeoAudio(url: string, options: VimeoFetchOptions = {}): Promise<YouTubeAudio> {
  const source = parseVideoSource(url);
  if (source?.sourceType !== 'vimeo') throw new YouTubeError('Paste a supported Vimeo video link.', 'invalid_video_url');
  const hash = source.canonicalUrl.split('/')[4];
  const playerUrl = `https://player.vimeo.com/video/${source.id}${hash ? `?h=${hash}` : ''}`;
  const now = options.now || Date.now, request = options.fetchImpl || fetch;
  if (options.deadline !== undefined && !finite(options.deadline)) throw timedOut();
  const deadline = Math.min(now() + 120_000, options.deadline ?? Infinity);
  const controller = new AbortController();
  const remaining = () => { const milliseconds = Math.floor(deadline - now()); if (milliseconds <= 0) throw timedOut(); return milliseconds; };
  const timer = setTimeout(() => controller.abort(), remaining());
  const read = async (initialUrl: string, kind: 'html' | 'json' | 'audio', limit: number): Promise<{ data: ArrayBuffer; url: string }> => {
    let address = initialUrl;
    for (let redirects = 0; redirects <= 2; redirects++) {
      remaining();
      if (controller.signal.aborted) throw timedOut();
      let response: Response;
      try {
        response = await request(address, { method: 'GET', redirect: 'manual', signal: controller.signal,
          headers: kind === 'html' ? { ...HTML_HEADERS, Referer: playerUrl } : { Accept: kind === 'json' ? 'application/json' : 'audio/mp4', 'Accept-Encoding': 'identity' } });
      } catch { throw controller.signal.aborted || now() >= deadline ? timedOut() : new YouTubeError('Video import is temporarily unavailable.', 'youtube_fetch_unavailable'); }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location'); await response.body?.cancel().catch(() => undefined);
        if (!location || redirects === 2) throw invalid();
        let target: string;
        try { target = new URL(location, address).href; } catch { throw invalid(); }
        if (kind === 'html') { if (target !== playerUrl) throw denied('player_redirect', response.status); } else target = vimeoCdnUrl(target);
        address = target; continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        const stage = kind === 'html' ? 'player_http' : kind === 'json' ? 'manifest_http' : 'segment_http';
        if ([401, 403, 451].includes(response.status)) throw denied(stage, response.status);
        if (response.status === 429) throw new VimeoImportError('Video import is busy. Try again later.', 'youtube_fetch_busy', stage, response.status);
        throw new VimeoImportError('Video import is temporarily unavailable.', 'youtube_fetch_unavailable', stage, response.status);
      }
      const type = responseMediaType(response), encoding = (response.headers.get('content-encoding') || 'identity').trim().toLowerCase();
      if (!(kind === 'html' ? ['text/html', 'application/xhtml+xml'].includes(type) : kind === 'json' ? ['application/json', 'text/json'].includes(type) : ['audio/mp4', 'video/mp4', 'application/octet-stream'].includes(type)) ||
          !(kind === 'html' ? ['identity', 'gzip', 'br', 'deflate'].includes(encoding) : encoding === 'identity')) {
        await response.body?.cancel().catch(() => undefined); throw invalid();
      }
      const bytes = await readBoundedResponse(response, { maximumBytes: limit, timeoutMs: remaining(), errors: { tooLarge, timedOut, unreadable: invalid } });
      remaining();
      if (!bytes.byteLength) throw invalid();
      return { data: bytes, url: address };
    }
    throw invalid();
  };
  const text = (data: ArrayBuffer) => { try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data); } catch { throw invalid(); } };
  try {
    const config = parseVimeoPlayerConfig(text((await read(playerUrl, 'html', METADATA_LIMIT)).data));
    const metadata = vimeoPlayerMetadata(config, source.id, hash);
    const manifestResponse = await read(metadata.manifestUrl, 'json', METADATA_LIMIT);
    let manifest: unknown;
    try { manifest = JSON.parse(text(manifestResponse.data)); }
    catch (error) { if (error instanceof YouTubeError) throw error; throw invalid(); }
    const plan = vimeoAudioPlan(manifest, manifestResponse.url, metadata.durationSec);
    // Vimeo's manifest sizes are estimates. Bound the actual bytes as they arrive
    // and retain source ordering independently of concurrent completion order.
    const chunks: Uint8Array[] = new Array(plan.segments.length);
    let next = 0, actualBytes = plan.init.byteLength;
    await Promise.all(Array.from({ length: Math.min(4, plan.segments.length) }, async () => {
      try {
        while (next < plan.segments.length) {
          const index = next++, segment = plan.segments[index];
          const bytes = new Uint8Array((await read(segment.url, 'audio', SEGMENT_LIMIT)).data);
          validateVimeoSegment(bytes);
          actualBytes += bytes.byteLength;
          if (actualBytes > AUDIO_LIMIT) throw tooLarge();
          chunks[index] = bytes;
        }
      } catch (error) { controller.abort(); throw error; }
    }));
    remaining();
    if (actualBytes < 1024) throw invalid();
    const output = new Uint8Array(actualBytes); output.set(plan.init);
    let offset = plan.init.byteLength;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return { data: output.buffer, title: metadata.title, durationSec: plan.durationSec };
  } catch (error) { if (now() >= deadline) throw timedOut(); throw error; }
  finally { clearTimeout(timer); controller.abort(); }
}
