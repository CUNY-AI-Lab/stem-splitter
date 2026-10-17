import type { Env } from '../env';

export type SelfHostedSeparatorStatus = 'unconfigured' | 'incomplete' | 'invalid' | 'configured';

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Whether the AUDIO_SEPARATOR_URL / AUDIO_SEPARATOR_TOKEN pair is safe to use.
 * Off this machine the service must be HTTPS with a token of at least 32
 * characters, the same rule local-separator/service.py enforces. Every start
 * request carries the Bearer token, a signed source URL and the webhook URL, so
 * failover never sends one to a pair that is not `configured`.
 */
export function selfHostedSeparatorStatus(
  env: Pick<Env, 'AUDIO_SEPARATOR_URL' | 'AUDIO_SEPARATOR_TOKEN'>
): SelfHostedSeparatorStatus {
  const url = env.AUDIO_SEPARATOR_URL ?? '';
  const token = env.AUDIO_SEPARATOR_TOKEN ?? '';
  const count = [url, token].filter(Boolean).length;
  if (count === 0) return 'unconfigured';
  if (count < 2) return 'incomplete';
  if (token !== token.trim() || /\s|[\u0000-\u001f\u007f]/.test(token)) return 'invalid';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid';
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return 'invalid';
  if (isLoopbackHost(parsed.hostname)) {
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? 'configured' : 'invalid';
  }
  if (parsed.protocol !== 'https:' || token.length < 32) return 'invalid';
  return 'configured';
}
