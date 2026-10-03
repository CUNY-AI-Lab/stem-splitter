# Mixer transport hardening plan

1. Confirm current Cloudflare release and reproduce the public split read-only.
2. Add 2/4/6-stem real-media regression coverage for seeking past 0:43 while
   switching focus. Add failure cases for orphaned preview and focused MUTE;
   require them to fail before the fixes.
3. Separate the drag lifecycle from input previews, scope release listeners to
   the gesture, defer final release until native events finish, and recover on
   cancellation/focus loss. Add media-event clock refresh and isolate meters.
4. Correct focused MUTE semantics without erasing other instruments' mute choices;
   verify actual gain nodes and element-level fallback, not only button labels.
5. Bound and cancel pending playback starts. Test retry, collapse, keyboard,
   speed changes, rapid seeks, mobile layout and existing account/sharing paths.
6. Run Cloudflare typecheck, backend tests, the full Chrome browser suite and
   the focused Firefox suite. Keep production unchanged until release is requested.

Receipts belong outside the repository. Regression checks are committed source;
generated audio and screenshots are not. Full live acceptance in the reporting
user's Firefox profile remains distinct from automated local checks.

Run the focused cross-browser checks from `cloudflare/`:

```sh
../node_modules/.bin/playwright test --config playwright.config.mjs playback.spec.mjs
STEM_BROWSER=firefox ../node_modules/.bin/playwright test --config playwright.config.mjs playback.spec.mjs
```

The Cloudflare CI lane runs both. The root analyzer workflow and frozen package
inputs remain unchanged.
