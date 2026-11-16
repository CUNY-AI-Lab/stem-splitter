# Guest parity implementation and release plan

1. Confirm the source and runtime mismatch: same assets/storage, Tools guest
   disabled and Doorway stripping guest cookies. Preserve all stored tracks.
2. Repair the narrow sign-in notice layout and retain it as recovery for a
   temporarily mismatched gateway/receiver.
3. Add origin-bound guest cookie reissuance and the encrypted top-level handoff.
   Bootstrap at the original host; reject conflicting workspaces without writes.
   Bind replay consumption to the nonce rather than token spelling.
4. Allow anonymous Tools requests into the existing guest authorization layer;
   retain verified member identity and live Admission checks. Restore the
   existing public Turnstile and reporting paths and server usage events.
5. Coordinate Doorway's exact guest route, request cookie and response cookie
   allowlists, with independent review of member downgrade and cookie clears.
6. Run local unit/runtime/browser checks, the class/claim/isolation regression,
   and bounded concurrent completion. Exercise old notes, private conversations,
   audio playback, reloads and a new note visible through the original address.
7. Commit the intended receiver source, run the Dev release gates, complete real
   signed-in Dev acceptance, and release that exact source to production.
   Follow Doorway's main-only release gates separately after receiver readiness.
8. Verify production guest restoration in the existing browser, Turnstile hostname
   coverage and account claim after normal CUNY sign-in. Preserve the original
   guest tab until acceptance. Record exact receipts and remaining limitations.
9. Use protected current class/Gateway records to validate Agustina's roster,
   usage and collaboration. Review Systems Mapping's equivalent boundaries and
   concurrency separately; do not infer live membership from fixture passes.
