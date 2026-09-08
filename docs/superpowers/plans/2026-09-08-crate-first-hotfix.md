# Cloudflare hotfix sequence

1. Branch from the currently deployed candidate, preserving unfinished work.
2. Remove the Remixer assistant end to end; govern the restored policy.
3. Move the one Crate first in both supported feature-flag layouts.
4. Run source, adapter/security and browser regression checks. Capture both
   layouts on desktop/mobile, including disclosure interaction.
5. Commit the exact candidate, validate its Cloudflare bundle, and update only
   the existing preview Worker. Keep the prior Worker version for rollback.
6. Verify both bound public addresses serve the exact new assets, retain the
   existing authentication/feature flags, and render Crate first after reload.
   Do not deploy Railway or merge unrelated feature branches.
