import type { Env } from './env';

export type ServerAutoMode = 'off' | 'shadow' | 'authoritative';

export interface ProcessingFeatureFlags {
  serverAuto: boolean;
  serverAutoMode: ServerAutoMode;
  instrumentDiscovery: boolean;
  queryIsolation: boolean;
}

/** Feature flags are opt-in: only the literal value "true" enables a path. */
export function flagEnabled(value: string | undefined): boolean {
  return value === 'true';
}

export function processingFeatureFlags(env: Pick<Env,
  | 'SERVER_AUTO_ENABLED'
  | 'SERVER_AUTO_MODE'
  | 'INSTRUMENT_DISCOVERY_ENABLED'
  | 'QUERY_ISOLATION_ENABLED'
>): ProcessingFeatureFlags {
  const serverAuto = flagEnabled(env.SERVER_AUTO_ENABLED);
  const requestedMode = env.SERVER_AUTO_MODE;
  const serverAutoMode: ServerAutoMode = !serverAuto
    ? 'off'
    : requestedMode === 'authoritative'
      ? 'authoritative'
      : !requestedMode || requestedMode === 'shadow'
        ? 'shadow'
        : 'off';

  return {
    serverAuto,
    serverAutoMode,
    instrumentDiscovery: flagEnabled(env.INSTRUMENT_DISCOVERY_ENABLED),
    queryIsolation: flagEnabled(env.QUERY_ISOLATION_ENABLED),
  };
}
