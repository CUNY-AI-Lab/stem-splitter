# Student sign-in recovery plan

1. Read the current Stem/Doorway handoff and official CUNY AI Lab recovery guidance.
2. Add public help before identity-service checks, preserving existing safe destination validation.
3. Link help from existing app entry and recovery surfaces; use a deliberate new-tab retry that keeps help available.
4. Verify unavailable identity, unsafe destination filtering, unchanged cookies, retained help tab, null opener, desktop/mobile layout and existing auth flows.
5. Commit to the existing review branch. Production and shared Doorway changes require their own release validation; no CUNY provider changes are part of this patch.

Implemented and locally tested on 2026-10-16. See cloudflare/sso.test.ts and cloudflare/account.spec.mjs.
