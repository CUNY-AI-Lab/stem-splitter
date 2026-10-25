# Parent-page reload flash correction

Scope: retain the existing wordmark, typography, layout and account gating. Extend
Settings' existing static masthead rule to every masthead, and preload the existing
local brand font in the Splitter, Workspace and Settings document heads. No whole-
app concealment, overlay, new asset, external font request, theme restoration or
account-panel redesign is introduced. Auto choices and Commons credits are untouched.

The diagnosed baseline was production d7235b7 and preserved-Dev f853512. Splitter
and Workspace replayed a 600 ms rise animation (80 ms wordmark delay). All three
pages could swap fallback lettering for Stem Splitter Brand after first paint.
The fallback first-line width was 104.078125 px; loaded width was 111.421875 px.
Settings already disabled the animation. Some ordinary fast loads completed the
font before first contentful paint; a 1200 ms delayed font made the swap visible.
Fully cached Settings did not reproduce the font flash.

Implementation: public/styles.css uses the existing animation:none rule on
.masthead h1 and .masthead .lab-brand. The three HTML heads preload exactly
/fonts/bricolage-grotesque-800.ttf as font/ttf with anonymous crossorigin, matching
the existing @font-face URL. font-display:swap is retained.

Chromium 151.0.7922.34 regression: three pages × cold, actual cached reload and
1200 ms delayed font × normal/reduced-motion preference = 18 cases. Warm cases
use no Playwright routing, preserving the HTTP cache. External Google fonts are
blocked through CDP to isolate the existing local brand font. Real local Workerd
APIs use synthetic identity; no production/participant requests or paid jobs.

Targeted outcome: all 18 cases passed. Every sampled wordmark/logo frame was
opacity1, transform:none and animation:none. All 12 cold/warm cases retained the
loaded 111.421875 px width. All six delayed cases still changed from fallback to
loaded width, explicitly proving that preloading is mitigation, not a guarantee
of zero possible font swap. Each navigation made at most one font request; resource
timing reported initiatorType:link, starting about 5–10.2 ms after navigation.
The separate delayed-account check kept Settings details hidden until the account
response and retained the navigation's vertical position afterward. Existing body
loading-to-details movement is not redesigned or claimed eliminated.

The browser test attaches per-case timings/frames as JSON. It is Chromium-only
because its network/cache instrumentation uses CDP; other relevant browser/layout
checks remain separate. It samples animation frames, not every compositor pixel.
Independent review cleared the scoped source change, with final exact-tree review,
full relevant suites, hosted gates and preserved-Dev integration checked separately.
