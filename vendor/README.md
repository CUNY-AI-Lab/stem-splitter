# CAIL identity dependency

`cuny-ai-lab-cail-identity-5.2.5.tgz` is a Bun-repacked copy of the installed
MIT-licensed `@cuny-ai-lab/cail-identity` 5.2.5 distribution used by the CAIL
Admission service. It includes its LICENSE, source, contracts and built verifier.
The package registry rejected this session's credentials; no token is embedded.

- Upstream: https://github.com/CUNY-AI-Lab/cail-identity
- Verified upstream `v5.2.5` tag: `f9ed2c184676fc6db8e9191a576ccdd701023f9d`
- Repacked archive SHA-256: `c83649d1500de2770726a71cf3498f713f3f6da619ad2af141a5ca2f10aa55ae`
- `cloudflare/bun.lock` pins the repacked archive integrity and transitive packages.

This is not claimed to be the byte-identical registry tarball or a reproducible
rebuild from the tag. Before final production promotion, restore authorized
registry access or independently verify/rebuild the distribution from the tag.
Do not replace this verifier with home-grown JWT parsing or trust display headers.
