# Listening Guide system prompt changelog

The fixed system prompt lives in `src/assistant/prompt.ts`. Its exported
`SYSTEM_PROMPT_VERSION` is stored beside every runtime instructor amendment.
The instructor API also fingerprints a deterministic rendered preview, so a
text change is traceable even if a version bump is accidentally omitted.

## 2026-08-08.1

- Established the current Listening Guide v3 prompt as the versioned baseline.
- Kept the code-owned persona, turn-taking pedagogy, anti-fabrication rules,
  timestamp safeguards, student-data boundary, and mixer tool rules fixed.
- Added a read-only, formatted instructor view that opens at the end of the
  fixed prompt and can jump to the top.
- Added a separate appended-instructions editor with required change notes,
  monotonic optimistic concurrency, base/effective SHA-256 fingerprints, and
  append-only revision history.

## Updating the fixed prompt

A fixed-prompt change is complete only when the same commit:

1. edits `src/assistant/prompt.ts`;
2. increments `SYSTEM_PROMPT_VERSION`;
3. adds a dated entry here explaining the behavioral change;
4. updates prompt and instructor-console tests;
5. passes unit, browser E2E, and Wrangler dry-run gates.

Runtime instructor edits do not belong in this file. Their changelog is stored
in `assistant_prompt_revisions`, keyed back to this code history through the
base version and fingerprint.
