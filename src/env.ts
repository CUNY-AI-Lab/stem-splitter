export type Env = {
  // Bindings
  AUDIO: R2Bucket;
  DB: D1Database;

  // Vars (wrangler.jsonc)
  R2_BUCKET_NAME: string;
  CF_ACCOUNT_ID: string;
  PUBLIC_BASE_URL: string;
  SEPARATION_BACKEND?: string;
  /** Base URL of the self-hosted Audio Separator service. */
  AUDIO_SEPARATOR_URL?: string;
  /** Enables local upload/source routes so the full pipeline can run without remote R2. */
  LOCAL_DEV?: string;
  /** "true" when running locally behind Tailscale Funnel with simulated R2/D1. */
  LOCAL_HOSTING?: string;
  /** owner/name of the yt-dlp fetch model (replicate-yt-audio/); unset disables the fallback. */
  REPLICATE_YT_MODEL?: string;
  /** "replicate-first" in production; defaults to the free in-Worker fetch first. */
  YOUTUBE_FETCH_ORDER?: string;
  /** OpenRouter model slug for the Listening Guy coach; unset disables the assistant. */
  ASSISTANT_MODEL?: string;
  /**
   * JSON array of pre-hashed teacher records seeded into the `teachers` table:
   * [{ username, name, salt, hash, iterations }]. Produced by
   * scripts/hash-teacher-password.mjs — never contains a plaintext password.
   */
  TEACHER_SEED?: string;

  // Secrets (wrangler secret put ...)
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  REPLICATE_API_TOKEN: string;
  REPLICATE_MODEL_VERSION: string;
  AUDIO_SEPARATOR_TOKEN?: string;
  WEBHOOK_SECRET: string;
  CLASS_CODE: string;
  OPENROUTER_API_KEY: string;
};
