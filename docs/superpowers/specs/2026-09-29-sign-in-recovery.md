# Sign-in recovery and current progression

Cloudflare STEM Splitter only; preserve shared Doorway, Admission, Gateway,
Railway and the current authentication/authorization contract.

Failed browser sign-in navigation must render a usable page, not raw JSON.
Distinguish expired/invalid callbacks (401), denied Lab access (403), throttling
(429) and unavailable dependencies (503). Keep statuses and JSON API errors.
Use one state-appropriate action: CUNY Login when signed out, Request Lab access
when denied, or Retry when verification is unavailable. Never show CUNY Login
alongside My account. An invalid browser callback with a separately verified
current app session redirects to Splitter without an intermediate page. An
already signed-in visit to /auth/login uses the fixed allowlisted destination.
Never
echo callback codes/state, provider exceptions or caller-selected redirects.
Pages are private/no-store, no-referrer, not frameable and run no scripts.

Redirecting an existing session is navigation, not accepting the stale callback.
Do not replay codes or bypass Admission. Cookie presence alone is insufficient:
Doorway must resolve the current session and the returned app identity must pass
signature, issuer and audience verification. Unavailable checks never redirect.
Existing app-session cookies remain untouched by the failure page. Shared
Doorway stale-callback handling stays a separate investigation: bounded logs
show success then stale callbacks but cannot identify the affected person or
establish the first-failure cause.

Reconcile roadmap claims with the deployed baseline and preserve history under
docs/archive. Distinguish local work, deployment and actual student acceptance.
Visitor access remains off until its complete release gates pass.
