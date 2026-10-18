type Stage = 'adaptive_output' | 'provider_status' | 'source_import' | 'output_ingest';
const messages: Record<Stage,string> = {
  adaptive_output: 'Adaptive queue delivery failed; the message will be retried.',
  provider_status: 'Split provider reconciliation failed.',
  source_import: 'Source import reconciliation failed.',
  output_ingest: 'Split output ingestion failed.',
};
const names = new Set(['Error','TypeError','RangeError','AbortError','TimeoutError','UpstreamError','YouTubeError','ArchiveError']);

/** Provider exception text can contain signed URLs, credentials or private titles. */
export function logSplitError(event: 'adaptive_queue_failed' | 'split_reconcile_failed', jobId: string, stage: Stage, error: unknown) {
  const errorName = error instanceof Error && names.has(error.name) ? error.name : 'Error';
  console.error(JSON.stringify({event,jobId,stage,errorName,message:messages[stage]}));
}
