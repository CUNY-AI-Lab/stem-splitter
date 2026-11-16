# Browser recovery implementation and release plan

1. Add the proof state machine in shared routes, with additive migration 0035
   and the matching fresh-install schema. Keep existing storage bindings.
2. Add standalone source/destination pages and an allowlisted browser-state
   adapter. Keep proofs, account checks and browser payloads separate.
3. Integrate explicit local recovery into the rack and account UI. Preserve
   immutable archives, destination conflicts and per-copy rack removals.
4. Reuse Stem Select styling for course labels and simplify the class toolbar
   and folder form without changing course IDs or permission decisions.
5. Run the Cloudflare unit/server and browser release suites. Focused pre-release
   checks passed 16 recovery units, 6 recovery browser cases, 5 selector cases,
   and the changed class workflows. Full release results belong in receipts.
6. Commit the reviewed files, apply migration 0035 to Dev, and release through
   the existing local release command. Record exact-source authenticated Dev
   acceptance, including a real playable split.
7. Apply the additive migration to production, promote the same tested commit,
   and check the Tools mount, original address, recovery and changed controls.
   Preserve prior receipts and deployment versions for compatible rollback.

Production-only origin pairing is checked with local two-origin fixtures before
release and with the real production browser after release. Do not present Dev
isolation or local role fixtures as proof of a particular instructor's session.
