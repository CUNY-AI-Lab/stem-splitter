import type { AppPrincipal } from './identity.ts';

/** Authority comes from the verified principal, never a submitted role. */
export function importDurationLimit(principal: AppPrincipal | undefined): 300 | 900 {
  if (!principal || principal.quotaClass === 'guest' || principal.role === 'guest') return 300;
  return ['student', 'member', 'instructor', 'admin'].includes(principal.role) ? 900 : 300;
}

export function durationIsAllowed(seconds: unknown, maximum: 300 | 900): seconds is number {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 && seconds <= maximum;
}
