// Shared types for the Listening Guy assistant (src/assistant/).

export interface AssistantContext {
  title: string;                                      // jobs.filename — may be an opaque upload name
  model: string;                                      // 'htdemucs_ft' | 'htdemucs_6s'
  stems: { name: string; label: string }[];           // canonical name + class display label
  annotations: { atSeconds: number; text: string }[]; // sorted by time
  durationSec?: number;                               // client-supplied; only the browser knows it
  mode: 'guide' | 'chat';
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** A validated mixer command the browser executes (fire-and-forget). */
export interface AssistantToolCall {
  name: 'solo' | 'set_mute' | 'seek' | 'add_note';
  args: Record<string, unknown>;
}

// --- OpenRouter wire types (OpenAI-compatible chat completions) ----------

export interface WireMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface WireTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface WireCompletion {
  choices?: {
    message?: { content?: string | null; tool_calls?: WireToolCall[] };
    finish_reason?: string;
  }[];
}
