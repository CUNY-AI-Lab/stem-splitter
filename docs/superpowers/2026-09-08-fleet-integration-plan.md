# Stem Splitter fleet integration implementation plan

1. Pin shared identity 5.2.6, client 6.2.2 and logging 0.6.4.
2. Add fail-closed app/Gateway keyring validation after the existing class check,
   without storing a personal ownership identity on shared resources.
3. Replace the Listening Guy transport, preserving SSE, tools, cache policy,
   correlation, cancellation and trailing usage/errors. Remove local retries,
   provider authorization and provider-body logs.
4. Adapt browser asset/API paths and the active Node adapter to an optional
   prefix while preserving legacy URLs and instructor identity.
5. Add configuration readiness, private exact-version readback, and document the
   serialized CI-only release proposal. Keep separate provider costs explicit.
6. Run auth/transport, actual Node browser, actual local Gateway receiver with a
   synthetic provider, existing adapter/browser gates and Worker dry build.
7. Obtain independent review, fix findings, commit source only. Refresh canonical
   audio build evidence in CI before declaring the complete source gate green.
