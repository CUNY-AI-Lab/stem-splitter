# Cloudflare-only implementation sequence

1. Restore the original Listening Guy policy, remove Remixer chat/UI, bump the
   governed prompt version, and preserve the removal in regression tests.
2. Add bounded authenticated raw Archive delivery without changing the existing
   split contract. Gate on CAIL + Remixer, enforce rights/size/source identity.
3. Connect preview/add controls, keep splitting optional, and put the single
   Crate ahead of the deck. Preserve safe multi-source rights checks.
4. Add song naming and bounded recording duration; keep takes after clearing,
   guard asynchronous source/reverse work, and retain attribution-bearing exports.
5. Verify in workerd and headless Chrome with provider-boundary fixtures:
   Crate -> two layers -> settings -> recording -> ZIP -> clear -> download.
   Check mobile layout, original instructor prompt workflow, and access gates.
6. Implement the remaining clip/arrangement/project/export stages in the paired
   specification, then perform live signed-in acceptance before promotion.

No Railway mutation, database migration, provider key change, feature-flag
promotion, remote push or deployment belongs to steps 1-5.
