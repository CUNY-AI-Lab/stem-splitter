# Listening Guy Corpus-Driven Prototype — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Feed the corpus eval output into Listening Guy's system prompt so the coach can ground its guidance in measured audio properties (per-stem RMS, reconstruction quality, quiet-but-valid flags) instead of guessing from a filename.

**Architecture:** The corpus runner (`scripts/run-audio-corpus.mjs`) already produces `eval.json` per entry/model. A new offline script (`scripts/build-corpus-profile.mjs`) reads those eval JSONs and produces a compact "stem profile" — per-stem RMS, low-freq ratio, digital-silence flags, reconstruction correlation, and the corpus `why`/`manualChecks` metadata. The assistant's `AssistantContext` gains an optional `stemProfile` field. The system prompt (`src/assistant/prompt.ts`) gets a new section that surfaces this data to the model, framed as measured ground truth the coach should reference when writing guides and answering student questions.

**Tech Stack:** TypeScript (Hono Worker), Node.js scripts, no new dependencies.

---

## Context

### What exists today

- `src/assistant/` — Listening Guy: `types.ts` (46 lines), `prompt.ts` (120 lines), `tools.ts` (108 lines), `openrouter.ts` (105 lines), `index.ts` (162 lines)
- `AssistantContext` (types.ts:3-10) carries: title, model, stems (name+label), annotations, durationSec, mode
- `buildSystemPrompt()` (prompt.ts:6-110) already has a `WHAT THE SYSTEM KNOWS` block (lines 52-60) that includes title, split, channels, notes, duration
- `contextFromJob()` (index.ts:34-53) builds the context from a JobRow + annotations + durationSec
- `getOrCreateGuide()` (index.ts:62-92) and `runChat()` (index.ts:115-155) are the two call sites
- `scripts/run-audio-corpus.mjs` (247 lines) drives the corpus and saves `eval.json` per entry/model
- `scripts/eval-stems.mjs` (398 lines) produces the JSON report with: per-stem rmsDb, peakDb, digitalSilence, lowFreqRatio, pairwiseCorrelation, reconstruction {summedCorrelation, residualDb}, findings, verdict
- `tests/corpus/corpus.json` has 10 entries with `why` and `manualChecks` per entry

### Codebase verification (reassessed at compile time)

All file line counts confirmed unchanged since planning:
- `src/index.ts`: 704 lines (JobRow at 38-49, annotations DELETE at 355-360, guide route at 367, chat route at 392)
- `src/assistant/types.ts`: 46 lines (AssistantContext at 3-10, WireCompletion at end)
- `src/assistant/prompt.ts`: 120 lines (buildSystemPrompt at 6-110, WHAT THE SYSTEM KNOWS at 52-60, HOW THE SPLITTER at 62)
- `src/assistant/index.ts`: 162 lines (contextFromJob at 34-53, getGuide at 55-60, getOrCreateGuide at 62-92, runChat at 115-155)
- `scripts/run-audio-corpus.mjs`: 247 lines (imports at 17-20, api() at 39-50, eval block at 201-213)
- `schema.sql`: 36 lines (jobs CREATE TABLE at 2-15, labels column at 13)
- `CLAUDE.md`: 131 lines (Listening Guy at 49, migration list at 57, corpus at 122)

Recent changes (commit `b7aa941` + uncommitted) do not touch any of these files or line numbers. The `b7aa941` commit added a "Where this runs" section to CLAUDE.md (lines 72-111), pushing the corpus paragraph to line 122 — which the plan already references correctly. Uncommitted changes are in `public/` (frontend styling) and `src/separation/options.ts` (label text), neither of which the plan touches.

### What the document (Stem Splitter Notes.docx) asks for

Agustina's UX flow: student drops song → splitter generates stems + waveforms → all metadata (stems identified, waveform, chord changes, dynamics) IS FED TO LISTENING GUY → Listening Guy provides prose that tells the student what to listen for. The corpus eval output is the first concrete version of that metadata feed.

### Key constraint

The corpus eval runs offline and produces static JSON. The Worker can't run ffmpeg. So the architecture is: offline script produces a profile JSON, which gets stored alongside the job in D1 and injected into the assistant context at request time. The online path stays cheap.

### Design decision: where the profile lives

A D1 column on jobs (`stem_profile` TEXT). The profile is stable per job — it never changes after stems are produced — and storing it once means every guide generation and chat turn gets it for free without recomputation.

### What the profile contains

```typescript
interface StemProfile {
  stems: {
    name: string;
    rmsDb: number;          // signal level
    peakDb: number;
    digitalSilence: boolean; // true = blank, not just quiet
    lowFreqRatio: number;    // sub-200Hz energy fraction
    quietButValid: boolean;  // quiet but not silent — the orchestral case
  }[];
  reconstruction: {
    summedCorrelation: number;  // how well stems sum back to the mix
    residualDb: number;
  };
  findings: { level: string; code: string; message: string }[];
  // Corpus metadata (only present when the job was run from the corpus runner)
  corpusEntry?: {
    slug: string;
    why: string;
    manualChecks: string[];
  };
}
```

---

## Tasks

### Task 1: Define the StemProfile type

**Objective:** Add the `StemProfile` and `StemMeasurement` interfaces to the assistant types, and extend `AssistantContext` with an optional `stemProfile` field. This is the data contract between the offline eval pipeline and the online prompt.

**Files:**
- Modify: `src/assistant/types.ts` (the only file that changes)

**Why this file, and only this file:** `src/assistant/types.ts` is the canonical home for all shared assistant types (line 1 comment: "Shared types for the Listening Guy assistant"). Every other file in `src/assistant/` imports from it. Adding the type here and nowhere else means `tsc --noEmit` (which scopes to `src/` per `tsconfig.json` line 18: `"include": ["src"]`) will catch any downstream type errors in tasks 3-4, but since no code references `StemProfile` yet, this task is a pure additive type declaration with zero risk of breaking anything.

**Step 1: Add StemMeasurement and StemProfile after the existing types**

The file is 46 lines. `AssistantContext` is at lines 3-10. The file ends at line 46 with the `WireCompletion` interface.

Append the new interfaces after `WireCompletion` (after line 46) at the end of the file. Use `patch` mode='replace' with the last interface as the anchor:

Old string (the end of WireCompletion):
```typescript
export interface WireCompletion {
  choices?: {
    message?: { content?: string | null; tool_calls?: WireToolCall[] };
    finish_reason?: string;
  }[];
}
```

