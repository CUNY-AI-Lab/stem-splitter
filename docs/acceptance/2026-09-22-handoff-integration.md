# Workshop and institutional model integration

Combined source: `3ede1244c77e8665f604e3ff291db89dd3511915`, PR #10, incorporating
reviewed handoffs #7 and #8. The separate Cloudflare candidate is unchanged.

## Regression fixes

- The CAIL Client receives the Gateway origin; `/v1` belongs to the client path.
  The earlier configured suffix sent requests to `/v1/v1/chat/completions`.
- The default Gateway model is the canonical `glm-5.2` ID. Provider-prefixed
  model configuration fails local readiness. The public Gateway catalog was
  read on September 22 and included this model with function calling.
- Remix tool-only responses receive local narration after tool sanitization,
  preserving one model attempt and the remix solo/mute-only contract.
- Quota refusals retain a stable code and retry hint. Browser errors show only
  canonical UUID support IDs and safe app-owned text, without provider details.

## Completed local evidence

- Both TypeScript gates; all 329 Worker tests and 42 Node adapter tests.
- Four Chrome workshop tests against the real Node host, SQLite and filesystem:
  existing work and labels; native MediaRecorder capture checked with FFmpeg;
  save after clearing; remix tool limits; refusal without replay; and stale-deck
  protection. The recording test also exercises reverse audio and a narrow view.
- Chrome at root and `/stem-splitter/`: invalid class codes reopen the class-code
  dialog; missing/expired institutional identity preserves valid class access.
- Actual Node HTTP/Hono/cail-client to Gateway
  `c5b54beeb3a39db0edad6cae20cccc5fe942414e`, using its frozen dependencies:
  matching identities, public reads, shared guide cache, canonical model ID,
  Registry scope refusal, quota refusal without replay, reset quota-key
  attribution, terminal metadata, correlation and cancellation.
- Native Linux/amd64 analysis-image job `107035561703` in run `35815336561`
  succeeded. Its unchanged artifact was imported and every source hash matched.
  The audio-pipeline validator passes after import; research promotion gates
  retain their existing independent review and rollout requirements.

Provider, Registry, catalog and institutional-edge inputs are controlled
fixtures except the public catalog read noted above. These checks establish
local application and receiver behavior, not deployed sign-in, actual model
quality, paid-provider accounting, or public mount acceptance. Production
deployment, protected CI release and private ingress remain separate work.
