"""YouTube audio fetcher for Stem Splitter.

YouTube refuses full audio downloads to Cloudflare's network, but serves them to an
ordinary home or campus connection. This service runs yt-dlp on such a machine. The
Worker reaches it through a Cloudflare Tunnel, so it listens on 127.0.0.1 only (or, in
its container, on the container's private network), and every request must carry a secret.

    YT_FETCHER_SECRET_FILE=secrets YT_FETCHER_CACHE_KEY_FILE=cache-key python3 fetcher.py

The secrets file holds one secret per line, each at least 32 characters: one for each
Worker that may call (Dev and production), so either can be rotated alone by adding the
new line, updating that Worker, then removing the old line. The cache key names cached
files and searches; it is separate so that rotating a secret keeps the cache.
YT_FETCHER_SECRET (a single secret, which then also keys the cache) still works.

POST /search {"query": "<2-120 chars>"}
  200: {"results": [{"id", "title", "channel", "duration", "live"}]}, at most 10, with X-Fetcher-Cache.
  The Worker uses it when YouTube's search does not answer Cloudflare's network.

POST /audio  {"videoId": "<11 chars>", "maxSeconds": 300|900}
  200: the audio bytes (audio/mp4 or audio/webm), with X-Audio-Title (percent-encoded),
       X-Audio-Duration (seconds), X-Audio-Sha256 and X-Fetcher-Cache (hit or miss).
  4xx/5xx: {"code": "..."}; final refusals are not retried by the Worker, the rest may be.

Requests are idempotent per video. A finished download is kept for a week and served again
without asking YouTube; a second request for a video that is downloading waits for that
download instead of starting another; a final refusal (private, unavailable, live) is
remembered for an hour. Repeated downloads of one video from one connection are what YouTube
is most likely to bot-check, and a class often picks the same song.
"""
import collections
import hashlib
import hmac
import json
import os
import pathlib
import re
import sys
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import yt_dlp

def secret_lines(path):
    """Non-empty, non-comment lines of a secrets file; none when no file is named."""
    if not path:
        return []
    lines = pathlib.Path(path).read_text().splitlines()
    return [line.strip().encode() for line in lines if line.strip() and not line.strip().startswith("#")]


_single = os.environ.get("YT_FETCHER_SECRET", "").encode()
# Every secret a caller may present. Each is compared on every request, so the time taken
# does not reveal which one matched or how much of a guess was right.
SECRETS = tuple(([_single] if _single else []) + secret_lines(os.environ.get("YT_FETCHER_SECRET_FILE")))
CACHE_KEY = (secret_lines(os.environ.get("YT_FETCHER_CACHE_KEY_FILE")) or [SECRETS[0] if SECRETS else b""])[0]
HOST = os.environ.get("YT_FETCHER_HOST", "127.0.0.1")
PORT = int(os.environ.get("YT_FETCHER_PORT", "8790"))
CACHE = pathlib.Path(os.environ.get("YT_FETCHER_CACHE") or pathlib.Path.home() / "Library" / "Caches" / "stem-youtube-fetcher")
MAX_BYTES = 12 * 1024 * 1024  # The app's import limit (CAIL_IMPORT_BYTES).
ALLOWED_SECONDS = (300, 900)  # Guest and member import limits.
AUDIO_SECONDS = 7 * 86400  # How long a download is reused.
INFO_SECONDS = 86400  # How long a known duration is reused to refuse a too-long video.
REFUSAL_SECONDS = 3600  # How long a final refusal is remembered.
CACHE_BYTES = int(os.environ.get("YT_FETCHER_CACHE_BYTES", str(2 * 1024 ** 3)))
# The Worker gives a request 60 s. Waits end before that, so a busy fetcher answers "busy"
# and the job is queued for a retry, while the download in progress still finishes and is cached.
WAIT_SECONDS = 55  # How long a second request waits for the same video's download.
SLOT_WAIT_SECONDS = 50  # How long a request waits in line for a download slot.
MAX_WAITING = 20  # Requests in line beyond this are told to come back later.
RETRY_PAUSE_SECONDS = 2  # Before the one retry of a failure that is not a refusal.
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
# Two downloads at once keeps a home connection usable and looks like a person, not a farm.
# Downloads mostly wait on the network; the hourly budget and the 5 s lookup gap,
# not this number, are what keep YouTube's rate in check.
DOWNLOAD_SLOTS = int(os.environ.get("YT_FETCHER_DOWNLOAD_SLOTS", "4"))
SLOTS = threading.BoundedSemaphore(max(1, min(DOWNLOAD_SLOTS, 8)))
CONTENT_TYPES = {".m4a": "audio/mp4", ".mp4": "audio/mp4", ".webm": "audio/webm"}
# yt-dlp reports refusals as text. Final refusals are remembered; the bot check is not,
# because it depends on the moment rather than the video.
REFUSALS = (
    ("source_denied_bot_verification", re.compile(r"not a bot|captcha|unusual traffic", re.I), 503, False),
    ("source_denied_private", re.compile(r"private video", re.I), 422, True),
    ("source_denied_age_restricted", re.compile(r"confirm your age|age[- ]restrict", re.I), 422, True),
    ("source_denied_unavailable", re.compile(r"video unavailable|not available|has been removed|terminated", re.I), 422, True),
)
_locks, _locks_guard = {}, threading.Lock()
_waiting, _waiting_guard = 0, threading.Lock()
SEARCH_SECONDS = 600  # How long a search's results are reused.
SEARCH_ENTRIES = 500  # Searches kept in memory; the oldest go first.
# Searches are light and must answer in seconds, so they never wait behind downloads.
# Four at once; the Workers send at most 120 a minute in all, because many searches from one
# connection are what YouTube bot-checks. Beyond what this answers it says "busy" after 5 s.
SEARCH_SLOTS = threading.BoundedSemaphore(4)
_searches, _searches_guard = {}, threading.Lock()


