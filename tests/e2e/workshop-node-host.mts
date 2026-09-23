// Real Node host + SQLite/filesystem, seeded with existing classroom work.
// Only OpenRouter is substituted; no model call or separation is performed.
import { readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { SqliteD1 } from '../../server/d1.ts';
import { FsR2Bucket } from '../../server/r2.ts';

const dataDir = process.env.DATA_DIR!;
const db = new SqliteD1(join(dataDir, 'stem-splitter.sqlite'));
db.applySchema(await readFile('schema.sql', 'utf8'));
db.applyNodeMigrations();
const audio = new FsR2Bucket(join(dataDir, 'audio'));
for (const id of ['workshop-source', 'workshop-second']) {
  const stems = [];
  for (const name of ['vocals', 'drums', 'bass', 'other']) {
    const key = `stems/${id}/${name}.mp3`;
    await audio.put(key, await readFile(`tests/fixtures/audio/${name}.mp3`), {
      httpMetadata: { contentType: 'audio/mpeg' },
    });
    stems.push({ name, key });
  }
  await db.prepare(`INSERT INTO jobs (id, filename, source_key, status, model, stems, labels)
    VALUES (?, ?, ?, 'done', 'htdemucs_ft', ?, ?)`).bind(
    id, `${id}.wav`, `uploads/${id}/source.wav`, JSON.stringify(stems),
    JSON.stringify({ vocals: 'Class lead voice' }),
  ).run();
  await db.prepare('INSERT INTO annotations (id, job_id, at_seconds, text) VALUES (?, ?, 1, ?)')
    .bind(`${id}-note`, id, 'Keep the class note.').run();
}

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input) !== 'https://openrouter.ai/api/v1/chat/completions') return nativeFetch(input, init);
  const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
  await appendFile(join(dataDir, 'provider-requests.jsonl'), `${JSON.stringify(body)}\n`);
  if (body.messages.at(-1)?.content.includes('Wait while')) await setTimeout(1500);
  const events = [
    { choices: [{ delta: { content: 'Try the vocals alone.' }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [
      { index: 0, id: 'solo-1', type: 'function', function: { name: 'solo', arguments: '{"stem":"vocals"}' } },
      { index: 1, id: 'seek-1', type: 'function', function: { name: 'seek', arguments: '{"seconds":1}' } },
      { index: 2, id: 'note-1', type: 'function', function: { name: 'add_note', arguments: '{"seconds":1,"text":"Unwanted note"}' } },
    ] }, finish_reason: 'tool_calls' }] },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  });
};
await import('../../server/index.ts');
