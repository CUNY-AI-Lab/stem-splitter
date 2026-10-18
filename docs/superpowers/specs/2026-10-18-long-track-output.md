# Long-track output and queue capacity

The previous adaptive path used one invocation to validate six provider files,
measure them again, peak-scan the remainder, encode every displayed track in
JavaScript, and validate the outputs. A five-minute audited run consumed about
209 CPU seconds against a 300-second invocation limit. Publication held the
single provider slot; a failed invocation repeated the downloads and encoding.

## Required behavior

- A fifteen-minute input must fit within bounded individual invocations and
  bounded memory, including Auto's five-source remainder.
- A completed provider prediction releases its processing slot immediately.
  Provider concurrency is capped at two globally and one per subject; unknown
  starts and provider cooldowns still consume/block that capacity.
- Native LAME WebAssembly replaces the JavaScript encoder. Selection, global
  gain, MP3 format, 192 kbps bitrate, and consistent encoder delay stay intact.
- D1 records each completed source download/measurement, plan, peak/gain pass,
  encoded output, and validated output. Each queue delivery runs one stage.
- One output stage may run at a time. Five decoder heaps plus an encoder already
  reserve about 96 MiB; increasing output parallelism would risk the 128 MiB
  isolate memory limit. Compressed output uses a 5 MiB multipart buffer.
- Every published file passes full decode validation. Output preparation uses
  no extra provider prediction and settles the existing allowance once.
- Output work continues without a browser. A D1 outbox suppresses repeated
  enqueues and repairs lost sends. A 60-second renewable lease fences stale
  runners; hard deadlines and cancellation remain authoritative.
- The UI distinguishes PREPARING TRACKS from GPU separation. It exposes no
  provider URLs, source identities, or journal internals.

## Release boundaries

Use the existing Cloudflare runtime, queue, DLQ, D1 and R2. There is no new
service, provider model, secret, schema migration or Railway change. The frozen
root analyzer dependency inputs stay unchanged. The import Worker is unaffected.

Provider time and cold starts remain external constraints. Two is an application
ceiling, not a promise of provider entitlement. Rate limits still back off.
Perceptual quality remains a separate evaluation from valid MP3 output.