New string (same + new types appended):
```typescript
export interface WireCompletion {
  choices?: {
    message?: { content?: string | null; tool_calls?: WireToolCall[] };
    finish_reason?: string;
  }[];
}

// --- Stem profile (offline eval → prompt enrichment) -----------------------

/** Measured audio properties for one stem, from eval-stems.mjs output. */
export interface StemMeasurement {
  name: string;
  rmsDb: number;
  peakDb: number;
  digitalSilence: boolean;
  lowFreqRatio: number;    // fraction of energy below 200 Hz — distinguishes bass/kick from vocals
  quietButValid: boolean;   // quiet (below -50 dBFS) but not digital silence — the orchestral case
}

/** Compact profile derived from eval-stems.mjs output, stored per job in D1.
 *  Produced by scripts/build-corpus-profile.mjs (offline) and loaded into
 *  AssistantContext at request time. Optional: jobs without a profile still
 *  work — the prompt omits the MEASURED AUDIO PROPERTIES block entirely. */
export interface StemProfile {
  stems: StemMeasurement[];
  reconstruction: {
    summedCorrelation: number;  // how well the stems sum back to the source mix
    residualDb: number;         // residual energy after summing, in dB
  };
  findings: { level: string; code: string; message: string }[];
  /** Only present when the job was run from the corpus runner. */
  corpusEntry?: {
    slug: string;
    why: string;
    manualChecks: string[];
  };
}
```

**Step 2: Add the optional field to AssistantContext**

Patch the `AssistantContext` interface to add `stemProfile?: StemProfile;` as the last field (after `mode`):

Old string:
```typescript
  mode: 'guide' | 'chat';
}
```

New string:
```typescript
  mode: 'guide' | 'chat';
  /** Measured audio properties from the offline eval. Absent for jobs that
   *  were never run through the corpus (most student uploads). When present,
   *  the system prompt includes a MEASURED AUDIO PROPERTIES block. */
  stemProfile?: StemProfile;
}
```

**Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS — the new type is exported but unreferenced, so `tsc --noEmit` sees no new errors. The `tsconfig.json` scopes to `src/` (line 18: `"include": ["src"]`), and `strict: true` is on (line 13), but optional fields with no usages produce no errors.

**Step 4: Commit**

```bash
git add src/assistant/types.ts
git commit -m "feat(assistant): add StemProfile type for corpus-driven context

Add StemMeasurement and StemProfile interfaces to the assistant shared
types. Extend AssistantContext with an optional stemProfile field. This is
the data contract between the offline eval pipeline (eval-stems.mjs →
build-corpus-profile.mjs) and the online prompt enrichment in prompt.ts.
No runtime changes — pure type declaration."
```

---

### Task 2: Build the corpus profile generator

**Objective:** Create a standalone Node script that reads `eval.json` files from a corpus run output directory and produces a compact `profile.json` for each entry/model pair. This script runs offline (not in the Worker) and is the bridge between the eval harness and the prompt.

**Files:**
- Create: `scripts/build-corpus-profile.mjs` (new file)

**Why a standalone script:** The corpus runner (`scripts/run-audio-corpus.mjs`) produces `eval.json` files in a directory like `docs/acceptance/2026-08-04-corpus/<slug>/<model>/eval.json`. The profile needs to be derived from that JSON and either (a) written to disk for manual inspection, or (b) uploaded to the Worker via the API (task 6). Keeping the derivation logic in a standalone script means it can be run independently after a corpus run, and the same `deriveProfile` function will be imported by the corpus runner in task 6 to avoid duplication.

**Step 1: Understand the input shape**

The eval-stems.mjs script (398 lines) produces this JSON structure (lines 345-365):

```json
{
  "label": "folk-duet / vocals_instrumental",
  "source": { "path": "...", "durationS": 256.39, "rmsDb": -12.5, "codec": "mp3", "sampleRate": 44100, "bitrateKbps": 192 },
  "stems": [
    {
      "name": "vocals",
      "durationS": 256.39, "bitrateKbps": 192, "codec": "mp3", "sampleRate": 44100,
      "rmsDb": -14.2, "peakDb": -3.1, "digitalSilence": false, "lowFreqRatio": 0.05
    },
    {
      "name": "instrumental",
      "durationS": 256.39, "bitrateKbps": 192, "codec": "mp3", "sampleRate": 44100,
      "rmsDb": -11.8, "peakDb": -2.5, "digitalSilence": false, "lowFreqRatio": 0.22
    }
  ],
  "pairwiseCorrelation": [ { "a": "vocals", "b": "instrumental", "corr": 0.03 } ],
  "reconstruction": {
    "mode": "complementary",
    "summedCorrelation": 0.9987,
    "residualDb": -28.5,
    "limits": { "minCorr": 0.99, "maxResidualDb": -20 }
  },
  "findings": [
    { "level": "NOTE", "code": "quiet-but-valid", "message": "bass is quiet (-51.2 dBFS) but not blank — correct for this source" },
    { "level": "WARN", "code": "unexpected-signal", "message": "vocals was expected near-silent but is -12.0 dBFS" }
  ],
  "verdict": "PASS"
}
```

The `quietButValid` flag in the profile is derived from the `findings` array: any stem whose name appears in a `quiet-but-valid` finding message gets `quietButValid: true`. This is the eval-stems.mjs convention (line 273-279): a NOTE-level finding with code `quiet-but-valid` and a message that includes the stem name.

**Step 2: Write the script**

Create `scripts/build-corpus-profile.mjs` with this content:

