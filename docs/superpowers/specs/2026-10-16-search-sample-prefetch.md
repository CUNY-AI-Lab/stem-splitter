# Sample query and background search

The empty Song or link field types an illustrative `jazz piano` query in translucent text, with a visible Tab to accept control. The example remains a placeholder until accepted. Tab or the touch/click control fills the whole query and opens the ordinary results list; importing a track still requires selection and FETCH.

Once account initialization permits search, preload that query through the existing authenticated music search route. Keep the request and any verified streamed batches in memory, reusable for sixty seconds. Acceptance reuses the same in-flight request or finished response. Failure is silent until a user searches, at which point the ordinary search can retry. Limit speculation to one request per page visit and fifteen seconds. No split, import, provider invocation, or persisted search history is introduced.

Typing, composition, dismissal, page hiding, or leaving the search surface cancels pending speculation. Sequence checks keep stale responses out of the active results. Shift-Tab retains native navigation. Reduced-motion users receive the full sample immediately. Preserve result attribution, keyboard selection and existing eligibility checks.

Reference: cadavre-exquis's local ui/corpse.html types placeholder cues at 110ms per character, stops on input, and respects reduced motion. This adaptation holds one sample instead of cycling queries, bounding speculative traffic.
