# Stateful navigation, resplit placement, and Listening Guy scope

This follow-up builds on production merge 0d54d4c9b387896134f117dff88000c3bc06e452 (PR #93). Publication and exact served revision are recorded separately in the release receipt; local checks alone do not establish deployment.

## User-visible changes

- Signed-out and guest pages hide the complete application menu. “Guest | CUNY Login” appears directly below the CAIL logo.
- Confirmed CUNY accounts see Splitter, Workspace, and Settings. Instructor Console appears only after the existing application instructor endpoint or a current course instructor capability verifies access. Session loss, uncertain identity, late responses and capability revocation cannot keep the link visible.
- Resplit offers “With original split” and “Separate split.” Keeping a result with the original groups the new run inside that recording while preserving its original audio, stems and notes. Both placements persist through account/guest reloads. The selected placement is included in the operation's idempotency fingerprint.
- Resplit checks the actual account and remaining allowance when opened. Guest copy describes browser access without promising a Personal workspace. Listening Guy says “guest turns.”
- Instrument labels stay on one line, with ellipsis and the complete name available in the label tooltip. Recording titles may wrap.
- Guest and Personal Listening Guy calls use the default prompt, including CUNY AI Lab individual access with no course enrollment. Only authorized class work receives that class's teaching amendment. Old teaching-influenced personal guides fail the fingerprint check and are not reused. Existing conversations and prompt history are preserved.
- The global CUNY console retains app administration controls and directs instructors to class workspaces for class instructions.

## Storage and authority

No schema migration, account, credential, role, permission or infrastructure change is needed. Resplit placement uses the existing private operation request record and its existing 90-day content retention. The server verifies ownership, source stem availability, exact source bytes, and workspace compatibility before reserving a split. Attribution is copied from the verified original. Public sharing responses do not expose the private parent association. A removed or unloaded parent never hides the child's standalone record.

The CUNY Cloudflare runtime and alias remain the only release targets. Main/Railway, YouTube parsing/retrieval, provider pins, and disabled Remixer and instrument-discovery flags are unchanged.

## Validation

The automated cases use local synthetic identities, D1/R2 fixtures, and mocked separator/Gateway boundaries; all browser audio is inaudible. No paid prediction, real account change or production data write is part of these tests.

Required evidence includes all backend/type/build checks, the complete Chromium suite, Firefox navigation/playback/resplit checks, source-byte mismatch and ownership rejection, same-request retries, placement reloads, nested renaming, one-at-a-time playback, and guest/Personal/class prompt separation. Final counts and exact commit/tree are recorded in the release receipt.

This work does not validate automatic instrument identification or audio-derived separation. The separate local output-labeling evaluation and the required three-genre × 2/4/6 × initial/resplit real-audio acceptance gate remain unfinished. No synthetic test is counted toward that gate.