```javascript
// Reads eval.json files from a corpus run and produces compact stem profiles
// that can be fed into Listening Guy's system prompt.
//
//   node scripts/build-corpus-profile.mjs docs/acceptance/<date>-corpus/
//   → writes <dir>/<slug>/<model>/profile.json next to each eval.json
//
// The profile is a subset of the eval report: only the fields the prompt can
// actually use (per-stem levels, quiet-but-valid flags, reconstruction,
// findings, and the corpus entry's why/manualChecks). Everything else
// (pairwise correlation, format checks, bitrate) stays in eval.json.
//
// This script is idempotent: re-running it overwrites the same profile.json
// files. It skips directories without an eval.json (YouTube entries, failed
// runs, the summary/ dir).

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');

// Load corpus.json from the repo root (the script runs from the repo root
// in both the corpus runner and standalone usage).
const corpusPath = resolve('tests/corpus/corpus.json');
const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));

/**
 * Derive a compact StemProfile from an eval-stems.mjs report and the
 * matching corpus entry. This function is the single source of truth for
 * the transformation — the corpus runner (task 6) will import it rather
 * than duplicating the logic.
 *
 * @param {object} evalReport - Parsed eval.json from eval-stems.mjs.
 * @param {object} [corpusEntry] - Matching entry from corpus.json (optional:
 *   non-corpus jobs have no profile, but the function is reusable).
 * @returns {object} A StemProfile-shaped object (not a TypeScript type at
 *   runtime, but structurally identical to src/assistant/types.ts:StemProfile).
 */
export function deriveProfile(evalReport, corpusEntry) {
  const findings = evalReport.findings ?? [];

  const stems = (evalReport.stems ?? []).map((s) => {
    // The eval script emits a NOTE-level finding with code 'quiet-but-valid'
    // whose message includes the stem name (eval-stems.mjs line 273-279).
    // That is the only signal that a quiet track is intentionally quiet
    // rather than blank — the distinction the orchestral entry exists to test.
    const quietButValid = findings.some(
      (f) => f.code === 'quiet-but-valid' && f.message?.includes(s.name)
    );
    return {
      name: s.name,
      rmsDb: s.rmsDb,
      peakDb: s.peakDb,
      digitalSilence: s.digitalSilence,
      lowFreqRatio: s.lowFreqRatio,
      quietButValid,
    };
  });

  return {
    stems,
    reconstruction: {
      summedCorrelation: evalReport.reconstruction?.summedCorrelation ?? 0,
      residualDb: evalReport.reconstruction?.residualDb ?? 0,
    },
    findings,
    ...(corpusEntry
      ? {
          corpusEntry: {
            slug: corpusEntry.slug,
            why: corpusEntry.why,
            manualChecks: corpusEntry.manualChecks ?? [],
          },
        }
      : {}),
  };
}

// --- CLI -------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.url.replace('file://', ''))) {
  // Build a slug → entry map for matching eval dirs to corpus metadata.
  const entries = new Map(corpus.sources.map((e) => [e.slug, e]));

  try {
    await readdir(root);
  } catch {
    console.error(`Directory not found: ${root}`);
    console.error('Usage: node scripts/build-corpus-profile.mjs <corpus-output-dir>');
    process.exit(1);
  }

  let count = 0;
  for (const slugDir of await readdir(root, { withFileTypes: true })) {
    if (!slugDir.isDirectory()) continue;
    const entry = entries.get(slugDir.name);
    if (!entry) continue; // not a corpus slug — skip (e.g. "summary" dir)

    const slugPath = join(root, slugDir.name);
    for (const modelDir of await readdir(slugPath, { withFileTypes: true })) {
      if (!modelDir.isDirectory()) continue;

      const evalPath = join(slugPath, modelDir.name, 'eval.json');
      let evalReport;
      try {
        evalReport = JSON.parse(await readFile(evalPath, 'utf8'));
      } catch {
        continue; // no eval.json — YouTube entry, failed run, or not yet evaluated
      }

      const profile = deriveProfile(evalReport, entry);
      const outPath = join(slugPath, modelDir.name, 'profile.json');
      await writeFile(outPath, JSON.stringify(profile, null, 2) + '\n');
      console.log(`wrote ${outPath}`);
      count++;
    }
  }

  if (count === 0) {
    console.error('No eval.json files found. Run the corpus first:');
    console.error('  CLASS_CODE=<code> node scripts/run-audio-corpus.mjs');
    process.exit(1);
  }
}
```

**Key design decisions:**

1. **`deriveProfile` is exported** — the corpus runner (task 6) will import it via `import { deriveProfile } from './build-corpus-profile.mjs'` rather than duplicating the logic. This is the DRY principle.

2. **The CLI guard** (`if (process.argv[1] ...`) checks whether the script is being run directly (not imported). This uses the standard ESM pattern for dual-purpose scripts. When imported by the corpus runner, only `deriveProfile` is used and the CLI block is skipped.

3. **Graceful skipping** — directories without `eval.json` are silently skipped. This handles: YouTube entries (no eval), failed runs (no eval), the `summary/` dir (not a slug), and any stale dirs.

4. **The corpus entry is optional** in `deriveProfile` — a non-corpus job (student upload) could in theory get a profile without corpus metadata, though that path isn't wired in this plan. The function is designed for reuse.

