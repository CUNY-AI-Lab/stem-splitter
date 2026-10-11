export class UmpAudioError extends Error {
  code: string;
  constructor(code: string);
}
export function validateWebmInit(bytes: Uint8Array, totalAudioBytes?: number): void;
