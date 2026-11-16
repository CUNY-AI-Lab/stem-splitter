# Browser workspace recovery and class controls

## Requested behavior

Keep guest access and previously created work available at the Tools address.
Server records stay in the existing Worker database and audio bucket. Browser-only
preferences, rack entries, playback positions and drafts require an explicit,
same-browser transfer from the original production address.

The destination reviews a local copy before applying it. The original remains
unchanged. Drafts and pending requests are archived, never automatically submitted.
Account changes cancel work in progress. Current permissions are checked again
before applying or restoring anything; revoked class work is omitted.

## Boundaries

- Only the configured original production origin and Tools destination can pair.
  Development stays separate. Short-lived, single-use proofs bind the current
  subject, actor kind and origin pair; the server stores no browser draft text.
- Both popup origin and window identity are verified. Network and popup waits
  are bounded. Browser data is allowlisted and validated before storage.
- Recovery copies are immutable, with exact stored-byte verification. Destination
  changes are preserved. Removing an imported rack item records an exclusion
  scoped to that account and recovery copy so it does not reappear after reload.
- The source browser profile must still have the data. This does not recover
  deleted browser storage or data held only in another tab's JavaScript memory.
  Account-level server work is still governed by ordinary access rules.

## Class interface

Use separate Folders/Splits navigation and creation actions. Make class folder
opens a dismissible form; refresh preserves a draft while permission remains.
The empty state reads “No folders yet.” Shared course labels omit the section
suffix, remain one line, and grow to fit within the available width. Narrow
screens truncate the visible label while preserving its accessible name.

## Acceptance

Exercise cross-origin member and guest recovery, account-change races, revoked
course access, immutable storage, quota failure, and removed rack entries. Check
keyboard and narrow-screen selectors, folder cancel/refresh behavior, and a real
signed-in split with playable audio on Dev before the same production release.
