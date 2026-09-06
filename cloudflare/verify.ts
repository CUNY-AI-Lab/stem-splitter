import { CAIL_CANONICAL_ISSUER, loadIdentityVerifierConfig, verifyIdentityJwt } from '@cuny-ai-lab/cail-identity';
import { STEM_AUDIENCE } from '../src/identity.ts';

export async function verifyCailIdentity(token: string, jwks: string | undefined) {
  const loaded = await loadIdentityVerifierConfig({ jwks, issuer: CAIL_CANONICAL_ISSUER,
    expectedAudience: STEM_AUDIENCE, supportedIssuers: [CAIL_CANONICAL_ISSUER] });
  return loaded.ok ? await verifyIdentityJwt(token, loaded.config) : 'unavailable' as const;
}
