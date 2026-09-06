# Parallel CAIL Worker candidate

Authority: the 2026-09-06 request authorizes this migration while retaining
Railway production until acceptance and stress testing. The detailed design
and ordered release gates live in `../../../MIGRATION.md`.

## Required behavior

- Preserve the shared audio/prompt contracts and existing model pins.
- Use independent candidate D1/R2 resources and a dedicated Worker adapter.
- Trust only verified exact-audience CAIL assertions and current Admission.
- Default to private student/instructor data; require explicit, expiring authority
  for instructor settings, with immutable access and prompt revision history.
- Keep Remixer false by default, with one Crate and license/attribution-aware capture.
- Do not migrate users/audio or change Railway/Doorway traffic implicitly.

## Not yet accepted

Live Doorway mounting, real CUNY login/logout, class enrollment and sharing,
paid canaries, large-source and sustained-load behavior, AI Gateway evaluation,
data import and rollback. A deployed static shell or signed test fixture does
not satisfy these gates. Current evidence is in `../../review-2026-09-06.md`.
