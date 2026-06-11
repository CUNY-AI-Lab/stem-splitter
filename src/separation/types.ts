// The separation backend abstraction. This is the load-bearing seam of the
// app: everything else (uploads, jobs, storage, UI) is backend-agnostic, so
// swapping Replicate for Modal/RunPod/self-hosted later means implementing
// this interface and flipping the SEPARATION_BACKEND var.

export interface SeparationStartRequest {
  jobId: string;
  /** Presigned GET URL to the uploaded source audio. */
  audioUrl: string;
  /** URL the backend should POST to when the job completes. */
  webhookUrl: string;
}

export interface StemRef {
  /** e.g. "vocals", "drums", "bass", "other" */
  name: string;
  /** Temporary URL at the provider where the stem can be downloaded. */
  url: string;
}

export interface SeparationResult {
  status: 'processing' | 'succeeded' | 'failed';
  stems?: StemRef[];
  error?: string;
}

export interface SeparationBackend {
  /** Kick off a separation job. Returns the provider's id for it. */
  start(req: SeparationStartRequest): Promise<{ externalId: string }>;
  /** Normalize a webhook payload from this provider. */
  parseResult(payload: unknown): SeparationResult;
  /** Poll the provider directly (reconciliation fallback if a webhook is missed). */
  fetchStatus(externalId: string): Promise<SeparationResult>;
}
