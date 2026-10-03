# Implementation and verification

1. Verify live Railway/Cloudflare naming behavior and authoritative Lab navigation destinations.
2. Add account resources and consistent credit/retention footers; update asset versions.
3. Normalize legacy catalogue/classifier copy at the rendering boundary, preserving underlying contracts.
4. Save instrument labels only after server confirmation; retain read-only public sharing.
5. Exercise owner rename/reload, rejected writes, public-link privacy, account roles, and responsive layout through the existing Cloudflare browser harness. Rerun legacy and Auto browser tests for revised copy.
6. Restore streamed single-range audio responses and attachment downloads on both owner and public routes, with HEAD, If-Range, invalid ranges, expiry and privacy regression checks.
7. Give Firefox CI a verified PulseAudio null sink; bound dependency installation without weakening playback assertions.
8. Include these changes in PR #20, preserving its mixer hardening. Require all CI gates, merge only into `codex/cloudflare-migration`, compare the tested and merged trees, then deploy an isolated archive through `cloudflare/wrangler.jsonc`. Verify real public audio and current assets in fresh Chrome and Firefox contexts. Do not touch Railway.
