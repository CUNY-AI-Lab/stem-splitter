# Crate first; original Listening Guy

The single Crate precedes the Remixer shelf/deck in static HTML. When Remixer
is disabled, it moves above Splitter upload controls. Its disclosure still
opens/closes, and mobile labels wrap without clipping.

Remove the former Remixer assistant panel, challenge button, client state,
styles, model prompt variant and narrowed toolset. Restore the original
Splitter guide/chat policy and tools; reject unsupported chat modes. Track
the policy change through its version, fingerprint and prompt changelog.

This hotfix targets the existing isolated Cloudflare candidate and its bound
Worker address. It changes no Railway deployment, SSO or provider secret,
database, storage policy, or feature flag. It is not a production cutover.
The broader raw-audio Remixer workflow remains separate work.

This supersedes the assistant and Crate-placement sections of the September 1
workshop design/plan; those files are historical, not current product direction.
