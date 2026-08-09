export const QUERY_ISOLATION_SCHEMA_VERSION = '1' as const;

/** Optional target extraction is a separate resource, never a core stem. */
export interface QueryIsolationRequestV1 {
  schemaVersion: typeof QUERY_ISOLATION_SCHEMA_VERSION;
  isolationId: string;
  sourceUrl: string;
  normalizedTarget: string;
  provider: string;
  providerVersion: string;
  analysisVocabularyVersion: string | null;
  webhookUrl: string;
}

export interface QueryIsolationResultV1 {
  status: 'processing' | 'succeeded' | 'failed';
  targetUrl?: string;
  residualUrl?: string;
  error?: string;
}

export interface QueryIsolationProvider {
  start(request: QueryIsolationRequestV1): Promise<{ externalId: string }>;
  parseResult(payload: unknown): QueryIsolationResultV1;
  fetchStatus(externalId: string): Promise<QueryIsolationResultV1>;
}