5. **No new dependencies** — the script uses only `node:fs/promises` and `node:path`, both built into Node 22.5+ (the project's minimum per `package.json` line 36).

**Step 3: Verify the script syntax**

Run: `node --check scripts/build-corpus-profile.mjs`
Expected: no output, exit code 0 (syntax OK)

**Step 4: Verify it produces correct output on a synthetic eval.json**

Run:
```bash
mkdir -p /tmp/corpus-test/folk-duet/vocals_instrumental
cat > /tmp/corpus-test/folk-duet/vocals_instrumental/eval.json << 'EOF'
{
  "label": "folk-duet / vocals_instrumental",
  "source": { "path": "test.mp3", "durationS": 100, "rmsDb": -10, "codec": "mp3", "sampleRate": 44100, "bitrateKbps": 192 },
  "stems": [
    { "name": "vocals", "durationS": 100, "bitrateKbps": 192, "codec": "mp3", "sampleRate": 44100, "rmsDb": -14, "peakDb": -3, "digitalSilence": false, "lowFreqRatio": 0.05 },
    { "name": "instrumental", "durationS": 100, "bitrateKbps": 192, "codec": "mp3", "sampleRate": 44100, "rmsDb": -12, "peakDb": -2, "digitalSilence": false, "lowFreqRatio": 0.22 }
  ],
  "pairwiseCorrelation": [ { "a": "vocals", "b": "instrumental", "corr": 0.03 } ],
  "reconstruction": { "mode": "complementary", "summedCorrelation": 0.9987, "residualDb": -28.5, "limits": { "minCorr": 0.99, "maxResidualDb": -20 } },
  "findings": [
    { "level": "NOTE", "code": "quiet-but-valid", "message": "bass is quiet (-51.2 dBFS) but not blank — correct for this source" }
  ],
  "verdict": "PASS"
}
EOF
node scripts/build-corpus-profile.mjs /tmp/corpus-test
cat /tmp/corpus-test/folk-duet/vocals_instrumental/profile.json
```

Expected: `profile.json` written with stems array, reconstruction, findings, and corpusEntry (slug, why, manualChecks from corpus.json). `vocals` and `instrumental` have `quietButValid: false` because the only `quiet-but-valid` finding mentions `bass`, which is not in this 2-track split.

Clean up: `rm -rf /tmp/corpus-test`

**Step 5: Add an npm script alias**

Add to `package.json` in the `"scripts"` block (after the `"test:corpus"` line, line 23):

```json
"build:profiles": "node scripts/build-corpus-profile.mjs",
```

**Step 6: Commit**

```bash
git add scripts/build-corpus-profile.mjs package.json
git commit -m "feat(corpus): add build-corpus-profile.mjs to distill eval.json into stem profiles

Standalone script that reads eval.json files from a corpus run output
directory and produces compact profile.json files for each entry/model pair.
The deriveProfile function is exported so the corpus runner can import it
(task 6) rather than duplicating the logic.

The profile is a subset of the eval report: per-stem RMS, peak, digitalSilence,
lowFreqRatio, quietButValid flags, reconstruction correlation, findings, and
the corpus entry's why/manualChecks metadata. Everything else stays in
eval.json.

Also adds 'npm run build:profiles' as a convenience alias."
```

---

### Task 3: Extend the system prompt with stem profile data

**Objective:** When `stemProfile` is present in the context, surface it in the system prompt so Listening Guy can ground its guidance in measured audio properties. When absent, the prompt is byte-identical to the current version.

**Files:**
- Modify: `src/assistant/prompt.ts` (the only file that changes)

**Why this file, and only this file:** `src/assistant/prompt.ts` is the canonical home of the Listening Guy system prompt (line 1 comment: "The Listening Guy system prompt (v2)"). `buildSystemPrompt()` (line 6) is the single function that produces the system prompt string. Every guide generation and chat turn calls it. Adding the profile block here means the enrichment flows through both paths (guide and chat) with zero routing changes.

**Step 1: Add the `buildProfileBlock` function**

Add this function after `buildSystemPrompt()` (after line 110, before `buildGuideInstruction` at line 112):

```typescript
/** Render a StemProfile into a prompt section. Absent profile → empty string,
 *  so the prompt is byte-identical to the pre-profile version. */
function buildProfileBlock(profile: import('./types').StemProfile): string {
  const stemLines = profile.stems
    .map((s) => {
      const state = s.digitalSilence
        ? 'BLANK (digital silence — the model produced no audio for this channel)'
        : s.quietButValid
          ? `quiet (${s.rmsDb.toFixed(1)} dBFS) but carries faint signal — correct for this source`
          : `${s.rmsDb.toFixed(1)} dBFS`;
      const bass = s.lowFreqRatio > 0.15 ? 'bass-heavy' : s.lowFreqRatio < 0.02 ? 'bass-light' : 'balanced';
      return `  - ${s.name}: ${state} (${bass}, low-freq ${Math.round(s.lowFreqRatio * 100)}%)`;
    })
    .join('\n');

  const recon = `Reconstruction: stems sum to ${(profile.reconstruction.summedCorrelation * 100).toFixed(1)}% of the source (residual ${profile.reconstruction.residualDb.toFixed(1)} dB).`;

  const findings = profile.findings.length
    ? `\nMeasured findings:\n${profile.findings.map((f) => `  [${f.level}] ${f.code}: ${f.message}`).join('\n')}`
    : '';

  const corpus = profile.corpusEntry
    ? `\nCorpus context for this source:\n  Why it was chosen: ${profile.corpusEntry.why}\n  Listen-tests a human should verify:\n${profile.corpusEntry.manualChecks.map((c) => `    · ${c}`).join('\n')}`
    : '';

  return `MEASURED AUDIO PROPERTIES (from offline analysis — ground truth, not a guess)
Per-stem levels:
${stemLines}
${recon}${findings}${corpus}
Use this data to tell students which channels to trust, which are deliberately quiet, and where to listen for artifacts. Do not repeat these numbers verbatim — translate them into listening guidance.`;
}
```

**Why `import('./types').StemProfile` instead of a top-level import:** The file currently imports only `AssistantContext` from `./types` (line 4). Using an inline `import('./types').StemProfile` type reference avoids touching the import statement, keeping the diff to two hunks (the function + the template insertion).

**Step 2: Add the `profileBlock` variable and inject it into the template**

Inside `buildSystemPrompt()`, after the `catchAllGuidance` conditional (after line 37), add:

```typescript
  const profileBlock = ctx.stemProfile
    ? buildProfileBlock(ctx.stemProfile)
    : '';
```

Then in the template string, insert between the end of `WHAT THE SYSTEM KNOWS` and the start of `HOW THE SPLITTER ACTUALLY BEHAVES`:

Old string:
```
You cannot hear the audio itself — ground everything in this data plus what you
GENUINELY know about the song or its genre.

HOW THE SPLITTER ACTUALLY BEHAVES (be honest about this)
```

New string:
```
You cannot hear the audio itself — ground everything in this data plus what you
GENUINELY know about the song or its genre.
${profileBlock ? `\n${profileBlock}\n` : ''}
HOW THE SPLITTER ACTUALLY BEHAVES (be honest about this)
```

The conditional `${profileBlock ? ... : ''}` ensures the prompt is byte-identical when no profile is present — no blank line insertion, no whitespace change.

**Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 4: Verify prompt is unchanged when profile is absent**

Run:
```bash
node --experimental-strip-types -e "
import { buildSystemPrompt } from './src/assistant/prompt.ts';
const ctx = {
  title: 'Test', model: 'htdemucs_ft',
  stems: [{ name: 'vocals', label: 'vocals' }, { name: 'other', label: 'other' }],
  annotations: [], mode: 'guide'
};
const prompt = buildSystemPrompt(ctx);
if (prompt.includes('MEASURED AUDIO PROPERTIES')) {
  console.error('FAIL: profile block present without stemProfile');
  process.exit(1);
}
console.log('OK: no profile block when stemProfile is absent');
"
```
Expected: `OK: no profile block when stemProfile is absent`

**Step 5: Verify prompt includes profile data when present**

Run:
```bash
node --experimental-strip-types -e "
import { buildSystemPrompt } from './src/assistant/prompt.ts';
const ctx = {
  title: 'Test', model: 'htdemucs_ft',
  stems: [{ name: 'vocals', label: 'vocals' }, { name: 'other', label: 'other' }],
  annotations: [], mode: 'guide',
  stemProfile: {
    stems: [
      { name: 'vocals', rmsDb: -14, peakDb: -3, digitalSilence: false, lowFreqRatio: 0.05, quietButValid: false },
      { name: 'other', rmsDb: -10, peakDb: -2, digitalSilence: false, lowFreqRatio: 0.2, quietButValid: false }
    ],
    reconstruction: { summedCorrelation: 0.97, residualDb: -14 },
    findings: [{ level: 'NOTE', code: 'quiet-but-valid', message: 'bass is quiet' }]
  }
};
const prompt = buildSystemPrompt(ctx);
console.log(prompt.includes('MEASURED AUDIO PROPERTIES') ? 'OK: header present' : 'FAIL: missing header');
console.log(prompt.includes('-14.0 dBFS') ? 'OK: stem level present' : 'FAIL: missing stem level');
console.log(prompt.includes('97.0%') ? 'OK: reconstruction present' : 'FAIL: missing reconstruction');
"
```
Expected: all three `OK` lines

**Step 6: Commit**

```bash
git add src/assistant/prompt.ts
git commit -m "feat(assistant): surface stem profile in Listening Guy system prompt

Add buildProfileBlock() to render a StemProfile as a MEASURED AUDIO
PROPERTIES section in the system prompt. When ctx.stemProfile is absent
(the common case for student uploads), the prompt is byte-identical to
the pre-profile version — no blank lines, no whitespace changes.

The block tells the coach: per-stem RMS, which stems are BLANK vs
quiet-but-valid, reconstruction correlation, eval findings, and the
corpus entry's why/manualChecks when present. The prompt instructs the
coach to translate these numbers into listening guidance, not repeat
them verbatim."
```

---

### Task 4: Wire stemProfile into contextFromJob

**Objective:** Load the stored stem profile from D1 when building the assistant context, so it flows into the prompt. This is the online-side wiring: `contextFromJob` gets an optional `stemProfile` parameter, `getStemProfile` loads it from D1, and both `getOrCreateGuide` and `runChat` call it.

**Files:**
- Modify: `src/assistant/index.ts` (the only file that changes)

**Why this file, and only this file:** `src/assistant/index.ts` is the orchestrator for all assistant logic (line 1 comment: "Listening Guy orchestrators"). It already has `contextFromJob()` (line 34), `getOrCreateGuide()` (line 62), and `runChat()` (line 115) — all three are the exact sites that need the profile. The D1 query lives here (not in `src/index.ts`) because the assistant module owns its own data access, matching the existing pattern where `getGuide()` does its own `SELECT FROM guides` (line 56).

**Step 1: Add StemProfile to the imports from ./types**

Old string (line 7):
```typescript
import type { AssistantContext, AssistantToolCall, ChatTurn, WireMessage } from './types';
```

New string:
```typescript
import type { AssistantContext, AssistantToolCall, ChatTurn, StemProfile, WireMessage } from './types';
```

**Step 2: Add stemProfile parameter to contextFromJob**

Old string (lines 34-53):
```typescript
export function contextFromJob(
  row: AssistantJob,
  annotations: AssistantAnnotation[],
  durationSec: number | undefined,
  mode: 'guide' | 'chat'
): AssistantContext {
  const labels = row.labels ? (JSON.parse(row.labels) as Record<string, string>) : {};
  const stems = (row.stems ? (JSON.parse(row.stems) as { name: string }[]) : []).map((s) => ({
    name: s.name,
    label: labels[s.name] || s.name,
  }));
  return {
    title: row.filename,
    model: row.model ?? 'htdemucs_ft',
    stems,
    annotations: annotations.map((a) => ({ atSeconds: a.at_seconds, text: a.text })),
    durationSec,
    mode,
  };
}
```

New string:
```typescript
export function contextFromJob(
  row: AssistantJob,
  annotations: AssistantAnnotation[],
  durationSec: number | undefined,
  mode: 'guide' | 'chat',
  stemProfile?: StemProfile
): AssistantContext {
  const labels = row.labels ? (JSON.parse(row.labels) as Record<string, string>) : {};
  const stems = (row.stems ? (JSON.parse(row.stems) as { name: string }[]) : []).map((s) => ({
    name: s.name,
    label: labels[s.name] || s.name,
  }));
  return {
    title: row.filename,
    model: row.model ?? 'htdemucs_ft',
    stems,
    annotations: annotations.map((a) => ({ atSeconds: a.at_seconds, text: a.text })),
    durationSec,
    mode,
    stemProfile,
  };
}
```

**Step 3: Add getStemProfile helper**

Add after `getGuide()` (after line 60), before `getOrCreateGuide()`:

```typescript
/** Load the stored stem profile for a job, or null if none was uploaded. */
export async function getStemProfile(env: Env, jobId: string): Promise<StemProfile | null> {
  const row = await env.DB.prepare('SELECT stem_profile FROM jobs WHERE id = ?')
    .bind(jobId)
    .first<{ stem_profile: string | null }>();
  if (!row?.stem_profile) return null;
  try {
    return JSON.parse(row.stem_profile) as StemProfile;
  } catch {
    return null;
  }
}
```

This follows the exact pattern of `getGuide()` (lines 55-60): a single `SELECT` via `env.DB.prepare().bind().first()`, return `null` if the row or column is absent. The `try/catch` around `JSON.parse` handles corrupted JSON gracefully.

**Step 4: Wire getStemProfile into getOrCreateGuide**

In `getOrCreateGuide()` (line 71), replace:

```typescript
  const ctx = contextFromJob(row, annotations, durationSec, 'guide');
```

With:

```typescript
  const profile = await getStemProfile(env, row.id);
  const ctx = contextFromJob(row, annotations, durationSec, 'guide', profile);
```

**Step 5: Wire getStemProfile into runChat**

In `runChat()` (line 122), replace:

```typescript
  const ctx = contextFromJob(row, annotations, durationSec, 'chat');
```

With:

```typescript
  const profile = await getStemProfile(env, row.id);
  const ctx = contextFromJob(row, annotations, durationSec, 'chat', profile);
```

**Step 6: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 7: Verify the existing test suite still passes**

Run: `npm run test:worker`
Expected: PASS — existing tests in `tests/separation.test.mts` and `tests/youtube.test.mts` don't touch the assistant module.

**Step 8: Commit**

```bash
git add src/assistant/index.ts
git commit -m "feat(assistant): load stem_profile from D1 into assistant context

Add getStemProfile() to read the stored profile JSON from the jobs
table. Thread an optional StemProfile through contextFromJob into both
getOrCreateGuide and runChat, so every guide generation and chat turn
gets the profile for free when one exists.

The D1 query follows the same pattern as getGuide(): a single SELECT
via prepare().bind().first(), returning null when the column is absent
or the JSON is corrupted. No schema migration is needed in this file —
the column is added in task 5."
```

---

### Task 5: Add the D1 column and an API to store the profile

**Objective:** Add a `stem_profile` TEXT column to the jobs table, create a migration file for production D1, update the canonical schema.sql for Railway, and add a class-code-gated POST endpoint that stores a profile for a finished job.

**Files:**
- Modify: `schema.sql` (canonical schema, applied on every Railway boot)
- Create: `migrations/0004-stem-profile.sql` (production D1 migration)
- Modify: `src/index.ts` (add the POST route + extend JobRow)
- Modify: `package.json` (add db:migrate:4 scripts)

**Why three schema files:** The project has a dual-database architecture (CLAUDE.md line 57, server/CLAUDE.md lines 52-56):
- **Railway (Node host):** `schema.sql` is applied on every boot via `server/index.ts` line 65. It is idempotent (`CREATE TABLE IF NOT EXISTS`). This is the canonical schema and already contains every column from prior migrations.
- **Production (Cloudflare D1):** Numbered migration files in `migrations/` are applied once via `npm run db:migrate:N` (package.json lines 27-32). The production D1 instance was created before some columns existed, so `ALTER TABLE` is needed for existing tables.

Both must be updated. `schema.sql` gets the new column in the `CREATE TABLE` so fresh installs (and Railway reboots) have it. `migrations/0004-stem-profile.sql` gets the `ALTER TABLE` so the existing production D1 gets it.

**Step 1: Update schema.sql**

Add `stem_profile TEXT` to the `CREATE TABLE jobs` statement, after the `labels` column (line 13):

Old string (schema.sql lines 13-14):
```sql
  labels TEXT,                         -- JSON map: { "<stem name>": "<display label>" }
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
```

New string:
```sql
  labels TEXT,                         -- JSON map: { "<stem name>": "<display label>" }
  stem_profile TEXT,                   -- JSON StemProfile from offline eval (src/assistant/types.ts); null for student uploads
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
```

**Step 2: Create the production migration**

Create `migrations/0004-stem-profile.sql`:

```sql
-- Additive migration: stem_profile column for Listening Guy enrichment.
-- Applied to production D1 via: npm run db:migrate:4
-- (schema.sql already has this column for fresh installs and Railway reboots.)
ALTER TABLE jobs ADD COLUMN stem_profile TEXT;
```

**Step 3: Add npm scripts for the migration**

Add to `package.json` in the `"scripts"` block, after the `db:migrate:3:local` line (line 32):

```json
"db:migrate:4": "wrangler d1 execute stem-splitter --remote --file=migrations/0004-stem-profile.sql",
"db:migrate:4:local": "wrangler d1 execute stem-splitter --local --file=migrations/0004-stem-profile.sql",
```

**Step 4: Extend JobRow in src/index.ts**

Old string (lines 38-49):
```typescript
interface JobRow {
  id: string;
  filename: string;
  source_key: string;
  status: string;
  external_id: string | null;
  stems: string | null;
  error: string | null;
  created_at: string;
  model: string | null;
  labels: string | null;
}
```

New string:
```typescript
interface JobRow {
  id: string;
  filename: string;
  source_key: string;
  status: string;
  external_id: string | null;
  stems: string | null;
  error: string | null;
  created_at: string;
  model: string | null;
  labels: string | null;
  stem_profile: string | null;
}
```

**Step 5: Add the POST route**

In `src/index.ts`, insert after the annotations DELETE route (line 360) and before the `--- listening guy` comment (line 362):

```typescript
// Store the offline-computed stem profile for a job. Class-code-gated because
// it's an admin action that costs nothing but should not be student-writable.
// The profile only exists for finished jobs — there are no stems to measure
// until separation completes.
app.post('/api/jobs/:id/stem-profile', requireClassCode, async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
  if (!row) return c.json({ error: 'Job not found' }, 404);
  if (row.status !== 'done') {
    return c.json({ error: "Stems aren't ready yet." }, 409);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'Request body must be a JSON object' }, 400);
  }

  // Minimal shape validation: must have a non-empty stems array. The full
  // StemProfile shape (src/assistant/types.ts) is not validated server-side
  // because this endpoint is admin-only and the corpus runner is the only
  // caller. A malformed profile stored here would cause getStemProfile() to
  // return null (JSON.parse in a try/catch), so the prompt degrades gracefully.
  if (!Array.isArray(body.stems) || body.stems.length === 0) {
    return c.json({ error: 'stems must be a non-empty array' }, 400);
  }

  await c.env.DB.prepare('UPDATE jobs SET stem_profile = ? WHERE id = ?')
    .bind(JSON.stringify(body), id)
    .run();
  return c.json({ ok: true });
});
```

**Route pattern notes:** This follows the exact pattern of the labels PUT route (lines 308-333): `requireClassCode` middleware, `SELECT * FROM jobs WHERE id = ?`, status check, body parse with `.catch(() => null)`, validation, `UPDATE jobs SET ... WHERE id = ?`, return `{ ok: true }`. POST is used because this is a create-or-replace operation on a sub-resource, matching the annotations POST (line 336) pattern.

**Step 6: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 7: Commit**

```bash
git add schema.sql migrations/0004-stem-profile.sql src/index.ts package.json
git commit -m "feat(api): add stem_profile column and POST endpoint to store it

Add stem_profile TEXT column to the jobs table:
- schema.sql: added to CREATE TABLE for fresh installs and Railway reboots
- migrations/0004-stem-profile.sql: ALTER TABLE for existing production D1
- package.json: db:migrate:4 and db:migrate:4:local scripts

Add POST /api/jobs/:id/stem-profile route (class-code-gated):
- Validates job exists and is done
- Validates body has non-empty stems array
- Stores the full JSON blob; getStemProfile() in the assistant module
  degrades gracefully if the JSON is malformed (returns null, prompt
  omits the MEASURED AUDIO PROPERTIES block)

Existing Railway databases need a one-time ALTER TABLE since
schema.sql uses CREATE TABLE IF NOT EXISTS. Run:
  railway run npx wrangler d1 execute stem-splitter --local \\
    --command 'ALTER TABLE jobs ADD COLUMN stem_profile TEXT;'
"
```

---

### Task 6: Extend the corpus runner to upload profiles

**Objective:** After running the corpus eval and producing `eval.json`, the runner derives a profile and uploads it to the deployed Worker via `POST /api/jobs/:id/stem-profile`, so the guide/chat paths can use it. This closes the loop: offline eval → stored profile → prompt enrichment.

**Files:**
- Modify: `scripts/run-audio-corpus.mjs` (the only file that changes)

**Step 1: Add the import for deriveProfile**

At line 18, after the existing `readFile` import, add:

Old string (line 18):
```javascript
import { mkdir, readFile, writeFile } from 'node:fs/promises';
```

New string:
```javascript
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { deriveProfile } from './build-corpus-profile.mjs';
```

This is the DRY payoff from task 2: the `deriveProfile` function is imported rather than duplicated. The import path is relative (`./build-corpus-profile.mjs`), which works because both scripts live in `scripts/` and the runner is executed from the repo root.

**Step 2: Add the profile upload after eval**

Modify the `if (entry.kind === 'file')` block (lines 201-213):

Old string:
```javascript
    if (entry.kind === 'file') {
      const verdict = await evalStems({
        label: `${entry.slug} / ${model}`,
        source: resolve(entry.source),
        stems,
        expect: entry.expect?.[model],
        complementary: stems.length === 2,
        jsonPath: `${dir}/eval.json`,
      });
      summary.push({ slug: entry.slug, model, verdict });
    } else {
      summary.push({ slug: entry.slug, model, verdict: 'STEMS_ONLY' });
    }
```

New string:
```javascript
    if (entry.kind === 'file') {
      const verdict = await evalStems({
        label: `${entry.slug} / ${model}`,
        source: resolve(entry.source),
        stems,
        expect: entry.expect?.[model],
        complementary: stems.length === 2,
        jsonPath: `${dir}/eval.json`,
      });
      summary.push({ slug: entry.slug, model, verdict });

      // Upload the stem profile so Listening Guy can ground its guidance in
      // measured audio properties. The profile is derived from the eval JSON
      // that evalStems() just wrote. Failures are non-fatal — the corpus run
      // still completes, and the prompt degrades gracefully without a profile.
      try {
        const evalReport = JSON.parse(await readFile(`${dir}/eval.json`, 'utf8'));
        const profile = deriveProfile(evalReport, entry);
        await api(`/api/jobs/${created.id}/stem-profile`, {
          method: 'POST',
          body: JSON.stringify(profile),
        });
      } catch (e) {
        console.log(`    ⚠ profile upload failed: ${e.message}`);
      }
    } else {
      summary.push({ slug: entry.slug, model, verdict: 'STEMS_ONLY' });
    }
```

**Key design decisions:**

1. **Per-job, not per-entry:** The profile is uploaded for each model's job, not once per entry. This is correct: each model produces different stems with different per-stem RMS levels, and the profile describes what THIS job's stems look like.

2. **`created.id` is the job ID:** Set at line 181 (`const created = await createJob(entry, model)`), used at lines 182 and 196. The profile upload uses the same ID.

3. **Non-fatal on failure:** The `try/catch` logs a warning and continues. The corpus run is about eval, not profile upload. If the Worker is down or the route doesn't exist yet (pre-migration), the eval results are still valid.

4. **YouTube entries get no profile:** The `else` branch (`STEMS_ONLY`) is unchanged. YouTube entries skip eval (no source to compare against), so there's no eval.json to derive a profile from.

**Step 3: Verify the script syntax**

Run: `node --check scripts/run-audio-corpus.mjs`
Expected: no output, exit code 0

**Step 4: Verify the dry-run still works (dead host)**

Run:
```bash
CLASS_CODE=x BASE=http://127.0.0.1:1 CORPUS_OUT=/tmp/corpus-dry \
  node scripts/run-audio-corpus.mjs 2>&1 | grep -E "══|SKIPPED|summary|⚠" | head -20
```

Expected: identical to pre-change output. The `continue` at line 186 skips the profile upload when the job fails, so the dead-host output has no new lines.

**Step 5: Commit**

```bash
git add scripts/run-audio-corpus.mjs
git commit -m "feat(corpus): upload stem profiles to Worker after eval

After evalStems() writes eval.json for a file entry, derive the
StemProfile (via the shared deriveProfile function from
build-corpus-profile.mjs) and POST it to /api/jobs/:id/stem-profile.

The upload is non-fatal: if the Worker is down or the route doesn't
exist yet, the corpus run continues and the eval results are still
valid. The warning is visible in the console.

YouTube entries get no profile (no eval.json to derive from). The
prompt degrades gracefully without one.

DRY: deriveProfile is imported from build-corpus-profile.mjs rather
than duplicated in the runner."
```

---

### Task 7: Test the end-to-end prompt enrichment

**Objective:** Verify that when a stem profile is present, the system prompt includes the measured audio data, and when it's absent, the prompt is unchanged. These are unit tests that run without network calls, without D1, and without a deployed Worker.

**Files:**
- Create: `tests/assistant-prompt.test.mts` (new file)

**Why this file name and location:** The project's test runner is `npm run test:worker` (package.json line 25), which runs `node --experimental-strip-types --test tests/*.test.mts`. The glob `tests/*.test.mts` matches files directly under `tests/` with the `.test.mts` extension. The existing tests are `tests/separation.test.mts` and `tests/youtube.test.mts` — both follow this pattern. A `tests/unit/` subdirectory would NOT be picked up by the glob.

**Why `.mts` not `.mjs`:** The existing tests use `.mts` (module TypeScript). The `--experimental-strip-types` flag requires `.mts` for ESM with TypeScript syntax. The test imports from `../src/assistant/prompt.ts`, so it must be `.mts`.

**Step 1: Write the test file**

Create `tests/assistant-prompt.test.mts`:

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSystemPrompt } from '../src/assistant/prompt.ts';
import type { AssistantContext, StemProfile } from '../src/assistant/types.ts';

