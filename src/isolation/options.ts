import type { Env } from '../env';
import { validateQueryIsolationProviderIdentity } from './contract.ts';
import type { QueryIsolationProviderIdentityV1 } from './types.ts';

export const AUDIOSEP_ISOLATION_ID = 'audiosep-v1' as const;
export const AUDIOSEP_REPLICATE_MODEL = 'cjwbw/audiosep' as const;
export const AUDIOSEP_REPLICATE_VERSION_VAR = 'REPLICATE_AUDIOSEP_VERSION' as const;
export const AUDIOSEP_REPLICATE_CONTRACT_VERSION = 'audiosep-replicate-v1' as const;
export const AUDIOSEP_REVIEWED_REPLICATE_VERSION =
  'f07004438b8f3e6c5b720ba889389007cbf8dbbc9caa124afc24d9bbd2d307b8' as const;

export interface AudioSepReplicateRunner {
  id: typeof AUDIOSEP_ISOLATION_ID;
  provider: 'replicate';
  model: typeof AUDIOSEP_REPLICATE_MODEL;
  versionVar: typeof AUDIOSEP_REPLICATE_VERSION_VAR;
  contractVersion: typeof AUDIOSEP_REPLICATE_CONTRACT_VERSION;
  inputKeys: readonly ['audio_file', 'text'];
  output: 'uri';
  supportsResidual: false;
}

const AUDIOSEP_RUNNER: AudioSepReplicateRunner = Object.freeze({
  id: AUDIOSEP_ISOLATION_ID,
  provider: 'replicate',
  model: AUDIOSEP_REPLICATE_MODEL,
  versionVar: AUDIOSEP_REPLICATE_VERSION_VAR,
  contractVersion: AUDIOSEP_REPLICATE_CONTRACT_VERSION,
  inputKeys: ['audio_file', 'text'] as const,
  output: 'uri',
  supportsResidual: false,
});

export function getAudioSepReplicateRunner(): AudioSepReplicateRunner {
  return AUDIOSEP_RUNNER;
}

export function audioSepReplicateIdentity(
  env: Pick<Env, 'REPLICATE_AUDIOSEP_VERSION'>
): QueryIsolationProviderIdentityV1 {
  const identity = {
    provider: AUDIOSEP_RUNNER.provider,
    model: AUDIOSEP_RUNNER.model,
    version: env.REPLICATE_AUDIOSEP_VERSION ?? '',
    contractVersion: AUDIOSEP_RUNNER.contractVersion,
  };
  validateQueryIsolationProviderIdentity(identity);
  if (identity.version !== AUDIOSEP_REVIEWED_REPLICATE_VERSION) {
    throw new Error('The configured AudioSep version has not passed repository contract review');
  }
  return identity;
}

/** Exact provider surface consumed by the offline Replicate schema guard. */
export function queryIsolationReplicateContractSurface(): {
  model: string;
  inputKeys: string[];
  output: 'uri';
  versionVar: string;
  reviewedVersion: string;
  supportsResidual: false;
} {
  return {
    model: AUDIOSEP_RUNNER.model,
    inputKeys: [...AUDIOSEP_RUNNER.inputKeys],
    output: AUDIOSEP_RUNNER.output,
    versionVar: AUDIOSEP_RUNNER.versionVar,
    reviewedVersion: AUDIOSEP_REVIEWED_REPLICATE_VERSION,
    supportsResidual: AUDIOSEP_RUNNER.supportsResidual,
  };
}
