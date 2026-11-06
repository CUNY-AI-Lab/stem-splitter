# Dashboard implementation and verification

- Preserve the pending Settings callback/pagination fixes at 35bc776.
- Add own-account instruction/history/preview APIs, atomic revision updates,
  immutable history and private guide caching. Verify isolation, races, guest
  denial, actor changes, class precedence and guide/chat payloads with fixtures.
- Consolidate primary navigation into Splitter, Workspace, Dashboard. Keep
  Account and Listening Guy views within Dashboard; show exact authorized class
  options and app tools without granting individual users instructor access.
- Fix subtitle wrapping/spacing, workspace selector and Run splitter styling.
- Reproduce focus/tab-return layout changes; preserve geometry and drafts during
  checks, conceal failures, clear revoked identity/capabilities and stale replies.
- Audit activity aggregates and dates, correct misleading labels/calculations,
  and use readable metric groups at desktop and phone widths.
- Run affected tests first, then aggregate backend/type/browser/build checks.
  Keep synthetic roles and models distinct from live SSO/provider evidence.
- Commit and preserve the verified candidate. Apply the reviewed additive
  migration before direct Dev release; perform permitted acceptance and promote
  the same source to production. Preserve rollback and exact served assets.
- Instrument isolation remains separately gated; credit research cannot replace
  the required actual-audio 18-case validation.
