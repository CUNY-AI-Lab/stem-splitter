# Adaptive musical layers

## Request

Four layers should favor prominent guitar over negligible bass. Auto may choose two, four or six useful musical layers. Labels must describe real estimated source outputs; never rename the old bass channel to guitar. Preserve the complete separated material when selecting fewer displayed layers.

## Approach

The Cloudflare adapter runs the already pinned six-source model, decodes the actual stored estimates, and ranks named sources by full-track stereo RMS. An explicit four-layer request selects three named sources and sums every remaining source into `other`. Auto keeps six for dense material, four for intermediate material, and two for sparse material. Relative energy determines prominence; uniformly quieter mastering must not alter the decision. A -90 dBFS floor excludes numerical silence, while a 24 dB relative boundary stops faint estimated leakage from forcing another layer.

The six-source names are model estimates, not instrument-presence probabilities. No title-based inference or new provider pin is introduced. The private source analyzer and its accepted image/weights remain unchanged.

## Output integrity

Each original estimate belongs to exactly one output. The remainder is a sum, never an average. Every displayed output uses the same MP3 encoder so the composed remainder does not gain a different encoder delay from retained layers. A uniform gain prevents clipping and preserves relative balance. Decode errors, unsupported formats, excessive duration/bytes, nonfinite PCM, missing/duplicate sources, incompatible sample rates and materially different lengths fail closed. Every final MP3 is decoded by the existing trusted validator before publication.

Decode and encoding operate on bounded streaming chunks, not full-track PCM. R2 holds provisional files under the existing ingestion attempt. The final manifest and derived model contract commit together behind the existing operation fence; provisional sources are deleted only after the durable commit. Cancellation, ownership, retries and uncertain commit acknowledgements keep their existing boundaries. Lease checkpoints keep active composition from being reclaimed.

Cloudflare Queues performs adaptive publication with a one-message batch, one concurrent consumer, and a five-minute CPU budget. HTTP polls, webhooks and the minute scheduler enqueue an existing operation ID; they do not encode audio. The consumer retrieves authoritative provider output and uses the same operation fence. Duplicate deliveries cannot publish twice or start another prediction. An expired ingestion marker can be recovered without an open browser. Terminal jobs acknowledge duplicates; transient outages retry. The regular scheduler remains the independent recovery path.

## Compatibility and rollout

A Cloudflare-only flag gates the new four-layer picker and adaptive Auto mode. Legacy four-stem requests and saved jobs retain their original contracts. Explicit two- and six-stem choices remain available. Derived two/four contracts describe completed manifests only and cannot be submitted as provider starts. Root dependency locks and Railway configuration remain unchanged. No database migration is required: the existing routing-request field records adaptive intent, and model/manifest fields commit the resulting contract.

## Evidence and required checks

Seven real app/provider jobs established the original six-example audit and a six-stem Bowie comparison. In the latter, guitar measured about -15 dBFS and bass about -44 dBFS; the selection is vocals/drums/guitar plus the combined remainder. Real outputs are retained outside Git. The standalone streaming codec completed that whole track in the Workerd test runtime in about 29 seconds. Its four MP3s decode and pass gross reconstruction correlation; the provisional residual threshold still produces a warning, which must be retained in reporting.

Before rollout require selector tests, real-codec Workerd tests, production-handler integration tests, browser coverage for adaptive requests/completed names, the normal required CI gates, exact merged-tree identity, and a live authenticated canary. The existing instructor playlist selection and timing remain independent from model selection.