class Refused(Exception):
    def __init__(self, code, status=422):
        super().__init__(code)
        self.code, self.status = code, status


# YouTube's documented rate for a guest session (no account, as here) is about 300 videos, or
# about 1000 webpage/player requests, an hour; past it YouTube answers "This content isn't
# available, try again later" for imports and searches alike (yt-dlp wiki, "Extractors").
# This fetcher is the one place that sees everything sent from this connection (Dev and
# production, searches and imports), so it keeps the count: 60% of that rate, with searches
# held to a third so imports always have room. Answers from the cache cost nothing.
HOURLY_REQUESTS = int(os.environ.get("YT_FETCHER_HOURLY_REQUESTS", "600"))
SEARCH_SHARE = 1 / 3
# Each caller the Workers name (an hourly keyed hash, never a person) gets at most a fifth of the
# search share, so one person or script cannot use up everyone's searches for the hour.
CALLER_SEARCH_SHARE = 1 / 5
CALLER = re.compile(r"^[0-9a-f]{32}$")
VIDEO_COST = 4  # One video looked up or downloaded: 1000 / 300 is about 3.3, rounded up.
SEARCH_COST = 2  # One results page, counted twice to stay on the safe side.
# The wiki recommends 5 to 10 seconds between downloads; the low end, because people wait on imports.
VIDEO_GAP_SECONDS = float(os.environ.get("YT_FETCHER_VIDEO_GAP_SECONDS", "5"))


class Budget:
    """What was asked of YouTube in the last hour."""

    def __init__(self, hourly):
        self.hourly, self.spent, self.guard = hourly, collections.deque(), threading.Lock()

    def used(self, kind=None):
        with self.guard:
            self._trim(time.time())
            return sum(cost for _, cost, spent_on, _ in self.spent if kind in (None, spent_on))

    def _trim(self, now):
        while self.spent and now - self.spent[0][0] >= 3600:
            self.spent.popleft()

    def take(self, kind, cost, caller=None):
        """Spends cost if the hour has room for it, or raises Refused (429) to come back later."""
        with self.guard:
            now = time.time()
            self._trim(now)
            total = sum(spent for _, spent, _, _ in self.spent)
            searches = sum(spent for _, spent, spent_on, _ in self.spent if spent_on == "search")
            mine = sum(spent for _, spent, spent_on, who in self.spent if spent_on == "search" and who == caller) if caller else 0
            fits = total + cost <= self.hourly
            if kind == "search":
                fits = fits and searches + cost <= self.hourly * SEARCH_SHARE
                fits = fits and (not caller or mine + cost <= self.hourly * SEARCH_SHARE * CALLER_SEARCH_SHARE)
            if fits:
                self.spent.append((now, cost, kind, caller))
                return
        log("hourly_budget_full", kind=kind, used=total, hourly=self.hourly, callerShareUsed=bool(caller) and mine > 0)
        raise Refused("hourly_budget", 429)


BUDGET = Budget(HOURLY_REQUESTS)
_last_video, _video_gap_guard = 0.0, threading.Lock()


