export const QUERY_ISOLATION_SCHEMA_VERSION = '1' as const;

export type QueryIsolationSourceType = 'upload' | 'youtube' | 'archive';

/**
 * Provider identity is immutable job metadata and part of the cache identity.
 * A model alias or floating provider version is never sufficient.
 */
export interface QueryIsolationProviderIdentityV1 {
  provider: string;
  model: string;
  version: string;
  contractVersion: string;
}

/** Optional target extraction is a separate resource, never a core stem. */
export interface QueryIsolationRequestV1 {
  schemaVersion: typeof QUERY_ISOLATION_SCHEMA_VERSION;
  isolationId: string;
  sourceUrl: string;
  sourceHash: string;
  sourceType: QueryIsolationSourceType;
  normalizedTarget: string;
  analysisVocabularyVersion: string | null;
  webhookUrl: string;
}

export type QueryIsolationFailureCode =
  | 'provider_failed'
  | 'provider_canceled'
  | 'invalid_provider_response'
  | 'output_ingestion_failed';

export interface QueryIsolationFailureV1 {
  code: QueryIsolationFailureCode;
  retryable: boolean;
  /** App-owned copy only; never pass through provider errors or logs. */
  message: string;
}

export interface QueryIsolationResultV1 {
  schemaVersion: typeof QUERY_ISOLATION_SCHEMA_VERSION;
  status: 'processing' | 'succeeded' | 'failed';
  /** Independently queried target. It is not a core stem. */
  targetUrl?: string;
  /** Some future providers may produce a residual; AudioSep does not. */
  residualUrl?: string;
  failure?: QueryIsolationFailureV1;
}

export interface QueryIsolationStartResultV1 {
  externalId: string;
  identity: QueryIsolationProviderIdentityV1;
}

export interface QueryIsolationProvider {
  readonly identity: QueryIsolationProviderIdentityV1;
  start(request: QueryIsolationRequestV1): Promise<QueryIsolationStartResultV1>;
  parseResult(payload: unknown): QueryIsolationResultV1;
  fetchStatus(externalId: string): Promise<QueryIsolationResultV1>;
}