const baseCtx: AssistantContext = {
  title: 'Test Song',
  model: 'htdemucs_ft',
  stems: [
    { name: 'vocals', label: 'vocals' },
    { name: 'drums', label: 'drums' },
    { name: 'bass', label: 'bass' },
    { name: 'other', label: 'other' },
  ],
  annotations: [],
  mode: 'guide',
};

const profile: StemProfile = {
  stems: [
    { name: 'vocals', rmsDb: -12, peakDb: -3, digitalSilence: false, lowFreqRatio: 0.05, quietButValid: false },
    { name: 'drums', rmsDb: -8, peakDb: -1, digitalSilence: false, lowFreqRatio: 0.3, quietButValid: false },
    { name: 'bass', rmsDb: -52, peakDb: -30, digitalSilence: false, lowFreqRatio: 0.01, quietButValid: true },
    { name: 'other', rmsDb: -10, peakDb: -2, digitalSilence: false, lowFreqRatio: 0.15, quietButValid: false },
  ],
  reconstruction: { summedCorrelation: 0.97, residualDb: -14 },
  findings: [{ level: 'NOTE', code: 'quiet-but-valid', message: 'bass is quiet but not blank' }],
};

test('prompt without stemProfile omits the MEASURED AUDIO section', () => {
  const prompt = buildSystemPrompt(baseCtx);
  assert.ok(
    !prompt.includes('MEASURED AUDIO PROPERTIES'),
    'should not contain profile block when stemProfile is absent'
  );
});

