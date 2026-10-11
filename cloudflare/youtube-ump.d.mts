export interface CapturedAudioProgress {
  complete: boolean;
  contiguousDurationMs: number;
  nextMissingStartMs: number | null;
  totalDurationMs: number;
  retainedAudioBytes: number;
}
export interface CapturedAudio {
  data: Uint8Array;
  mimeType: 'audio/webm';
  durationMs: number;
  metadata: {
    fixtureId: string; itag: number; container: 'webm'; codec: 'opus';
    mimeType: 'audio/webm; codecs="opus"'; durationSeconds: number;
    segments: number; bytes: number; protectionStatuses: number[];
  };
}
export function createCapturedUmpCollector(options: {
  videoId: string; durationMs: number; maximumAudioBytes?: number;
}): Readonly<{
  consume(bytes: Uint8Array): CapturedAudioProgress;
  progress(): CapturedAudioProgress;
  result(): CapturedAudio | null;
}>;
