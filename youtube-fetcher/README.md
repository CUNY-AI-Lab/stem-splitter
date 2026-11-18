# YouTube fetcher

YouTube refuses full audio downloads to Cloudflare's network. Probed on 2026-11-08
from a Worker:

- **Player responses:** bot-checked ("Sign in to confirm you're not a bot").
- **Direct iOS-client links:** stop with 403 after the first 1 MiB, because there is
  no proof-of-origin token.
- **Cloudflare's browser:** gets the same bot check.

The same requests succeed from an ordinary home or campus connection. This service
runs yt-dlp on such a machine. The Worker reaches it through a Cloudflare Tunnel and
tries it before its own importers.

## Run it in a container (the supported way)

`Dockerfile` and `compose.yaml` run the fetcher and its tunnel as two containers. The
host needs Docker (on a Mac, a Colima VM that mounts only the service folder).

- **Fetcher container:** an unprivileged user, a read-only file system, no Linux
  capabilities, `no-new-privileges`, memory and process limits. Its only writable places
  are its cache volume and a 96 MB `/tmp`. Nothing is published on the host.
- **Tunnel container:** `cloudflared`, equally locked down. It reaches the fetcher over
  the project's private network and is the only way in.
- **Pinned inputs:** the base images by digest, and every Python package by version and
  hash (`requirements.txt`, for linux aarch64 and x86_64).
- **Secrets:** read from files, never the environment. `accepted` holds one secret per
  line, one for each Worker that may call (Dev and production), so each can be rotated
  alone. `cache-key` names cached files, so rotating a secret keeps the cache. Both are
  mounted read-only, owned by `FETCHER_UID`.

```bash
# Once: a folder outside any checkout, readable only by its owner.
D=~/.local/share/cail-stem-youtube-fetcher; mkdir -p $D/secrets $D/build; chmod 700 $D $D/secrets
for f in dev production cache-key; do openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-56 > $D/secrets/$f; done
cat $D/secrets/dev <(echo) $D/secrets/production <(echo) > $D/secrets/accepted
cp Dockerfile compose.yaml requirements.txt fetcher.py $D/build/
printf 'SECRETS_DIR=%s\nFETCHER_UID=%s\n' "$D/secrets" "$(id -u)" > $D/build/.env
docker compose -f $D/build/compose.yaml up -d --build
docker compose -f $D/build/compose.yaml logs tunnel | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1
```

Give each Worker the tunnel address and its own secret, piped in without printing them:
`YOUTUBE_FETCHER_URL` (HTTPS) and `YOUTUBE_FETCHER_SECRET` (`dev` for `stem-splitter-dev`,
`production` for `cail-stem-splitter-preview`). YouTube results appear only when both are set.