test('prompt with stemProfile includes per-stem levels', () => {
  const prompt = buildSystemPrompt({ ...baseCtx, stemProfile: profile });
  assert.ok(prompt.includes('MEASURED AUDIO PROPERTIES'), 'missing profile header');
  assert.ok(prompt.includes('-12.0 dBFS'), 'missing vocals level');
  assert.ok(prompt.includes('quiet (-52.0 dBFS) but carries faint signal'), 'missing quiet-but-valid note');
  assert.ok(prompt.includes('97.0%'), 'missing reconstruction correlation');
});

test('prompt with stemProfile includes corpus context when present', () => {
  const ctxWithCorpus: AssistantContext = {
    ...baseCtx,
    stemProfile: {
      ...profile,
      corpusEntry: {
        slug: 'orchestral',
        why: 'No vocals, no drums — the quiet-but-valid trap.',
        manualChecks: ['The job must reach done, not failed.'],
      },
    },
  };
  const prompt = buildSystemPrompt(ctxWithCorpus);
  assert.ok(prompt.includes('Corpus context for this source'), 'missing corpus context header');
  assert.ok(prompt.includes('quiet-but-valid trap'), 'missing corpus why text');
  assert.ok(prompt.includes('The job must reach done'), 'missing manual check');
});

test('prompt with digital-silence stem flags it as BLANK', () => {
  const ctxWithBlank: AssistantContext = {
    ...baseCtx,
    stemProfile: {
      ...profile,
      stems: [
        { name: 'vocals', rmsDb: -Infinity, peakDb: -Infinity, digitalSilence: true, lowFreqRatio: 0, quietButValid: false },
        ...profile.stems.slice(1),
      ],
    },
  };
  const prompt = buildSystemPrompt(ctxWithBlank);
  assert.ok(prompt.includes('BLANK'), 'missing BLANK flag for digital-silence stem');
});
```

**Key design decisions:**

1. **Four tests, not two:** Added corpus context inclusion and the BLANK flag for digital silence.
2. **`node:test` and `node:assert/strict`:** Matches the existing test pattern (separation.test.mts lines 1-2).
3. **Imports use `.ts` extensions:** Required by tsconfig.json line 9 and `--experimental-strip-types`.
4. **`StemProfile` imported as `import type`:** Erased at runtime by `--experimental-strip-types`.
5. **No mocking needed:** `buildSystemPrompt` is a pure function. No D1, no OpenRouter, no network.
6. **The `-Infinity` edge case:** This is what `eval-stems.mjs` line 117 produces for silent tracks (`dB(0)` returns `-Infinity`).

**Step 2: Verify the test runs and passes**

Run: `npm run test:worker`
Expected: all tests pass (existing + new)

**Step 3: Verify typecheck still passes**

Run: `npm run typecheck`
Expected: PASS — test files under `tests/` are not in `tsconfig.json`'s `include` (line 18: `"include": ["src"]`), so `tsc` doesn't check them. They're validated by `test:worker` at runtime.

**Step 4: Commit**

```bash
git add tests/assistant-prompt.test.mts
git commit -m "test(assistant): verify stem profile enrichment in system prompt

