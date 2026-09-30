# Sign-in recovery and current progression

Cloudflare STEM Splitter only; preserve shared Doorway, Admission, Gateway,
Railway and the current authentication/authorization contract.

Failed browser sign-in navigation must render a usable page, not raw JSON.
Distinguish expired/invalid callbacks (401), denied Lab access (403), throttling
(429) and unavailable dependencies (503). Keep statuses and JSON API errors.
Use fixed links for fresh login, My account, Lab access and the mixer. Never
echo callback codes/state, provider exceptions or caller-selected redirects.
Pages are private/no-store, no-referrer, not frameable and run no scripts.

Do not claim a stale callback succeeded, replay codes or bypass Admission.
Existing app-session cookies remain untouched by the failure page. Shared
Doorway stale-callback handling stays a separate investigation: bounded logs
show success then stale callbacks but cannot identify the affected person or
establish the first-failure cause.

Reconcile roadmap claims with the deployed baseline and preserve history under
docs/archive. Distinguish local work, deployment and actual student acceptance.
Visitor access remains off until its complete release gates pass.
