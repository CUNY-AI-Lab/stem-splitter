# Provider-bound split catalogue design

**Date** 2026-08-04

**Status** Approved by the request to stop hardcoding the 4 and 6 track choices

## Goal

The split choices a student sees are data. Each choice states its output
contract and carries, per backend, everything needed to run it: the pinned
provider version, the provider input, and the mapping from provider output
names onto contract names. Adding or replacing a choice is a change to that
data, never a change to a backend. The 2 track choice promised by the
2026-07-30 contract becomes reachable in production.

## The catalogue

A choice is an id, an ordered track list, a label, an engine name, and a set of
runners keyed by backend. Presence of a runner means the choice is runnable on
that backend, so the advertised list is a filter over the catalogue rather than
a per-backend branch. Exactly one choice per backend is marked as that
backend's default.

The id is a contract id and never names a provider model. The provider's own
model string lives inside the runner, so a choice can move to a different
provider without rewriting stored jobs.

- `bs_roformer_vocals` — 2 tracks, BS-RoFormer, local separator only.
- `vocals_instrumental` — 2 tracks, Replicate only.
- `htdemucs_ft` — 4 tracks, both backends, the Replicate default.
- `htdemucs_6s` — 6 tracks, both backends.

A backend with no runners advertises no choices and no default, rather than
offering a split that cannot run.

## The two track choice on Replicate

The pinned `ryan5453/demucs` version accepts a `stem` input. Setting it to
`vocals` runs Demucs karaoke mode: the mix is separated in full and the
remaining tracks are summed. The provider returns `vocals` and `no_vocals`, so
the runner renames `no_vocals` to `instrumental`.

This costs the same as the 4 track split. Karaoke mode separates fully before
summing, so it is not cheaper and not faster.

The choice declares the DEMUCS engine because that is what runs. Replacing the
runner with a hosted RoFormer model later changes the runner and the engine
name; the id, the track names, the labels, the frontend, and the track-count
tests do not move.

## Output name mapping

Renaming happens as the first step of the same function that validates the
contract, so it cannot be reordered, skipped, or applied twice. Both the
webhook and the reconciliation path reach that function through a single
ingestion call site.

Names the map does not cover pass through unchanged and are then rejected as
unexpected. A renamed name that collides with a name the provider already
returned is rejected as a repeat. A provider that changes its output names
fails the job with the affected names reported; it never silently mis-maps.

## Frontend

The options endpoint returns only the id, tracks, label, and engine of each
choice. Runner wiring is projected out at the boundary and never reaches the
browser. The browser continues to build its controls from that response and
holds no model identifiers of its own.

## Version pin

The pinned provider version is verified against the catalogue rather than
trusted. The check reads the catalogue directly, so it cannot drift from what
the app actually sends, and confirms that the pinned version still accepts
every model id advertised and every input key sent. It reports a newer
published version as advice, never as a reason to move.

Upstream has already changed shape at source: the current development build of
the separation model serves one model instead of three and renames its output
format input. Moving the pin to the newest published version without running
the check would break the 4 and 6 track choices.

Output track names are not declared in the provider schema. They are recorded
by a probe run against a caller-supplied source and enforced at ingestion.

## Testing

Table-driven contract tests cover all four choices. Catalogue invariants are
asserted directly: unique ids, one default per backend, every rename target is
a track of its own choice, and no rename shadows a track the provider already
returns. The options endpoint is asserted to expose only the four public
fields.

The version guard's comparison is pure and tested offline against both the
schema the catalogue was built against and the known upstream drift, so the
guard itself cannot regress silently.

Browser tests cover the two track split end to end, including the rename and
the stored file names. The paid smoke workflow takes the model as a parameter
and derives its track count from the contract the Worker returned.
