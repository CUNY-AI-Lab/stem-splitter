import { ANALYSIS_SAMPLE_RATE } from './config.ts';
import { ProcessFailure, runBoundedProcess } from './process.ts';
import { MAX_ANALYSIS_SECONDS } from '../src/analysis/types.ts';

const FLOAT_BYTES = 4;

export class DecoderError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface DecoderReadiness {
  ffmpegVersion: string;
  ffprobeVersion: string;
}

export interface DecodedAnalysisAudio {
  samples: Float32Array;
  sampleRate: typeof ANALYSIS_SAMPLE_RATE;
  sourceDurationSeconds: number;
  analyzedSeconds: number;
}

function versionFromOutput(binary: string, output: Buffer): string {
  const firstLine = output.toString('utf8').split(/\r?\n/, 1)[0] ?? '';
  const match = firstLine.match(new RegExp(`^${binary} version ([^ ]+)`));
  if (!match) throw new DecoderError(`${binary}_version_invalid`);
  return match[1];
}

export async function probeDecoder(
  expectedFfmpegVersion: string,
  signal?: AbortSignal
): Promise<DecoderReadiness> {
  try {
    const [ffmpeg, ffprobe] = await Promise.all([
      runBoundedProcess('ffmpeg', ['-version'], {
        timeoutMs: 5_000,
        maxStdoutBytes: 16 * 1024,
        signal,
      }),
      runBoundedProcess('ffprobe', ['-version'], {
        timeoutMs: 5_000,
        maxStdoutBytes: 16 * 1024,
        signal,
      }),
    ]);
    const ffmpegVersion = versionFromOutput('ffmpeg', ffmpeg.stdout);
    const ffprobeVersion = versionFromOutput('ffprobe', ffprobe.stdout);
    if (ffmpegVersion !== expectedFfmpegVersion || ffprobeVersion !== expectedFfmpegVersion) {
      throw new DecoderError('decoder_version_mismatch');
    }
    return { ffmpegVersion, ffprobeVersion };
  } catch (error) {
    if (error instanceof DecoderError) throw error;
    throw new DecoderError('decoder_unavailable');
  }
}

function parseDuration(output: Buffer, maximum: number): number {
  try {
    const parsed = JSON.parse(output.toString('utf8')) as {
      streams?: Array<{ duration?: string }>;
      format?: { duration?: string };
    };
    const candidates = [parsed.streams?.[0]?.duration, parsed.format?.duration];
    const duration = candidates.map(Number).find((value) => Number.isFinite(value) && value > 0);
    if (!duration) throw new Error('missing duration');
    if (duration > maximum) throw new DecoderError('source_duration_exceeded');
    return duration;
  } catch (error) {
    if (error instanceof DecoderError) throw error;
    throw new DecoderError('source_duration_invalid');
  }
}

export function analysisWindowPlan(duration: number): Array<{ start: number; seconds: number }> {
  if (duration <= MAX_ANALYSIS_SECONDS) return [{ start: 0, seconds: duration }];
  const seconds = MAX_ANALYSIS_SECONDS / 3;
  const availableStart = duration - seconds;
  return [
    { start: 0, seconds },
    { start: availableStart / 2, seconds },
    { start: availableStart, seconds },
  ];
}

function floatSamples(buffer: Buffer): Float32Array {
  if (!buffer.length || buffer.length % FLOAT_BYTES !== 0) {
    throw new DecoderError('decoded_pcm_invalid');
  }
  const copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Float32Array(copy);
}

export async function decodeAnalysisWindows(
  path: string,
  options: {
    timeoutMs: number;
    maxSourceDurationSeconds: number;
    signal?: AbortSignal;
  }
): Promise<DecodedAnalysisAudio> {
  const deadline = Date.now() + options.timeoutMs;
  const remaining = () => {
    const value = deadline - Date.now();
    if (value < 1) throw new DecoderError('decoder_timeout');
    return value;
  };
  try {
    const probe = await runBoundedProcess(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=duration:format=duration',
        '-of',
        'json',
        path,
      ],
      { timeoutMs: remaining(), maxStdoutBytes: 16 * 1024, signal: options.signal }
    );
    const sourceDurationSeconds = parseDuration(probe.stdout, options.maxSourceDurationSeconds);
    const windows = analysisWindowPlan(sourceDurationSeconds);
    const decoded: Float32Array[] = [];
    let sampleCount = 0;
    for (const window of windows) {
      const maxBytes = Math.ceil((window.seconds + 0.1) * ANALYSIS_SAMPLE_RATE * FLOAT_BYTES);
      const result = await runBoundedProcess(
        'ffmpeg',
        [
          '-v',
          'error',
          '-nostdin',
          // Input-side accurate seeking avoids decoding from the beginning of
          // a 15-minute source just to reach the middle or end window.
          '-ss',
          window.start.toFixed(6),
          '-i',
          path,
          '-t',
          window.seconds.toFixed(6),
          '-map',
          '0:a:0',
          '-vn',
          '-ac',
          '1',
          '-ar',
          String(ANALYSIS_SAMPLE_RATE),
          '-acodec',
          'pcm_f32le',
          '-f',
          'f32le',
          'pipe:1',
        ],
        { timeoutMs: remaining(), maxStdoutBytes: maxBytes, signal: options.signal }
      );
      const samples = floatSamples(result.stdout);
      decoded.push(samples);
      sampleCount += samples.length;
    }
    if (!sampleCount || sampleCount > MAX_ANALYSIS_SECONDS * ANALYSIS_SAMPLE_RATE + 1) {
      throw new DecoderError('decoded_pcm_limit_exceeded');
    }
    const samples = new Float32Array(sampleCount);
    let offset = 0;
    for (const segment of decoded) {
      samples.set(segment, offset);
      offset += segment.length;
    }
    return {
      samples,
      sampleRate: ANALYSIS_SAMPLE_RATE,
      sourceDurationSeconds,
      analyzedSeconds: samples.length / ANALYSIS_SAMPLE_RATE,
    };
  } catch (error) {
    if (error instanceof DecoderError) throw error;
    if (error instanceof ProcessFailure && error.code === 'timeout') {
      throw new DecoderError('decoder_timeout');
    }
    throw new DecoderError('audio_unsupported');
  }
}
