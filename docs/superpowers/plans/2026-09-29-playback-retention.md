# Release plan

1. Reproduce the seek-tap timer freeze in the Cloudflare browser harness.
2. Test release/cancel/focus handling, mobile time display, duplicate pending
   starts, cancelled starts and failed-stem group pause.
3. Test 30/60/89-day audio retention and 90/91-day expiry; verify 60-day account
   entries remain visible and 91-day entries do not.
4. Run backend, browser, type and bundle checks; push and merge to the Cloudflare
   release branch, never Railway main.
5. Apply the reviewed 90-day bucket policy and deploy the exact merged tree.
6. Read back live assets, health and lifecycle; distinguish public verification
   and local fixtures from authenticated human playback acceptance.