Four unit tests for buildSystemPrompt with and without a stemProfile:
- absent profile: no MEASURED AUDIO section (byte-identical to v2)
- present profile: per-stem levels, quiet-but-valid flags, reconstruction
- corpus context: why + manualChecks rendered when corpusEntry is set
- digital silence: BLANK flag for all-zero stems

Pure-function tests: no D1, no OpenRouter, no network. Uses the
project's existing node:test + node:assert/strict pattern. File is
.mts to match the tests/*.test.mts glob in test:worker."
```

---

### Task 8: Update CLAUDE.md documentation

**Objective:** Document the stem profile pipeline in CLAUDE.md so future agents understand the data flow: offline eval → derived profile → stored in D1 → injected into the prompt.

**Files:**
- Modify: `CLAUDE.md` (the only file that changes)

**Step 1: Append to the Listening Guy paragraph (line 49)**

Old string (end of line 49):
```
don't let assistant code paths become load-bearing for playback.
```

New string:
```
don't let assistant code paths become load-bearing for playback. The assistant context may include an optional `stem_profile` (JSON in `jobs.stem_profile`, uploaded via `POST /api/jobs/:id/stem-profile` from the corpus runner); when present, the system prompt includes a `MEASURED AUDIO PROPERTIES` block — per-stem RMS, quiet-but-valid flags, reconstruction correlation — so the coach grounds its guidance in measured audio properties rather than guessing from a filename. Absent for student uploads; the prompt is byte-identical without it.
```

**Step 2: Update the migration list (line 57)**

Old string:
```
already applied: `:2` labels/annotations, `:3` guides).
```

New string:
```
already applied: `:2` labels/annotations, `:3` guides, `:4` stem_profile).
```

**Step 3: Append to the corpus paragraph (line 122)**

Old string (end of line 122):
```
That needs two models per entry — a one-model YouTube entry measures nothing.
```

New string:
```
That needs two models per entry — a one-model YouTube entry measures nothing. The runner also derives a `StemProfile` from each `eval.json` (via `scripts/build-corpus-profile.mjs`, or `npm run build:profiles`) and uploads it to the job via `POST /api/jobs/:id/stem-profile`; when present, this flows into Listening Guy's system prompt as a `MEASURED AUDIO PROPERTIES` block. This is the first concrete instance of the metadata feed the July 8 planning notes describe — the coach grounding its guidance in measured audio properties rather than guessing from a filename.
```

**Step 4: Verify the CLAUDE.md still reads correctly**

Run: `read_file(path='CLAUDE.md', offset=49, limit=5)` and `read_file(path='CLAUDE.md', offset=57, limit=1)` and `read_file(path='CLAUDE.md', offset=122, limit=3)`

Check that the three insertion points read naturally in context.

**Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document stem profile pipeline for Listening Guy

Three additions to CLAUDE.md:
- Listening Guy paragraph: mention optional stem_profile enrichment
  (MEASURED AUDIO PROPERTIES block in the system prompt)
- Migration list: add :4 stem_profile to the 'already applied' list
- Corpus paragraph: describe the profile derivation and upload flow,
  and connect it to the July 8 planning notes' metadata feed vision"
```

---

## Open Questions

1. **YouTube entries**: They skip eval (no source to compare against), so they get no profile. Should a lighter profile (just per-stem RMS via ffmpeg, no reconstruction) be computed for YouTube jobs? The prompt gracefully handles `stemProfile === undefined`, so this is an enhancement, not a blocker.

2. **Profile for non-corpus jobs**: A student who uploads a song directly (not through the corpus) won't have a profile. Should the Worker compute a lightweight profile (just per-stem RMS) at ingestion time? This would require ffmpeg in the Worker, which isn't available. Alternative: a separate post-processing step triggered by the webhook. Out of scope for this plan.

3. **Profile staleness**: The profile is stored once and never updated. If stems are re-processed (model change), the profile becomes stale. Should the `stem_profile` column be cleared when a job is re-queued? Yes — add `stem_profile = NULL` to the re-queue path. This is a one-line fix in `src/index.ts` wherever jobs are re-queued.

## Verification

After all tasks:
1. `npm run typecheck` — passes
2. `npm run test` — passes (existing tests + new prompt test)
3. `node --check scripts/build-corpus-profile.mjs` — no syntax errors
4. `node --check scripts/run-audio-corpus.mjs` — no syntax errors
5. Manual: run the corpus against a dead host, verify the runner doesn't crash on the profile upload step (it should warn and continue)