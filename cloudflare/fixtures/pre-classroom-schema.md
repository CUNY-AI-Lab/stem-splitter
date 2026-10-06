# Migration baseline fixture

`pre-classroom-schema.sql` is byte-for-byte `schema.sql` from Stem Splitter
commit `e1918da3cb6fc37f9715d4cd143af5a5c6c880c6`, before migration 0021.

SHA-256: `daa7333b25af106c1b2db9cf71bcee70601ed59c51642ca4ff8a0c6eb3f13362`

The classroom upgrade test checks this digest before adding synthetic private
rows and applying migration 0021. Keeping the baseline here makes the upgrade
test deterministic in shallow CI checkouts, without Git history or network
access. This is a test fixture, not a schema to apply to a live database.
