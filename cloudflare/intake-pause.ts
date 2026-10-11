/** One runtime gate covers the canonical service alias and direct Worker URL.
 * It does not use storage or identity and can be installed before migrations.
 */
export type IntakePauseEnv = { INTAKE_PAUSED?: string };

export function intakeEnvironment<T extends IntakePauseEnv>(env: T): T {
  // The durable coordinator reconciles known work before honoring this flag.
  // Carry it on every request and scheduled invocation, not just POST routes.
  return env.INTAKE_PAUSED === 'true' ? { ...env, SPLIT_STARTS_DISABLED: 'true' } : env;
}

export function intakePauseResponse(request: Request, env: IntakePauseEnv): Response | null {
  if (env.INTAKE_PAUSED !== 'true') return null;
  const path = new URL(request.url).pathname;
  const startsWork = request.method === 'POST' && (
    /^\/api\/(?:jobs|uploads|remix\/archive-audio)\/?$/.test(path) ||
    /^\/api\/jobs\/[^/]+\/(?:chat|guide)\/?$/.test(path) ||
    /^\/api\/teacher\/jobs\/[^/]+\/isolations\/?$/.test(path)
  );
  const uploadsAudio = request.method === 'PUT' && /^\/api\/local-uploads(?:\/|$)/.test(path);
  if (!startsWork && !uploadsAudio) return null;
  return Response.json({
    error: 'New uploads, splits and Listening Guy requests are temporarily paused for maintenance. Saved audio remains available. Please try again shortly.',
    code: 'intake_paused',
    retryable: true,
  }, { status: 503, headers: { 'Retry-After': '120', 'Cache-Control': 'private, no-store' } });
}
