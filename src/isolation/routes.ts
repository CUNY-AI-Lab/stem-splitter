import { Hono } from 'hono';
import type { Env } from '../env.ts';
import type { AppPrincipal } from '../identity.ts';
import { readBoundedJsonRequest } from '../http/bounded-request.ts';
import { InstrumentTargetError } from './session.ts';
import { InstrumentIsolationResourceError } from './resource.ts';

const routes = new Hono<{ Bindings: Env; Variables: { principal?: AppPrincipal } }>();
routes.use('*', async (c, next) => {
  if (!c.env.instrumentTargets?.enabled) return c.json({ error: 'Not found' }, 404);
  if (!c.get('principal')) return c.json({ error: 'Sign in required' }, 401);
  c.header('Cache-Control', 'private, no-store');
  await next();
});
routes.onError((error, c) => {
    if (error instanceof InstrumentTargetError) return c.json({ code: error.code, error: error.message }, error.status);
    if (error instanceof InstrumentIsolationResourceError)
      return c.json({ code: error.code, error: 'The extraction could not be requested. Refresh its status before trying again.' }, 409);
    return c.json({ code: 'unavailable', error: 'Instrument extraction is temporarily unavailable. Refresh its status before trying again.' }, 503);
});
routes.get('/', async c => c.json(await c.env.instrumentTargets!.list(c.req.param('id')!, c.get('principal')!)));
routes.post('/', async c => {
  let body: unknown;
  try { body = await readBoundedJsonRequest(c.req.raw, 1024); }
  catch { return c.json({ error: 'Enter one short instrument or sound name.' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 ||
      !('target' in body) || typeof body.target !== 'string') return c.json({ error: 'Enter one instrument or sound name.' }, 400);
  return c.json(await c.env.instrumentTargets!.request(c.req.param('id')!, body.target, c.get('principal')!));
});
routes.get('/:targetId', async c => c.json(await c.env.instrumentTargets!.refresh(c.req.param('id')!, c.req.param('targetId'), c.get('principal')!)));
routes.get('/:targetId/audio', async c => c.env.instrumentTargets!.audio(c.req.param('id')!, c.req.param('targetId'), c.get('principal')!));
export default routes;
