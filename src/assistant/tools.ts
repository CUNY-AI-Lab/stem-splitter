// Mixer tool schemas (OpenAI function-calling format) + server-side validation.
// Tools are fire-and-forget UI commands: the browser executes validated calls
// on the Mixer; nothing runs in the Worker.
import type { AssistantToolCall, WireTool, WireToolCall } from './types';

const MAX_TOOL_CALLS = 6; // prompt asks for ≤3; this is the hard backstop
const MAX_NOTE_CHARS = 200; // matches the annotations route's own cap

export function buildMixerTools(stemNames: string[]): WireTool[] {
  const stem = {
    type: 'string',
    enum: stemNames,
    description: 'Canonical stem name (not the display label).',
  };
  return [
    {
      type: 'function',
      function: {
        name: 'solo',
        description: 'Solo one stem: every other channel is muted so only this one is heard.',
        parameters: { type: 'object', properties: { stem }, required: ['stem'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'set_mute',
        description: 'Mute (true) or unmute (false) one stem.',
        parameters: {
          type: 'object',
          properties: { stem, muted: { type: 'boolean' } },
          required: ['stem', 'muted'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'seek',
        description: 'Jump playback to a moment, in seconds from the start of the song.',
        parameters: {
          type: 'object',
          properties: { seconds: { type: 'number', minimum: 0 } },
          required: ['seconds'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'add_note',
        description:
          'Pin a shared note on the class timeline at a real moment (the current playhead or an existing note time — never a guessed time).',
        parameters: {
          type: 'object',
          properties: {
            seconds: { type: 'number', minimum: 0 },
            text: { type: 'string', maxLength: MAX_NOTE_CHARS },
          },
          required: ['seconds', 'text'],
        },
      },
    },
  ];
}

/** Parse and validate raw provider tool calls into safe mixer commands; drop anything off-schema. */
export function sanitizeToolCalls(
  raw: WireToolCall[],
  stemNames: string[],
  durationSec?: number
): AssistantToolCall[] {
  const out: AssistantToolCall[] = [];
  for (const call of raw.slice(0, MAX_TOOL_CALLS)) {
    const name = call.function?.name;
    let args: unknown;
    try {
      args = JSON.parse(call.function?.arguments || '{}');
    } catch {
      continue;
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) continue;
    const a = args as Record<string, unknown>;

    if (name === 'solo' || name === 'set_mute') {
      if (typeof a.stem !== 'string' || !stemNames.includes(a.stem)) continue;
      if (name === 'set_mute' && typeof a.muted !== 'boolean') continue;
      out.push({ name, args: name === 'solo' ? { stem: a.stem } : { stem: a.stem, muted: a.muted } });
    } else if (name === 'seek' || name === 'add_note') {
      const seconds = clampSeconds(a.seconds, durationSec);
      if (seconds === null) continue;
      if (name === 'add_note') {
        const text = String(a.text ?? '').trim().slice(0, MAX_NOTE_CHARS);
        if (!text) continue;
        out.push({ name, args: { seconds, text } });
      } else {
        out.push({ name, args: { seconds } });
      }
    }
  }
  return out;
}

function clampSeconds(value: unknown, durationSec?: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return durationSec ? Math.min(n, durationSec) : n;
}
