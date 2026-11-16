# Stem Splitter on the Tools domain

`https://tools.ailab.gc.cuny.edu/stem-splitter/` uses the same
`cail-stem-splitter-preview` Worker, D1 database and audio bucket as the existing
`stem-splitter.ailab-452.workers.dev` alias. No saved work is copied or migrated.

Doorway binds the private `ToolsApp` entrypoint in `cloudflare/entry.ts`. It
forwards the full mounted URL and separate `x-cail-identity-jwt` and
`x-cail-gateway-identity-jwt` legs. The receiver requires the exact Tools origin
and mount, verifies both signatures and audiences, requires matching subjects,
and rechecks current Admission before serving pages or APIs. The shared app
continues to enforce roles, courses and recording ownership. Cookies and caller
identity headers are discarded. Only this private entrypoint accepts Doorway's
trusted `x-forwarded-for` platform IP for the existing request limits.

Doorway owns sign-in and the root `POST /auth/logout`. The public default
Worker export retains its existing opaque Worker-session login. API paths are
stripped internally, while explicit client path helpers and static HTML URL
attributes keep navigation, uploads, audio and downloads under `/stem-splitter`.
No script response is rewritten and no iframe is used. Root Worker links keep
working. Provider source capabilities and webhooks retain the existing Worker
origin, which avoids placing provider callbacks behind browser sign-in.

Release the shared Admission contract accepting the exact Tools reporting
origin before exposing this mount. Deploy the tested Stem commit to Dev and
complete its signed-in acceptance, then promote that exact source using
`docs/local-cloudflare-releases.md`. Finally, release Doorway's binding and
routes. The app's deployment entrypoint is now `entry.ts`, which reexports the
unchanged default adapter and the private `ToolsApp` class; the local release
guard pins that exact file. The retained Worker aliases and D1/R2 identities do
not change. Code rollback needs no database rollback.

The focused local browser test `cloudflare/tools.spec.mjs` drives saved split
loading, real fixture MP3 playback, reload, a mounted upload URL, all four app
pages and the root logout action. Its CUNY/Admission identities are explicit
local doubles; production acceptance still requires actual signed-in use.
