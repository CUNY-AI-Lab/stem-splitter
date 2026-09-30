# Sign-in recovery implementation

1. Reproduce raw JSON browser failures in tests before editing.
2. Fixed-copy HTML only for HTML auth navigation; preserve JSON/status/cookie/
   PKCE/Admission behavior and all rejection guards.
3. Test expired callbacks, denied admission, missing dependencies, rate limits,
   exceptions, privacy headers and safe links.
4. Render recovery on desktop/mobile and exercise its links.
5. Reconcile current TODO/MIGRATION and account/class docs without erasing history.
6. Run Cloudflare type/security/browser checks and submit the focused branch.
7. Keep the first-login root cause, actual student acceptance and visitor
   Turnstile setup explicitly separate from this recovery-page implementation.
