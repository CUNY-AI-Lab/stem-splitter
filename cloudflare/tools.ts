import { CAIL_CANONICAL_ISSUER, loadIdentityVerifierConfig, verifyIdentityJwt } from '@cuny-ai-lab/cail-identity';
import { authFailure } from '../src/identity.ts';
import { currentMembership } from '../src/membership.ts';
import { boundedRpc, sanitizedRequest } from './sso.ts';
import worker, { type WorkerEnv } from './worker.ts';

export const TOOLS_ORIGIN = 'https://tools.ailab.gc.cuny.edu';
export const TOOLS_MOUNT = '/stem-splitter';

/** This boundary is called only through the private ToolsApp service binding. */
export async function toolsRequest(request: Request, env: WorkerEnv): Promise<Request | Response> {
  const url = new URL(request.url);
  if (url.origin !== TOOLS_ORIGIN || (url.pathname !== TOOLS_MOUNT && !url.pathname.startsWith(`${TOOLS_MOUNT}/`))) {
    return new Response('Not found', { status: 404 });
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      (request.headers.get('origin') !== TOOLS_ORIGIN || request.headers.get('sec-fetch-site') === 'cross-site')) {
    return authFailure('invalid_credential', 403);
  }
  const [appConfig, gatewayConfig] = await Promise.all(['cail:stem-splitter', 'cail:gateway'].map(expectedAudience =>
    loadIdentityVerifierConfig({ jwks: env.CAIL_IDENTITY_JWKS, issuer: CAIL_CANONICAL_ISSUER, expectedAudience, supportedIssuers: [CAIL_CANONICAL_ISSUER] })));
  if (!appConfig.ok || !gatewayConfig.ok || !env.ADMISSION_RESOLVER) return authFailure('identity_verification_misconfigured', 503);
  const appJwt = request.headers.get('x-cail-identity-jwt');
  const gatewayJwt = request.headers.get('x-cail-gateway-identity-jwt');
  if (!appJwt || appJwt.length > 16384 || !gatewayJwt || gatewayJwt.length > 16384) return authFailure('authentication_required', 401);
  const [appIdentity, gatewayIdentity] = await Promise.all([
    verifyIdentityJwt(appJwt, appConfig.config), verifyIdentityJwt(gatewayJwt, gatewayConfig.config),
  ]);
  if (!appIdentity || !gatewayIdentity || appIdentity.subject !== gatewayIdentity.subject) return authFailure('invalid_credential', 401);
  let membership;
  try { membership = currentMembership(await boundedRpc(env.ADMISSION_RESOLVER.resolveMembership({ subject: appIdentity.subject }))); }
  catch { return authFailure('admission_unavailable', 503); }
  if (membership === 'denied') return authFailure('admission_required', 403);
  if (!membership) return authFailure('admission_unavailable', 503);
  url.pathname = url.pathname.slice(TOOLS_MOUNT.length) || '/';
  const headers = new Headers(sanitizedRequest(new Request(request.url, { headers: request.headers })).headers);
  // Doorway strips caller forwarding headers and supplies this platform IP.
  // The public Worker handler never trusts a forwarded IP.
  headers.delete('cf-connecting-ip');
  const clientIp = request.headers.get('x-forwarded-for');
  if (clientIp && /^[0-9a-fA-F:.]{3,45}$/.test(clientIp)) headers.set('cf-connecting-ip', clientIp);
  headers.delete('x-forwarded-for');
  headers.set('x-cail-identity-jwt', appJwt);
  headers.set('x-cail-gateway-identity-jwt', gatewayJwt);
  const internal = new Request(url, request);
  for (const name of [...internal.headers.keys()]) internal.headers.delete(name);
  for (const [name, value] of headers) internal.headers.set(name, value);
  return internal;
}

function mountedPath(path: string): string {
  return path.startsWith('/') && !path.startsWith('//') && path !== '/auth/logout' && path !== TOOLS_MOUNT && !path.startsWith(`${TOOLS_MOUNT}/`)
    ? `${TOOLS_MOUNT}${path}` : path;
}

/** Doorway already owns sign-in; this only returns to an app page afterward. */
export function toolsLoginPath(next: string | null): string {
  if (!next?.startsWith('/') || next.startsWith('//') || next.includes('\\')) return `${TOOLS_MOUNT}/`;
  const target = new URL(next, TOOLS_ORIGIN);
  const pathname = target.pathname.startsWith(`${TOOLS_MOUNT}/`) ? target.pathname.slice(TOOLS_MOUNT.length) : target.pathname;
  if (target.origin !== TOOLS_ORIGIN || !['/', '/index.html', '/teacher', '/teacher.html', '/account', '/account.html', '/classroom', '/classroom.html'].includes(pathname)) return `${TOOLS_MOUNT}/`;
  return `${TOOLS_MOUNT}${pathname}${target.search}`;
}

/** Rewrite only static HTML URL attributes; scripts and API bodies are app-owned. */
function mountedResponse(response: Response): Response {
  const location = response.headers.get('location');
  if (location) {
    const target = new URL(location, TOOLS_ORIGIN);
    if (target.origin === TOOLS_ORIGIN) {
      target.pathname = mountedPath(target.pathname);
      const headers = new Headers(response.headers);
      headers.set('location', target.href);
      response = new Response(response.body, { status: response.status, headers });
    }
  }
  if (!response.headers.get('content-type')?.includes('text/html')) return response;
  return new HTMLRewriter().on('[href], [src], [action]', {
    element(element) {
      for (const attribute of ['href', 'src', 'action']) {
        const value = element.getAttribute(attribute);
        if (value !== null) element.setAttribute(attribute, mountedPath(value));
      }
    },
  }).transform(response);
}

export async function serveTools(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const internal = await toolsRequest(request, env);
  if (internal instanceof Response) return internal;
  const original = new URL(request.url);
  if (original.pathname === TOOLS_MOUNT) {
    original.pathname += '/';
    return Response.redirect(original.href, 308);
  }
  const url = new URL(internal.url);
  if (url.pathname === '/auth/login' && request.method === 'GET') {
    return new Response(null, { status: 303, headers: { Location: toolsLoginPath(url.searchParams.get('next')), 'Cache-Control': 'private, no-store' } });
  }
  // CUNY sign-in and logout at this mount belong to Doorway's session.
  if (url.pathname.startsWith('/auth/')) return new Response('Not found', { status: 404 });
  const response = await worker.fetch(internal, {
    ...env, APP_BASE_PATH: TOOLS_MOUNT, CAIL_LOGIN_URL: `${TOOLS_MOUNT}/auth/login`,
    CAIL_BROWSER_ORIGIN: TOOLS_ORIGIN, GUEST_ENABLED: 'false',
  }, ctx, true);
  return mountedResponse(response);
}
