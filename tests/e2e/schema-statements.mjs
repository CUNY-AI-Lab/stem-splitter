/**
 * Split the canonical SQLite schema without breaking multi-statement trigger
 * bodies. The E2E harness sends each complete statement through D1.batch().
 */
export function schemaStatements(sql) {
  const statements = [];
  const current = [];
  let trigger = false;

  for (const rawLine of sql.replace(/--.*$/gm, '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (current.length === 0) trigger = /^\s*CREATE\s+TRIGGER\b/i.test(line);
    current.push(line);

    const complete = trigger ? /^\s*END;\s*$/i.test(line) : /;\s*$/.test(line);
    if (complete) {
      statements.push(current.join('\n').trim());
      current.length = 0;
      trigger = false;
    }
  }

  if (current.length) throw new Error('schema ends with an incomplete SQL statement');
  return statements;
}
