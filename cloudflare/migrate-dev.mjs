// Apply the full schema to the dev database: schema.sql, then every numbered
// migration in order. schema.sql already contains most earlier migrations, so
// "duplicate column" and "already exists" results are expected no-ops; any
// other failure stops the run. The dev database is disposable.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const db = process.env.STEM_DEV_DATABASE || 'stem-splitter-dev';
const benign = /duplicate column name|already exists|UNIQUE constraint failed: sqlite_master/i;
const run = (file) => {
  const result = spawnSync('./node_modules/.bin/wrangler', ['d1', 'execute', db, '--remote', '--yes', '-c', 'wrangler.dev.jsonc', `--file=${file}`], { encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status === 0) { console.log(`applied ${file}`); return; }
  if (benign.test(output)) { console.log(`already present ${file}`); return; }
  console.error(output); console.error(`Stopped at ${file}`); process.exit(result.status ?? 1);
};
run('../schema.sql');
for (const file of readdirSync('../migrations').filter((name) => /^\d{4}-.*\.sql$/.test(name)).sort()) run(`../migrations/${file}`);
console.log(`Schema applied to ${db}.`);
