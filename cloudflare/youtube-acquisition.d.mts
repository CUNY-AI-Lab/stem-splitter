export interface BrowserBinding { fetch: typeof fetch }
export interface AcquisitionResult {
  audio: { data: Uint8Array; mimeType: 'audio/webm'; durationMs: number };
  receipt: { browserClosed: boolean; title?: string };
}
export class AcquisitionError extends Error { code: string; constructor(code: string) }
export function acquireYouTubeAudio(env: { BROWSER: BrowserBinding }, options: { videoId: string; deadline: number }): Promise<AcquisitionResult>;
