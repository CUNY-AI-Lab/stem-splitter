# v3.2 Railway audio-analysis acceptance

This directory binds the first private production deployment of the v3.2
role-v4 analyzer to exact Railway scope, source commit, successful CI run,
resource limits, private-network readiness, authorization boundary, real-audio
result, restart result, and flag-only rollback drill.

The accepted service has no public domain or persistent volume. The live
application returned to `SERVER_AUTO_ENABLED=false` and `SERVER_AUTO_MODE=off`
after the drill, and no separation-provider call was made by the rollback test.
Instrument discovery remained unconfigured in the analyzer and disabled in the
application throughout.

`evidence.json` is validated by
`scripts/lib/railway-audio-analysis-acceptance.mts`. The promotion manifest may
claim Railway resource and rollback acceptance only while this exact evidence,
the frozen rollback source, compiled role-classifier pin, and source-scope pin
all validate.

This acceptance clears entry into server-Auto shadow evaluation. It does not
itself authorize authoritative routing or provision the separately blocked
instrument-discovery candidate.
