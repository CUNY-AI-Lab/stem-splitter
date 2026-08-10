import {
  QUERY_ISOLATION_SCHEMA_VERSION,
  type QueryIsolationProviderIdentityV1,
  type QueryIsolationRequestV1,
} from './types.ts';

const SOURCE_HASH_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_VERSION_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
const TARGET_PATTERN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}'’&+\-/ ]*$/u;

export class QueryIsolationContractError extends Error {}

export interface QueryIsolationCacheMaterialV1 {
  sourceHash: string;
  normalizedTarget: string;
  analysisVocabularyVersion: string | null;
}

/**
 * One canonical noun-phrase form feeds provider calls, storage, and caching.
 * It deliberately rejects URLs, controls, and punctuation-heavy prose rather
 * than silently changing a teacher's target.
 */
export function normalizeIsolationTarget(value: string): string {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
  if (normalized.length < 2 || normalized.length > 80 || !TARGET_PATTERN.test(normalized)) {
    throw new QueryIsolationContractError(
      'Isolation targets must be a short instrument or sound name (2-80 characters)'
    );
  }
  return normalized;
}

function requireHttpsUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new QueryIsolationContractError(`${field} must be a valid HTTPS URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new QueryIsolationContractError(`${field} must be a credential-free HTTPS URL`);
  }
  return url;
}

function requireIsolationSnapshotUrl(request: QueryIsolationRequestV1): void {
  const url = requireHttpsUrl(request.sourceUrl, 'sourceUrl');
  const expectedSuffix =
    `/isolation-inputs/v1/${request.isolationId}/${request.sourceHash}`;
  if (!url.pathname.endsWith(expectedSuffix)) {
    throw new QueryIsolationContractError(
      'sourceUrl must address the verified isolation source snapshot'
    );
  }
}

export function validateQueryIsolationRequest(request: QueryIsolationRequestV1): void {
  if (request.schemaVersion !== QUERY_ISOLATION_SCHEMA_VERSION) {
    throw new QueryIsolationContractError('Unsupported query-isolation schema version');
  }
  if (!SAFE_ID_PATTERN.test(request.isolationId)) {
    throw new QueryIsolationContractError('Invalid isolation id');
  }
  validateQueryIsolationCacheMaterial(request);
  if (!['upload', 'youtube', 'archive'].includes(request.sourceType)) {
    throw new QueryIsolationContractError('Unsupported isolation source type');
  }
  requireIsolationSnapshotUrl(request);
  requireHttpsUrl(request.webhookUrl, 'webhookUrl');
}

export function validateQueryIsolationCacheMaterial(
  material: QueryIsolationCacheMaterialV1
): void {
  if (!SOURCE_HASH_PATTERN.test(material.sourceHash)) {
    throw new QueryIsolationContractError('sourceHash must be a lowercase SHA-256 digest');
  }
  if (normalizeIsolationTarget(material.normalizedTarget) !== material.normalizedTarget) {
    throw new QueryIsolationContractError('Isolation target is not in canonical form');
  }
  if (
    material.analysisVocabularyVersion !== null &&
    !SAFE_VERSION_LABEL_PATTERN.test(material.analysisVocabularyVersion)
  ) {
    throw new QueryIsolationContractError('Invalid analysis vocabulary version');
  }
}

export function validateQueryIsolationProviderIdentity(
  identity: QueryIsolationProviderIdentityV1
): void {
  for (const [field, value] of [
    ['provider', identity.provider],
    ['model', identity.model],
    ['contractVersion', identity.contractVersion],
  ] as const) {
    if (!SAFE_VERSION_LABEL_PATTERN.test(value)) {
      throw new QueryIsolationContractError(`Invalid isolation provider ${field}`);
    }
  }
  if (!VERSION_PATTERN.test(identity.version)) {
    throw new QueryIsolationContractError(
      'Isolation provider version must be an exact lowercase 64-character hash'
    );
  }
}

/**
 * Cache keys bind every field that can change the audio result. The source URL,
 * webhook, and isolation id are intentionally excluded because they are
 * transport details, not signal/model identity.
 */
export async function queryIsolationCacheKey(
  request: QueryIsolationRequestV1,
  identity: QueryIsolationProviderIdentityV1
): Promise<string> {
  validateQueryIsolationRequest(request);
  return queryIsolationCacheKeyForMaterial(request, identity);
}

/** Build the same cache key before short-lived transport URLs are minted. */
export async function queryIsolationCacheKeyForMaterial(
  material: QueryIsolationCacheMaterialV1,
  identity: QueryIsolationProviderIdentityV1
): Promise<string> {
  validateQueryIsolationCacheMaterial(material);
  validateQueryIsolationProviderIdentity(identity);
  const serialized = JSON.stringify([
    QUERY_ISOLATION_SCHEMA_VERSION,
    material.sourceHash,
    material.normalizedTarget,
    identity.provider,
    identity.model,
    identity.version,
    identity.contractVersion,
    material.analysisVocabularyVersion,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return `query-isolation/v1/${hex}`;
}
