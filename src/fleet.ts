import { loadIdentityVerifierConfig, readIdentityKeyring, verifyIdentityJwt, verifyKeyringGatewayJwt } from '@cuny-ai-lab/cail-identity';
import { correlationFromHeaders, createCailLogger, defineEventCatalog, workersStructuredSink } from '@cuny-ai-lab/cail-log';
import type { Env } from './env';

export async function fleetConfiguration(env: Env) {
  const app = await loadIdentityVerifierConfig({ jwks: env.CAIL_IDENTITY_JWKS, issuer: env.CAIL_IDENTITY_ISSUER, expectedAudience: 'cail:stem-splitter' });
  const gateway = await loadIdentityVerifierConfig({ jwks: env.CAIL_IDENTITY_JWKS, issuer: env.CAIL_IDENTITY_ISSUER, expectedAudience: 'cail:gateway' });
  let endpoint = false;
  try {
    const url = new URL(env.CAIL_GATEWAY_URL ?? '');
    endpoint = !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === '/' && (url.origin === 'https://tools.ailab.gc.cuny.edu' ||
        (env.LOCAL_DEV === '1' && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)));
  } catch { /* Missing or invalid configuration fails closed. */ }
  if (!app.ok || !gateway.ok || !endpoint || !env.ASSISTANT_MODEL ||
    env.ASSISTANT_MODEL.includes('/') || !/^[a-f0-9]{40}$/.test(env.CAIL_SOURCE_VERSION ?? '')) return null;
  return { app: app.config, gateway: gateway.config };
}

/** Identity authorizes model spend only. It never becomes class data ownership. */
export async function assistantRequestEnv(env: Env, request: Request, jobId: string): Promise<Env | 401 | 503> {
  const config = await fleetConfiguration(env);
  if (!config) return 503;
  const keyring = readIdentityKeyring(request.headers);
  if (!keyring) return 401;
  const identity = await verifyIdentityJwt(keyring.appJwt, config.app);
  if (!identity || !await verifyKeyringGatewayJwt(keyring, config.gateway, identity.subject)) return 401;
  const correlation = correlationFromHeaders(request.headers);
  const logger = createCailLogger({ service: 'stem-splitter', release: env.CAIL_SOURCE_VERSION!, env: 'production', sourceClass: 'tenant', catalog: defineEventCatalog({
    'assistant.authorized': { severity: 'info', source: 'tenant', required: ['request_id'], optional: [] },
  }), sink: workersStructuredSink });
  logger.emit('assistant.authorized', { request_id: correlation.request_id });
  return { ...env, CAIL_GATEWAY_IDENTITY_JWT: keyring.gatewayJwt, CAIL_CORRELATION: correlation,
    CAIL_ABORT_SIGNAL: request.signal, CAIL_CONVERSATION_ID: `stem-splitter:${jobId}` };
}
