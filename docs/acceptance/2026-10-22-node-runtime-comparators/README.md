# Node 22.23.4 native comparator verification

On October 22, both pinned Linux amd64 comparator workflows completed on
`518bd120b0efda280c27a2e5f2833e12a1a09403`. The previous attempts had stopped at
Archive.org connectivity; the new runs hydrated the same hash-pinned licensed
audio and evaluated the eleven mixes and eight controls without changing the
models, corpus, annotations, thresholds, or production configuration.

- [YAMNet run 39727468114](https://github.com/CUNY-AI-Lab/stem-splitter/actions/runs/39727468114)
- [EfficientAT run 39727470389](https://github.com/CUNY-AI-Lab/stem-splitter/actions/runs/39727470389)

`evidence.json` records the real run and job identities, downloaded ZIP and
contained JSON hashes, native image identities and source pins. Downloaded
reports remain outside Git; no audio is committed. This proves comparison
execution on the patched runner, not teacher acceptance, classifier selection,
or production deployment. The final PR source gate and native jobs are checked
separately at the exact PR tip before merge; this receipt makes no future CI claim.

The August/September canonical receipts remain byte-for-byte historical. Their
loaders verify the recorded workflow blob at the recorded source commit using
Git, rather than comparing it to a later checkout's runtime/workflow revisions.
Missing history, an invalid identity or a mismatched historical hash fails
closed. The CI source gate already fetches full history. Core listening hashes,
artifact pins, explicit abstentions and all teacher/promotion blockers remain
enforced. A source archive without the required Git history cannot validate
these historical receipts.
