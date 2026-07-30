# Reliable 2, 4, and 6 track output plan

**Design** `docs/superpowers/specs/2026-07-30-reliable-model-output-design.md`

**Date** 2026-07-30

## Task 1

Centralize model labels and expected track names in
`src/separation/options.ts`. Add a validator that orders provider results by the
selected contract and rejects missing, repeated, or unexpected names.

## Task 2

Use the selected job model during ingestion. Validate the complete output set
before downloading files. Reject empty or non-MP3 bodies, remove partial files,
and keep transient network failures retryable.

## Task 3

Return expected track names from job creation and status responses. Build the
frontend choices from the separation-options endpoint and use those names in
the processing state. Replace vague quality claims with the exact outputs.

## Task 4

Remove the default song from the paid smoke workflow. Require the caller to
supply audio they are allowed to test.

## Task 5

Add table-driven 2, 4, and 6 track contract tests. Add Worker and browser
regressions for incomplete output, empty MP3 output, partial-file cleanup,
direct labels, and the normal playback path.

## Task 6

Run the type check, Worker and Python tests, browser suite, package audit,
Wrangler dry run, diff check, and rendered desktop and mobile QA. Commit and
push the verified change to the existing draft pull request.