On the owner's Mac (since 2026-11-08) the VM is the Colima profile `stem-fetcher`, started at
login by `~/Library/LaunchAgents/edu.cuny.ailab.stem-youtube-fetcher.plist`, and the Docker
client for it uses `DOCKER_HOST=unix://$HOME/.colima/stem-fetcher/docker.sock` and
`DOCKER_CONFIG=~/.local/share/cail-stem-youtube-fetcher/docker-client` (no credential helper,
none of the owner's Docker Hub sign-ins).

**The quick tunnel's address changes whenever the tunnel container or the machine restarts.**
After a restart, read the new address from the tunnel's log and set `YOUTUBE_FETCHER_URL` on
both Workers again. Until then YouTube is missing from search, and imports wait in the queue
for about 39 minutes, then fail with no allowance used. A named tunnel, or a Workers VPC
binding, removes this step.

**Stop YouTube everywhere at once:** delete `YOUTUBE_FETCHER_URL` from both Workers. Search
leaves YouTube out and YouTube imports fail cleanly, with no allowance used.

**Update** yt-dlp often (YouTube changes, and releases follow within days): change the
versions in `requirements.txt`, regenerate the hashes for both architectures with
`pip install --dry-run --report` inside `python:3.14-slim` (with `--platform` for x86_64),
run the tests, then rebuild with `up -d --build`.

Without a container, for development only:
`YT_FETCHER_SECRET=... python3 -I fetcher.py` binds to `127.0.0.1`.

## Staying under YouTube's rate

YouTube's documented rate for a guest session (no account, as here) is about 300 videos, or
about 1000 webpage/player requests, an hour; past it YouTube answers "This content isn't
available, try again later" for imports and searches alike
([yt-dlp wiki, Extractors](https://github.com/yt-dlp/yt-dlp/wiki/Extractors)). A rate-limited
or bot-checked connection stops every import, so the fetcher keeps well inside it:

- **Hourly budget:** 600 requests in any hour (`YT_FETCHER_HOURLY_REQUESTS`), 60% of the
  documented rate. A video looked up or downloaded counts 4 (1000 / 300 is about 3.3), a search
  counts 2. Searches may use a third of the hour, so imports always keep about 100 new songs.
  Answers from the cache count nothing. Past the budget the answer is 429 `hourly_budget`:
  search leaves YouTube out, and an import waits in the queue.
- **Fair share:** the Workers name each searcher by an hourly keyed hash (`"caller"` in
  `/search`; the key stays in the Workers, so the fetcher can count callers but not tell who
  they are). One caller may use at most a fifth of the hour's searches, so one person or
  script cannot use up everyone's.
- **Spacing:** video lookups start at least 5 s apart (the wiki recommends 5 to 10 s between
  downloads), with yt-dlp's 0.75 s pause between a lookup's requests.
- **In the Workers:** each person may send 10 searches a minute to the fetcher and make 120
  searches a minute in all (`src/search-limits.ts`). The total is the fetcher's to keep: it
  alone sees Dev and production, searches and imports, and what its cache answers.
- **Watch it:** `GET /healthz` (with a secret) reports `usedThisHour` and `searchesThisHour`.
  The count starts again when the fetcher restarts.

## Behaviour

- **Listening:** every request needs `Authorization: Bearer <secret>`; each accepted secret
  is compared on every request. Outside a container the service binds to `127.0.0.1` only.
- **Request:** `POST /audio` takes `{"videoId", "maxSeconds"}`. `maxSeconds` is 300 for
  guests and 900 for members.
- **Response:** m4a (AAC) or WebM audio up to 12 MiB, with `X-Audio-Title` and
  `X-Audio-Duration`.
- **Final refusals:** too long, live, private, age-restricted, unavailable and too large.
  The Worker does not retry these.
- **Other failures:** a bot check, a full hour or an extractor failure lets the Worker fall
  back to its own importers or queue the import.
- **Idempotent per video:** a finished download is kept for a week (1 GiB in the container,
  least recently used dropped first) and served again without asking YouTube. A request for a
  video that is already downloading waits for that download instead of starting another.
  A final refusal (private, unavailable, live) is remembered for an hour; a bot check is
  not, because it is about the moment, not the video. Cache files are named by a keyed
  hash, so the folder does not list which videos were imported, and each answer carries
  `X-Audio-Sha256` and `X-Fetcher-Cache` (hit or miss).
- **Queue:** at most four downloads run at once (`YT_FETCHER_DOWNLOAD_SLOTS`, 1 to 8). Up to 20 more requests wait in line for
  50 s; beyond that the answer is 429 with `Retry-After`. All waits end before the
  Worker's 60 s, so a download that outlasts the request still finishes and is cached for
  the retry. A failure that is not a refusal gets one more try after 2 s.
- **Search:** `POST /search` takes `{"query"}` and answers up to ten videos (ID, title,
  channel, duration, live) from yt-dlp's YouTube search, in about a second. Results are
  reused for 10 minutes. Searches use their own four slots, so they never wait behind downloads.
- **Logs:** outcomes, cache hits, sizes and timings, never titles, video IDs or search words.
- **Tests:** `python3 -m unittest discover -s youtube-fetcher -p 'test_*.py'` with yt-dlp
  installed. yt-dlp itself is faked; nothing reaches YouTube.

## In the app

Search asks YouTube's own search API from Cloudflare first (3.5 s). From Cloudflare's
network it sometimes does not answer in time, so a failed, slow or empty answer falls back
to the fetcher's `/search` (4.5 s), inside the 9 s every search source gets.

A YouTube link, with or without `https://` or inside shared text, is imported as that video;
no source searches for it, and the search route refuses such a query.

The split pipeline asks the fetcher first. When the fetcher is offline, busy or
bot-checked, Cloudflare's browser gets one try. After that the import waits in the queue
(`youtube_fetcher_waiting`), and the owner's open page tries again after 15 s, 30 s, 1, 2
and 5 minutes, then every 10 minutes, about 39 minutes in all. Then it uses the hosted
importer where that is configured, or fails with no allowance used. Only the fetcher's
refusals (too long, private, live) end an import at once.
