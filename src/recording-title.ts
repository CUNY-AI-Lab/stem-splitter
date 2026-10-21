export const MAX_JOB_TITLE_CHARS = 200;
export const JOB_TITLE_ERROR = `Enter a single-line title up to ${MAX_JOB_TITLE_CHARS} characters.`;

export function normalizeRecordingTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  return title && Array.from(title).length <= MAX_JOB_TITLE_CHARS &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(title) ? title : null;
}
