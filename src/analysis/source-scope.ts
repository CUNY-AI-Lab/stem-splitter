export const AUDIO_ANALYSIS_SOURCE_SCOPE_VERSION = 'analysis-source-scope-v2' as const;

export type AudioAnalysisSourceScope =
  | 'stored_source'
  | 'authoritative_auto_snapshot';

export interface ScopedAudioAnalysisSource {
  key: string;
  scope: AudioAnalysisSourceScope;
}

const LOCAL_SOURCE_ROUTE_PREFIX = '/api/local-sources/';
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const STORAGE_CONTROL_PATTERN = /[\\\u0000-\u001f\u007f]/u;

function storedSourceKeyIsAllowed(key: string): boolean {
  const segments = key.split('/');
  if (
    segments.length !== 3 ||
    segments[0] !== 'uploads' ||
    !SAFE_ID_PATTERN.test(segments[1])
  ) {
    return false;
  }
  const filename = segments[2];
  return Boolean(
    filename.length >= 1 &&
      filename.length <= 120 &&
      filename === filename.trim() &&
      filename !== '.' &&
      filename !== '..' &&
      !STORAGE_CONTROL_PATTERN.test(filename)
  );
}

function authoritativeAutoKeyIsAllowed(key: string): boolean {
  const segments = key.split('/');
  return Boolean(
    segments.length === 3 &&
      segments[0] === 'auto-inputs' &&
      segments[1] === 'v1' &&
      SAFE_ID_PATTERN.test(segments[2])
  );
}

/**
 * The analyzer may read only ordinary stored sources and immutable
 * authoritative-Auto snapshots. It may never fetch stems, isolation outputs,
 * query-isolation snapshots, or arbitrary app routes.
 */
export function audioAnalysisSourceScopeForKey(
  key: string
): AudioAnalysisSourceScope | null {
  if (key.length < 1 || key.length > 512 || STORAGE_CONTROL_PATTERN.test(key)) {
    return null;
  }
  if (storedSourceKeyIsAllowed(key)) return 'stored_source';
  if (authoritativeAutoKeyIsAllowed(key)) return 'authoritative_auto_snapshot';
  return null;
}

/** Resolve only the canonical path emitted by the Railway app's signer. */
export function scopedAudioAnalysisSourceFromLocalPath(
  pathname: string
): ScopedAudioAnalysisSource | null {
  if (!pathname.startsWith(LOCAL_SOURCE_ROUTE_PREFIX)) return null;
  const encodedKey = pathname.slice(LOCAL_SOURCE_ROUTE_PREFIX.length);
  if (!encodedKey) return null;

  let key: string;
  try {
    key = encodedKey
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    return null;
  }

  const canonicalPath = key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  if (canonicalPath !== encodedKey) return null;

  const scope = audioAnalysisSourceScopeForKey(key);
  return scope ? { key, scope } : null;
}
