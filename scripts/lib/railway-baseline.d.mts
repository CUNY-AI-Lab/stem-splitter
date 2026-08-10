export interface RailwayBaselineStemDownload {
  name: string;
  bytes: number;
  sha256: string;
  audio: Buffer;
}

export function downloadRailwayBaselineStems(options: {
  baseline: unknown;
  fetchImpl?: typeof fetch;
}): Promise<{
  base: string;
  jobId: string;
  model: string;
  stems: RailwayBaselineStemDownload[];
}>;
