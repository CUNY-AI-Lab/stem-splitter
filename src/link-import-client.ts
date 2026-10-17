import type { Env } from './env.ts';
import { LINK_IMPORT_PATHS, type ImportRequest, type ImportResult, type LinkKind } from './link-import.ts';

/** Both the flag and the binding are required; either alone leaves the existing hosted path untouched. */
export const linkImportEnabled = (env: Env) => env.LINK_IMPORT_ENABLED === 'true' && typeof env.LINK_IMPORT?.fetch === 'function';

async function call<T>(env: Env, path: string, body: unknown): Promise<T> {
  const response = await env.LINK_IMPORT!.fetch(new Request(`https://link-import.internal${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  if (!response.ok) throw new Error(`link import service returned ${response.status}`);
  return await response.json() as T;
}

export const importLinkViaService = (env: Env, request: ImportRequest) => call<ImportResult>(env, LINK_IMPORT_PATHS.import, request);
export const resolveLinkViaService = (env: Env, url: string) => call<LinkKind>(env, LINK_IMPORT_PATHS.resolve, { url });
