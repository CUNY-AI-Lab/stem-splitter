# Production dependency audit — November 5, 2026

The Cloudflare runtime candidate overrides transitive Zod to the published
4.6.6 fix for [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
The three CAIL SDK versions and integrity pins are unchanged. The root
application lockfile and frozen analyzer inputs are unchanged.

`bun audit --production` still reports three high-severity advisories in
Cloudflare Puppeteer's browser-install dependency graph: basic-ftp 5.3.1 and
extract-zip 2.0.1 (two advisories). They are not imported into the production
Worker: the dry-build source map contains zero sources from either package.
These remain dependency-install/tooling findings; this is not a clean audit.
No downloaded browser archive or FTP listing is processed by the Worker.

The root audit reports six moderate advisories for legacy Hono/Node packages.
The Cloudflare bundle instead uses the pinned `hono-cloudflare` 4.13.11 alias,
and contains no `@hono/node-server` sources. Those root package versions remain
frozen for existing analyzer acceptance evidence. This disposition applies to
the Cloudflare release only, not to a future Node/Railway deployment.

Verify the final artifact source map again before release, alongside the
Cloudflare identity/Gateway regressions and browser tests. Audit output and
exact build evidence are retained in the dated local release receipt.