def space_video_lookups():
    """Starts YouTube video lookups at least VIDEO_GAP_SECONDS apart, across both download slots."""
    global _last_video
    with _video_gap_guard:
        wait = _last_video + VIDEO_GAP_SECONDS - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last_video = time.monotonic()


def log(event, **fields):
    # No titles or video IDs: the log shows what happened, not what anyone listened to.
    print(json.dumps({"t": round(time.time()), "event": event, **fields}), file=sys.stderr, flush=True)


def entry_name(video_id):
    # Keyed, so the cache folder does not list which videos were imported.
    return hmac.new(CACHE_KEY, video_id.encode(), hashlib.sha256).hexdigest()[:32]


def video_lock(video_id):
    with _locks_guard:
        return _locks.setdefault(video_id, threading.Lock())


def write_atomically(path, data):
    temporary = path.with_name(path.name + ".partial")
    temporary.write_bytes(data)
    os.replace(temporary, path)


def remember(name, record, audio=None):
    CACHE.mkdir(parents=True, exist_ok=True, mode=0o700)
    if audio is not None:
        write_atomically(CACHE / f"{name}.audio", audio)
    else:
        (CACHE / f"{name}.audio").unlink(missing_ok=True)
    write_atomically(CACHE / f"{name}.json", json.dumps({**record, "stored": time.time()}).encode())


def recall(name):
    """The cached record for a video and its audio, if still fresh and intact."""
    try:
        record = json.loads((CACHE / f"{name}.json").read_bytes())
        age = time.time() - float(record["stored"])
        if record["state"] == "audio":
            if age > AUDIO_SECONDS:
                return None, None
            audio = (CACHE / f"{name}.audio").read_bytes()
            # A damaged file is downloaded again rather than served.
            if len(audio) != record["bytes"] or hashlib.sha256(audio).hexdigest() != record["sha256"]:
                return None, None
            os.utime(CACHE / f"{name}.json")  # Recently used entries are evicted last.
            return record, audio
        if age > (INFO_SECONDS if record["state"] == "info" else REFUSAL_SECONDS):
            return None, None
        return record, None
    except (OSError, ValueError, KeyError, TypeError):
        return None, None


def evict():
    """Keep the cache under CACHE_BYTES by removing the least recently used downloads."""
    records = sorted(CACHE.glob("*.json"), key=lambda path: path.stat().st_mtime)
    total = sum(path.stat().st_size for path in CACHE.glob("*.audio"))
    for record in records:
        if total <= CACHE_BYTES:
            break
        audio = record.with_suffix(".audio")
        if audio.exists():
            total -= audio.stat().st_size
            audio.unlink(missing_ok=True)
        record.unlink(missing_ok=True)


def refusal(error):
    text = str(error)
    for code, pattern, status, final in REFUSALS:
        if pattern.search(text):
            return Refused(code, status), final
    return Refused("extractor_failed", 502), False


