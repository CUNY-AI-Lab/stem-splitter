# Direct workspace access release plan

1. Remove the proposed browser-copy interface, entry links and unused proof API.
   Migration 0035 was applied only to Dev; leave its unused table intact. It was
   never applied to production and is not required by this release.
2. Make the existing guest handoff automatic and quiet, preserving signed-in
   identity and both sides of any distinct-workspace conflict. Prevent loops
   after failed handoffs and fall back to ordinary app startup.
3. Reuse selector styling for compact class names. Separate class view tabs from
   account navigation hooks, and simplify the folder form and empty-state text.
4. Run Cloudflare unit, auth, guest, class and browser release checks. Commit with
   the confirmed user identity; release Dev and verify a real playable split.
5. Promote the same commit to production, verify both addresses and ordinary
   guest/signed-in navigation. Record actual results and any remaining limits.

Earlier local commits contained a recovery-review proposal. The user explicitly
rejected that interface before this production release; do not restore it.
