# Default split choice: Auto

The October 25 user request applies to the main 2/4/6/Auto splitting selector.
When the existing adaptive or authoritative Auto route is enabled, new/unset
sessions select Auto and omitted-model requests reserve the same existing Auto
route. No provider pin, model implementation, feature flag, allowance or spending
setting changes. The adaptive route already uses the pinned six-source prediction;
this change selects its existing Auto output rule by default.

The separation-options API adds `defaultChoice: "auto"` for enabled server Auto.
`defaultModel` remains the concrete fallback profile; it must not become a model
id that cannot be sent to a provider. Shadow/off routes retain their existing
concrete defaults, including the flags-off response shape.

The browser prefers an existing valid selection or a valid explicit choice saved
under `stem-split-choice-v1` before using the server default. Storage writes occur
only on a choice change; blocked/corrupt/outdated storage cannot prevent loading.
Uploading/starting another job or resetting the source-search form preserves that
choice. Fresh/unset sessions use Auto. Already queued operations are not rewritten.

Regression coverage checks adaptive, authoritative-only, shadow and off request
handling; API/default agreement; concrete provider fallback; explicit two/four
choices; unchanged queued requests; no provider attempts from choosing a default;
fresh Auto selection, reset/next-job retention, saved reload and invalid preference
fallback. The existing four-layer browser test explicitly chooses four now.

This increment follows the deployed PR #75 repair (production merge 3dc6ea3 and Dev
integration 03290f8) and contains no Commons/ccMixter integration. Preserve Dev's
newer c88cd9dd layout/activity commits when integrating it for a Dev release.
No claim that Auto is live should be made before exact version/asset verification.
