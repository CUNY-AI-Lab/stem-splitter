# Provider-bound split catalogue plan

**Design** `docs/superpowers/specs/2026-08-04-provider-bound-catalogue-design.md`

**Date** 2026-08-04

## Task 1

Give each catalogue row its runners. Add the runner types, the per-backend
runner map, and the default marker to `src/separation/options.ts`. Replace the
per-backend branch in the advertised list with a filter over the catalogue.
Project the advertised list down to id, tracks, label, and engine so runner
wiring cannot reach the browser. Fold the output-name rename into the first
step of the contract validator.

## Task 2

Make the backends read the runners. Replicate resolves its runner, reads the
named version secret, and builds its input from the runner instead of holding a
model default and output literals of its own. The local separator resolves its
profile the same way. Both fail with the choice named when no runner exists.

## Task 3

Add the two track Replicate choice: Demucs karaoke mode with the vocals
isolation input and the rename from the summed remainder onto the instrumental
contract name. Confirm the browser needs no change, because the track order and
the channel colour already cover instrumental.

## Task 4

Guard the version pin. Keep the comparison pure and separate from the network
call so it can be tested offline. Verify that the pinned version still accepts
every advertised model id and every input key sent, and that the isolation
input still accepts vocals. Report a newer published version as advice with the
command to vet it, never as an instruction to move.

## Task 5

Add the output-name probe. It takes a caller-supplied source, submits one
prediction built from the catalogue, prints the raw output object rather than
only its non-empty keys, and reports whether the rename map satisfies the
contract. It contains no default song.

## Task 6

Extend the tests. Cover all four choices in the table-driven contract tests.
Assert the catalogue invariants, the public projection of the options endpoint,
the rename, the loud failure on an unmapped name, and the empty advertisement
for a backend with no runners. Test the version guard offline against both the
current schema and the known upstream drift. Add the two track browser flow and
the free production checks for the advertised track counts, the preserved
default, the absent runner wiring, and the new id passing the allowlist.

## Task 7

Run the probe once against audio you are allowed to test and confirm the
observed output names match the rename map before shipping. Then run the type
check, Worker tests, browser suite, version guard, and Wrangler dry run; deploy;
and run the free smoke checks against the deployment. Update `CLAUDE.md`,
`README.md`, and the schema comment, including the replacement of the blind
version bump instruction with the guarded procedure.
