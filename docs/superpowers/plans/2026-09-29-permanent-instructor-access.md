# Permanent instructor access implementation

1. Isolate the change from the verified Cloudflare production branch, preserving
   unfinished quota and account-recovery work in its original checkout.
2. Add explicit null-expiry validation and instructor authorization semantics;
   retain revision checks and the existing immutable audit trigger.
3. Add No end date to Manage access; keep permanent grants deliberate and load
   the saved state when the selected account is refreshed.
4. Test identity expiry/revocation/disable, no admin escalation, ownership,
   malformed and missing expiry, self-target denial, stale revisions, audit,
   desktop/mobile UI and save/reload using synthetic local identities.
5. Run the existing Worker, server, Cloudflare, browser, type, dependency and
   frozen-audio gates. Review only this diff and merge into
   `codex/cloudflare-migration`, never Railway main.
6. Release the exact tested merged tree using `cloudflare/wrangler.jsonc`;
   preserve bindings and secrets. Verify canonical runtime/assets and access.
7. In the administrator's existing signed-in browser, select only the identified
   instructor, save No end date, then reload and read back. The administrator
   already has instructor capabilities; do not downgrade or widen Lab authority.
