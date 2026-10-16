export function parseMediaUrl(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(input)) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
        !url.hostname.includes('.') || url.hostname.startsWith('[') ||
        /^\d+(?:\.\d+){3}$/.test(url.hostname) || /\.(?:localhost|local|internal)$/i.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

