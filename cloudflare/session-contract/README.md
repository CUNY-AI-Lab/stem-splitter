# Review-only session transport module

Vendored from `@cuny-ai-lab/worker-session-contract` 0.0.0-review.1 in the SSO review bundle. Keep `session.js` and `session.d.ts` byte-identical between apps until an org package home is approved. No new registry credentials or runtime services are needed.

These helpers reject ambiguous browser input. They do not authenticate, verify JWTs, check Admission, revoke sessions, choose instructor rights, or own storage. Retain the app adapter and existing CAIL identity SDK. Structural validation must never become authorization. The review bundle contains package tests, adoption guidance and the cross-app test matrix.
