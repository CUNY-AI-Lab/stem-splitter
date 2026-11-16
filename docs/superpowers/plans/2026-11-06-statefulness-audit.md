# Stateful application audit plan

Baseline is production merge `4c115489bb3d9d28847b88ffe47655a5a5504d4b`
(PR #94). Use one isolated worktree and retain the instrument research branch.

1. Reconcile the current user checklist with exact release receipts. Keep the
   older dated checklist intact and keep real-audio acceptance explicitly open.
2. Trace the principal, capabilities, ownership, consent, quotas and lifecycle
   transitions through the four pages and their protected APIs. Add regressions
   for reproducible gaps using existing local authority fixtures.
3. Repair discovered state errors, preserving current identity and role rules,
   source rights, saved work, playback, prompt separation and the narrow layout.
4. Run backend/shared/server checks, three typechecks, the complete Chromium
   suite, affected Firefox tests, legacy/compatibility checks and the production
   dry build. Retain failures and repairs separately from final passes.
5. Publish initially as a draft; verify final CI and merge-tree identity before
   an authorized release. Verify production revision/assets and public layout
   read-only. Retain rollback and document synthetic versus live coverage.
