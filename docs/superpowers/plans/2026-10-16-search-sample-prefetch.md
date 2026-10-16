# Implementation and validation

1. Add the animated empty-field sample and accessible Tab/touch acceptance control to the existing source field.
2. Add one bounded speculative search with streamed-batch replay, in-flight reuse and a sixty-second freshness limit. Suppress interactive authentication only for speculative reads.
3. Preserve ordinary search, source selection, import submission and cancellation behavior; refresh asset versions.
4. Validate with the local Cloudflare guest browser harness: completed and partial preload reuse, animation, reduced motion, mobile, native navigation, stale responses, silent failures and ordinary search/import regressions. Confirm zero job submissions/provider starts when accepting a query.
5. Review desktop/mobile screenshots and diff. Release is separate from this local implementation.
