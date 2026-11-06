import type { Env } from './env.ts';
import type { AppPrincipal } from './identity.ts';
import { jobPermission } from './classroom/access.ts';
import { OperationError } from './reliability/ledger.ts';

export interface ResplitPlacement {
  parentJobId: string;
  stem: string;
  placement: 'with_original' | 'separate';
}
function placement(value: unknown): ResplitPlacement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  return typeof v.parentJobId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v.parentJobId) &&
    typeof v.stem === 'string' && v.stem.length > 0 && v.stem.length <= 128 &&
    (v.placement === 'with_original' || v.placement === 'separate')
    ? { parentJobId: v.parentJobId, stem: v.stem, placement: v.placement } : null;
}
/** Only expose the small validated lineage record, never the operation request. */
export function storedResplit(request: string | null | undefined): ResplitPlacement | null {
  try { return request ? placement(JSON.parse(request).resplit) : null; } catch { return null; }
}

/** Compare bounded streams without buffering two potentially 100MB files. */
async function sameBytes(a: ReadableStream<Uint8Array>, b: ReadableStream<Uint8Array>, size: number): Promise<boolean> {
  const readers = [a.getReader(), b.getReader()];
  let chunks: Uint8Array[] = [new Uint8Array(), new Uint8Array()], offsets = [0, 0], ends = [false, false], total = 0;
  const deadline = Date.now() + 30000;
  const timer = setTimeout(() => { for (const reader of readers) void reader.cancel().catch(() => {}); }, 30000);
  try {
    while (Date.now() < deadline) {
      await Promise.all(readers.map(async (reader, index) => {
        if (offsets[index] === chunks[index].length && !ends[index]) {
          const result = await reader.read();
          ends[index] = result.done;
          chunks[index] = result.value ?? new Uint8Array();
          offsets[index] = 0;
        }
      }));
      if (ends.some(Boolean)) return ends.every(Boolean) && total === size;
      const length = Math.min(...chunks.map((chunk, index) => chunk.length - offsets[index]));
      total += length;
      if (total > size) return false;
      for (let index = 0; index < length; index++) if (chunks[0][offsets[0] + index] !== chunks[1][offsets[1] + index]) return false;
      offsets = offsets.map(offset => offset + length);
    }
    return false;
  } finally { clearTimeout(timer); await Promise.all(readers.map(reader => reader.cancel().catch(() => {}))); }
}

export async function validateResplit(env: Env, principal: AppPrincipal, value: unknown, uploadKey?: string): Promise<ResplitPlacement | undefined> {
  if (value === undefined) return;
  const result = placement(value);
  if (!result || !uploadKey) throw new OperationError('invalid_resplit', 400, 'Choose a saved stem and where to keep its resplit.');
  const permission = await jobPermission(env, principal, result.parentJobId);
  if (!permission?.owner) throw new OperationError('resplit_unavailable', 404, 'The original split is unavailable to this account.');
  if (result.placement === 'with_original' && permission.courseId !== (principal.courseId ?? null)) {
    throw new OperationError('resplit_workspace_changed', 409, 'Choose the original split’s workspace to keep this resplit with it.');
  }
  const parent = await env.DB.prepare("SELECT stems FROM jobs WHERE id=? AND status='done' AND NOT EXISTS(SELECT 1 FROM run_deletions WHERE job_id=jobs.id)")
    .bind(result.parentJobId).first<{ stems: string }>();
  let stems: { name: string; key: string }[] = [];
  try { stems = JSON.parse(parent?.stems ?? '[]'); } catch {}
  const stem = Array.isArray(stems) ? stems.find(stem => stem.name === result.stem) : null;
  if (!stem || typeof stem.key !== 'string' || !stem.key.startsWith('stems/')) throw new OperationError('resplit_unavailable', 404, 'The selected stem is no longer available.');
  const [original, uploaded] = await Promise.all([env.AUDIO.get(stem.key), env.AUDIO.get(uploadKey)]);
  if (!original || !uploaded || original.size <= 0 || original.size > 100 * 1024 * 1024 || original.size !== uploaded.size ||
      !await sameBytes(original.body, uploaded.body, original.size)) {
    await Promise.all([original?.body.cancel().catch(() => {}), uploaded?.body.cancel().catch(() => {})]);
    throw new OperationError('resplit_audio_changed', 409, 'The uploaded audio does not match the selected stem. Close the dialog and try again.');
  }
  return result;
}
