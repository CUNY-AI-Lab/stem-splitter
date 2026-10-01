# Public split links

In the CUNY app, Copy link enables public listening for that finished split.
Anyone with the link can play, mute, solo, seek, and download its stems without
signing in. Notes, custom labels, Listening Guy content, uploaded originals,
and account identity are not included. Other account splits remain private.

The owner can choose Stop sharing in the split's actions. Shared metadata and
audio stop responding immediately; downloads already made cannot be recalled.
Links expire with the split's existing 90-day lifetime. Public playback does not
invoke Replicate or the model gateway.

Apply migrations 0019 and 0020 to the isolated Cloudflare D1 database before
deploying this release. New sharing uses an exact-owner POST to
`/api/jobs/:id/share`; DELETE revokes it. Public GET routes are narrowly limited
to `/api/shared-jobs/:id` and `/api/shared-jobs/:id/stems/:index`. They recheck
sharing and expiry on every request. No job listing is public.

Old Copy link actions did not record sharing consent. Do not publish every old
job. Re-copy as its owner, or enable only an exact existing link explicitly
authorized by the user. This release authorizes the reported link ending in
`49b9865f-523c-4f8d-bcc2-d2ea5e2be7b2` only.