def download(video_id, name, max_seconds):
    """Ask YouTube once. Remembers what it learns, then returns the audio or raises.
    A video longer than the requester's limit is not downloaded; its duration is remembered."""
    url = f"https://www.youtube.com/watch?v={video_id}"
    BUDGET.take("video", VIDEO_COST)  # Each attempt, the retry included, asks YouTube again.
    space_video_lookups()
    with tempfile.TemporaryDirectory(prefix="stem-yt-") as folder:
        options = {
            "quiet": True, "no_warnings": True, "noplaylist": True, "cachedir": False,
            # AAC first: every browser decodes it, and it needs no re-encoding.
            "format": "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
            "outtmpl": f"{folder}/audio.%(ext)s",
            "max_filesize": MAX_BYTES, "socket_timeout": 20, "retries": 2,
            # Part of yt-dlp's recommended "sleep" preset: a pause between a lookup's requests.
            "sleep_interval_requests": 0.75,
        }
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                info = ydl.extract_info(url, download=False)
                title = str(info.get("title") or "")[:200]
                if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming", "post_live"):
                    remember(name, {"state": "refused", "code": "live_stream", "status": 422})
                    raise Refused("live_stream")
                duration = info.get("duration")
                if not isinstance(duration, (int, float)) or duration <= 0:
                    remember(name, {"state": "refused", "code": "duration_unknown", "status": 422})
                    raise Refused("duration_unknown")
                if duration > max_seconds:
                    remember(name, {"state": "info", "title": title, "duration": float(duration)})
                    return {"state": "info", "title": title, "duration": float(duration)}, None
                ydl.process_ie_result(info, download=True)
        except yt_dlp.utils.DownloadError as error:
            refused, final = refusal(error)
            if final:
                remember(name, {"state": "refused", "code": refused.code, "status": refused.status})
            raise refused from None
        files = [path for path in pathlib.Path(folder).glob("audio.*") if path.suffix in CONTENT_TYPES]
        # yt-dlp skips, rather than truncates, a file over max_filesize.
        data = files[0].read_bytes() if files else b""
        if not data or len(data) > MAX_BYTES:
            remember(name, {"state": "refused", "code": "audio_too_large", "status": 413})
            raise Refused("audio_too_large", 413)
        record = {"state": "audio", "title": title, "duration": float(duration), "type": CONTENT_TYPES[files[0].suffix],
                  "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        remember(name, record, data)
        evict()
        return record, data


class Slot:
    """A place in the bounded line for one of the download slots."""

    def __enter__(self):
        global _waiting
        with _waiting_guard:
            if _waiting >= MAX_WAITING:
                raise Refused("fetcher_busy", 429)
            _waiting += 1
        try:
            if not SLOTS.acquire(timeout=SLOT_WAIT_SECONDS):
                raise Refused("fetcher_busy", 429)
        finally:
            with _waiting_guard:
                _waiting -= 1
        return self

    def __exit__(self, *args):
        SLOTS.release()
        return False


def download_once_more(video_id, name, max_seconds):
    """Download with one retry for a failure that is not a refusal (a dropped connection, an extractor hiccup)."""
    with Slot():
        try:
            return download(video_id, name, max_seconds)
        except Refused as refused:
            if refused.code != "extractor_failed":
                raise
    log("retry", code="extractor_failed")
    time.sleep(RETRY_PAUSE_SECONDS)
    with Slot():
        return download(video_id, name, max_seconds)


def fetch(video_id, max_seconds):
    """Returns (record, audio, cache) where cache is "hit" or "miss"; raises Refused."""
    lock = video_lock(video_id)
    # A request for a video already downloading waits for it, so YouTube is asked once.
    if not lock.acquire(timeout=WAIT_SECONDS):
        raise Refused("fetcher_busy", 429)
    try:
        name = entry_name(video_id)
        record, audio = recall(name)
        cache = "hit"
        if record is None:
            # Only a real download takes one of the two slots; cache hits need none.
            record, audio = download_once_more(video_id, name, max_seconds)
            cache = "miss"
        if record["state"] == "refused":
            raise Refused(record["code"], record["status"])
        if record["duration"] > max_seconds:
            raise Refused("source_too_long")
        if audio is None:
            # Known only from an earlier, longer limit: it now fits, so download it once.
            (CACHE / f"{name}.json").unlink(missing_ok=True)
            record, audio = download_once_more(video_id, name, max_seconds)
            cache = "miss"
            if audio is None or record["duration"] > max_seconds:
                raise Refused("source_too_long")
        return record, audio, cache
    finally:
        lock.release()


def search(query, caller=None):
    """Up to ten videos for a search, from yt-dlp's YouTube search. Returns (results, cache)."""
    key = hmac.new(CACHE_KEY, query.casefold().encode(), hashlib.sha256).hexdigest()
    with _searches_guard:
        found = _searches.get(key)
        if found and time.time() - found[0] < SEARCH_SECONDS:
            return found[1], "hit"
    BUDGET.take("search", SEARCH_COST, caller)  # Before waiting for a slot: a full hour answers at once.
    if not SEARCH_SLOTS.acquire(timeout=5):
        raise Refused("fetcher_busy", 429)
    try:
        options = {"quiet": True, "no_warnings": True, "cachedir": False, "skip_download": True,
                   "extract_flat": "in_playlist", "socket_timeout": 10}
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                listing = ydl.extract_info(f"ytsearch10:{query}", download=False)
        except yt_dlp.utils.DownloadError as error:
            raise refusal(error)[0] from None
    finally:
        SEARCH_SLOTS.release()
    results = []
    for entry in listing.get("entries") or []:
        video_id = entry.get("id")
        if not isinstance(video_id, str) or not VIDEO_ID.match(video_id):
            continue
        duration = entry.get("duration")
        results.append({"id": video_id, "title": str(entry.get("title") or "")[:200],
                        "channel": str(entry.get("channel") or entry.get("uploader") or "")[:200],
                        "duration": duration if isinstance(duration, (int, float)) else None,
                        "live": entry.get("live_status") in ("is_live", "is_upcoming")})
    with _searches_guard:
        _searches[key] = (time.time(), results)
        while len(_searches) > SEARCH_ENTRIES:
            _searches.pop(next(iter(_searches)))
    return results, "miss"


class Handler(BaseHTTPRequestHandler):
    server_version = "stem-youtube-fetcher"
    sys_version = ""

    def log_message(self, *args):  # The default access log would record video IDs.
        pass

    def reply(self, status, body, content_type="application/json", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        try:
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # The Worker stopped waiting. A download is already cached for its retry.
            log("caller_gone")

    def refuse(self, status, code):
        self.reply(status, json.dumps({"code": code}).encode(), headers={"Retry-After": "15"} if status == 429 else None)

    def authorized(self):
        supplied = self.headers.get("Authorization", "").encode()
        matched = False
        for secret in SECRETS:
            matched |= hmac.compare_digest(supplied, b"Bearer " + secret)
        return matched

    def do_GET(self):
        if self.path != "/healthz":
            return self.refuse(404, "not_found")
        if not self.authorized():
            return self.refuse(401, "unauthorized")
        # How much of the hour is used, for whoever watches the fetcher (no IDs or search words).
        self.reply(200, json.dumps({"ok": True, "ytDlp": yt_dlp.version.__version__, "hourly": BUDGET.hourly,
                                    "usedThisHour": BUDGET.used(), "searchesThisHour": BUDGET.used("search")}).encode())

    def do_POST(self):
        if self.path not in ("/audio", "/search"):
            return self.refuse(404, "not_found")
        if not self.authorized():
            return self.refuse(401, "unauthorized")
        if self.path == "/search":
            return self.search()
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 512:
                raise ValueError
            request = json.loads(self.rfile.read(length))
            video_id, max_seconds = request["videoId"], request["maxSeconds"]
            if not isinstance(video_id, str) or not VIDEO_ID.match(video_id) or max_seconds not in ALLOWED_SECONDS:
                raise ValueError
        except (ValueError, KeyError, TypeError):
            return self.refuse(400, "invalid_request")
        started = time.monotonic()
        try:
            record, data, cache = fetch(video_id, max_seconds)
        except Refused as refused:
            log("refused", code=refused.code, ms=round((time.monotonic() - started) * 1000))
            return self.refuse(refused.status, refused.code)
        except Exception as error:  # Never return a traceback to the caller.
            log("failed", error=type(error).__name__, ms=round((time.monotonic() - started) * 1000))
            return self.refuse(502, "extractor_failed")
        log("fetched", cache=cache, bytes=len(data), seconds=round(record["duration"]), ms=round((time.monotonic() - started) * 1000))
        self.reply(200, data, record["type"], {
            "X-Audio-Title": urllib.parse.quote(record["title"], safe=""),
            "X-Audio-Duration": str(record["duration"]),
            "X-Audio-Sha256": record["sha256"],
            "X-Fetcher-Cache": cache,
        })


    def search(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 1024:
                raise ValueError
            request = json.loads(self.rfile.read(length))
            query, caller = request["query"], request.get("caller")
            if not isinstance(query, str) or not (caller is None or isinstance(caller, str) and CALLER.match(caller)):
                raise ValueError
            query = re.sub(r"[\x00-\x1f\x7f]", " ", query).strip()
            if not 2 <= len(query) <= 120:
                raise ValueError
        except (ValueError, KeyError, TypeError):
            return self.refuse(400, "invalid_request")
        started = time.monotonic()
        try:
            results, cache = search(query, caller)
        except Refused as refused:
            log("search_refused", code=refused.code, ms=round((time.monotonic() - started) * 1000))
            return self.refuse(refused.status, refused.code)
        except Exception as error:
            log("search_failed", error=type(error).__name__, ms=round((time.monotonic() - started) * 1000))
            return self.refuse(502, "extractor_failed")
        # No search words in the log.
        log("searched", cache=cache, results=len(results), ms=round((time.monotonic() - started) * 1000))
        self.reply(200, json.dumps({"results": results}).encode(), headers={"X-Fetcher-Cache": cache})


if __name__ == "__main__":
    if not SECRETS or any(len(secret) < 32 for secret in SECRETS):
        sys.exit("Give at least one secret, each at least 32 characters (YT_FETCHER_SECRET_FILE or YT_FETCHER_SECRET).")
    if len(CACHE_KEY) < 32:
        sys.exit("The cache key must be at least 32 characters (YT_FETCHER_CACHE_KEY_FILE).")
    CACHE.mkdir(parents=True, exist_ok=True, mode=0o700)
    log("listening", port=PORT, secrets=len(SECRETS), ytDlp=yt_dlp.version.__version__)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
