# Student sign-in recovery

Students can be stranded on CUNY's Login Failed page before a callback reaches Doorway or Stem Splitter. The reported provider error is Unable to load Domain/Client profile. That message does not establish the cause or prevalence. An app cannot inspect or replace a cross-origin provider page.

Provide a public /auth/help page independent of identity-service availability, with visible links from the Splitter sign-in area, account page, instructor entry and app-controlled auth failures. Its explicit retry opens /auth/login in a new tab with noopener noreferrer and visible new-tab wording. The help page remains available. Tell users to close a failed attempt before retrying; pending transactions share one cookie.

Preserve only destinations already accepted by safeNext. Do not change the normal login flow, automatically retry, expose callback parameters, clear browser data or change access. Link the official Lab recovery guide and campus help desks. Explain original class invitations, conditional site-data cleanup after a successful private-window test, and guest work remaining in its original browser.

Current source tests and browser fixtures verify this behavior. A completed real CUNY login and production deployment are separate acceptance steps. Future investigation can aggregate Doorway starts with no observed callback; this is not a count of students who abandoned sign-in.
