# Listening Guide completion target

The target is **99.9% successful eligible requests over a rolling 30-day window**,
reported separately for cues and chat and together. It is a target, not a measured
production result. One failure consumes the error budget for 1,000 eligible
requests. Report sample size and the release boundary with every percentage.

An eligible request has valid current identity and course/job access, valid input,
an available successful-turn reservation, and admission under existing app and
Gateway limits. Count each operation once, not each HTTP retry or provider attempt.
A success requires a complete nonempty answer or validated model-directed mixer
action, successful application persistence/settlement, and a recoverable final
result. An HTTP 200, an SSE `stop` with no output, a provider usage receipt, cached
readback, or an empty substitute is not a newly successful completion.

Count empty answers, truncated answers, invalid tools/output, timeouts, partial
streams, service/database errors and unrecovered overdue operations as failures.
Do not remove provider capacity errors from the eligible denominator: a refused
primary followed by a genuine successful backup is one success; exhausted
capacity fallback is one failure. Auth/input/access rejections, successful-turn
cooldown and configured quota/rate refusals are separately reported exclusions.
Only affirmative user cancellation is excluded as cancellation. A disconnected
stream or ambiguous abort remains a failure unless recovered successfully.

The existing operation ledger is the request-level source. `operation_attempts`
is a separate provider-attempt diagnostic, never the success-rate numerator.
`usage_events` records pre-admission rejection categories. Raw prompts, replies,
student identities and conversation bodies are unnecessary for this accounting.
Inspect fixed error categories and aggregate counts only.

## Bounds and release acceptance

- Cue and chat keep their 500/600-token ceilings and 60-second Gateway deadline.
  Explicit `reasoning: { enabled: false }` leaves the short output budget for the
  answer. This uses the existing model pair and Gateway policy; it does not raise
  spending, call a different provider directly, or guarantee model compliance.
- Empty/truncated accepted output fails without an automatic paid retry. Only
  documented, retryable capacity refusals before acceptance may use the configured
  backup. A primary already in a recorded cooldown is skipped without a request.
- Five successful turns begin a five-minute cooldown. Failed/partial attempts do
  not consume a successful turn. Cached results and same-key recovery are free.
  Attempt/global/guest limits and all identity/privacy rules remain unchanged.
- Before reporting this target as achieved, release the checked code and additive
  migration 0028 through the approved path, establish the measurement start time,
  and complete authorized signed-in cue/chat and browser recovery acceptance.
  Count eligible failures before ledger creation separately; missing coverage or
  absent client readback means end-to-end attainment is unverified, not 100%.

Historical `succeeded` rows are not retroactively certified. Before this repair,
the transport could mark an empty or truncated stream successful even when the
app rejected it. Keep those historical receipts unchanged. Review retained
metadata only, and describe their uncertainty explicitly.

At the October 20 incident check, the prior 24 hours contained one recorded chat
completion and one rejected cue, plus a duplicate-request refusal. The cue used
all 500 completion tokens and produced no usable guide. The earlier chat used all
600 tokens. Reasoning exhausting the small output allowance is a supported
hypothesis; the retained metadata does not contain a finish reason and does not
prove that cause. No student conversation body was read and no real model call
was made during diagnosis.

OpenRouter documents that reasoning shares the output-token budget and supports
the unified disable control:
https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
GLM 5.2 capability metadata:
https://openrouter.ai/api/v1/models/z-ai/glm-5.2/endpoints

## Content-free operational readout

Use `scripts/listening-reliability.sql` with `:since_ms` set to the later of the
verified repair deployment time and 30 days ago, and `:now_ms` to the observation
time. The result deliberately calls historical ledger rows `recorded_successes`.
It also exposes cancellations, cached operations, pending work and failures,
instead of folding them into successful output. Combine it with fixed-category
pre-admission rejection counts and signed-in acceptance before making an SLO
claim. No query reads conversation or result JSON.
