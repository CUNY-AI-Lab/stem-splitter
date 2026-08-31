# v3.2 Railway server-Auto shadow acceptance

This bundle records the first live production shadow acceptance for the
private `audio-analysis` service. The app remained on the frozen concrete
2/4/6 separation catalogue, while the server analyzer listened to the stored
bytes for upload, Internet Archive, and YouTube sources. Shadow decisions were
persisted but never overrode the paid separation choice.

The controlled outage deployment deliberately pointed the app at an
unreachable analyzer. That job still completed with the four frozen core stems
and a structured `analysis_unavailable` fallback. The analyzer URL was then
restored to the Railway private hostname, the replacement app deployment
reached terminal `SUCCESS`, and a fresh upload completed with a non-degraded
role-v4 decision.

The four JPEG files are real screenshots captured from the CUNY production
application with the Codex in-app browser. They are not generated or altered
application mockups. The strict validator binds each JPEG by SHA-256 and binds
the live job, deployment, audience-redaction, resource, and rollback evidence
in `evidence.json`.

This acceptance clears the `shadow` and audience-guard evidence gates only. It
does not select or provision an instrument-discovery classifier, enable query
isolation, or make server Auto authoritative for students.
