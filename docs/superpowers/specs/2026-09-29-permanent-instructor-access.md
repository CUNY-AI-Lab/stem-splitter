# Instructor access without an end date

The administrator must be able to keep a selected instructor's STEM Splitter
role without a calendar cutoff. This is an app-local role, not permanent CUNY
AI Lab membership or Lab administrator authority.

- Account → Manage access offers an explicit **No end date** checkbox for
  Instructor. New role selections retain the date-required default.
- The API accepts explicit `expiresAt: null` or a valid future date. Omitted,
  malformed or past instructor dates fail without changing the account.
- `app_users.role_expires_at IS NULL` means no end date only for the instructor
  role. Existing defaults remain student. No schema migration is needed.
- Administrator authorization, non-self targeting, optimistic revisions, same
  origin, immutable audit history, fresh Admission checks, account disabling
  and ownership boundaries remain unchanged. Instructor does not grant admin.
- Preview the existing production grants before release; do not activate an
  unexplained preexisting instructor row with a null expiry.
- Scope is the Cloudflare branch and its canonical alias. Do not deploy Railway
  or bundle unfinished saved-split and daily-allowance work into this change.

Acceptance: finite and permanent grants save and survive a fresh browser reload;
instructor tools appear for the target, admin tools remain hidden, invalid
updates fail, and expired/revoked Admission or disabled app access still denies.
