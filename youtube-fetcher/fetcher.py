"""YouTube audio fetcher for Stem Splitter.

YouTube refuses full audio downloads to Cloudflare's network, but serves them to an
ordinary home or campus connection. This service runs yt-dlp on such a machine. The
Worker reaches it through a Cloudflare Tunnel, so it listens on 127.0.0.1 only, and
every request must carry the shared secret.

    YT_FETCHER_SECRET=... python3 fetcher.py

POST /audio  {"videoId": "<11 chars>", "maxSeconds": 300|900}
  200: the audio bytes (audio/mp4 or audio/webm), with X-Audio-Title (percent-encoded)
       and X-Audio-Duration (seconds).
  4xx/5xx: {"code": "..."}; codes ending in a refusal are final, the rest may be retried.
"""
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

SECRET = os.environ.get("YT_FETCHER_SECRET", "").encode()
PORT = int(os.environ.get("YT_FETCHER_PORT", "8790"))
MAX_BYTES = 12 * 1024 * 1024  # The app's import limit (CAIL_IMPORT_BYTES).
ALLOWED_SECONDS = (300, 900)  # Guest and member import limits.
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
# Two downloads at once keeps a home connection usable and looks like a person, not a farm.
SLOTS = threading.BoundedSemaphore(2)
CONTENT_TYPES = {".m4a": "audio/mp4", ".mp4": "audio/mp4", ".webm": "audio/webm"}
# yt-dlp reports refusals as text. Final refusals must not be retried by the Worker.
REFUSALS = (
    ("source_denied_bot_verification", re.compile(r"not a bot|captcha|unusual traffic", re.I), 503),
    ("source_denied_private", re.compile(r"private video", re.I), 422),
    ("source_denied_age_restricted", re.compile(r"confirm your age|age[- ]restrict", re.I), 422),
    ("source_denied_unavailable", re.compile(r"video unavailable|not available|has been removed|terminated", re.I), 422),
)


class Refused(Exception):
    def __init__(self, code, status=422):
        super().__init__(code)
        self.code, self.status = code, status


def log(event, **fields):
    # No titles or video IDs: the log shows what happened, not what anyone listened to.
    print(json.dumps({"t": round(time.time()), "event": event, **fields}), file=sys.stderr, flush=True)


def fetch(video_id, max_seconds):
    url = f"https://www.youtube.com/watch?v={video_id}"
    with tempfile.TemporaryDirectory(prefix="stem-yt-") as folder:
        options = {
            "quiet": True, "no_warnings": True, "noplaylist": True, "cachedir": False,
            # AAC first: every browser decodes it, and it needs no re-encoding.
            "format": "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
            "outtmpl": f"{folder}/audio.%(ext)s",
            "max_filesize": MAX_BYTES, "socket_timeout": 20, "retries": 2,
        }
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                info = ydl.extract_info(url, download=False)
                if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming", "post_live"):
                    raise Refused("live_stream")
                duration = info.get("duration")
                if not isinstance(duration, (int, float)) or duration <= 0:
                    raise Refused("duration_unknown")
                if duration > max_seconds:
                    raise Refused("source_too_long")
                ydl.process_ie_result(info, download=True)
        except yt_dlp.utils.DownloadError as error:
            text = str(error)
            for code, pattern, status in REFUSALS:
                if pattern.search(text):
                    raise Refused(code, status) from None
            raise Refused("extractor_failed", 502) from None
        files = [path for path in pathlib.Path(folder).glob("audio.*") if path.suffix in CONTENT_TYPES]
        # yt-dlp skips, rather than truncates, a file over max_filesize.
        if not files:
            raise Refused("audio_too_large", 413)
        data = files[0].read_bytes()
        if not data or len(data) > MAX_BYTES:
            raise Refused("audio_too_large", 413)
        return data, CONTENT_TYPES[files[0].suffix], str(info.get("title") or ""), float(duration)


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
        self.end_headers()
        self.wfile.write(body)

    def refuse(self, status, code):
        self.reply(status, json.dumps({"code": code}).encode())

    def authorized(self):
        supplied = self.headers.get("Authorization", "")
        return bool(SECRET) and hmac.compare_digest(supplied.encode(), b"Bearer " + SECRET)

    def do_GET(self):
        if self.path != "/healthz":
            return self.refuse(404, "not_found")
        if not self.authorized():
            return self.refuse(401, "unauthorized")
        self.reply(200, json.dumps({"ok": True, "ytDlp": yt_dlp.version.__version__}).encode())

    def do_POST(self):
        if self.path != "/audio":
            return self.refuse(404, "not_found")
        if not self.authorized():
            return self.refuse(401, "unauthorized")
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
        if not SLOTS.acquire(timeout=30):
            return self.refuse(429, "fetcher_busy")
        started = time.monotonic()
        try:
            data, content_type, title, duration = fetch(video_id, max_seconds)
        except Refused as refusal:
            log("refused", code=refusal.code, ms=round((time.monotonic() - started) * 1000))
            return self.refuse(refusal.status, refusal.code)
        except Exception as error:  # Never return a traceback to the caller.
            log("failed", error=type(error).__name__, ms=round((time.monotonic() - started) * 1000))
            return self.refuse(502, "extractor_failed")
        finally:
            SLOTS.release()
        log("fetched", bytes=len(data), seconds=round(duration), ms=round((time.monotonic() - started) * 1000))
        self.reply(200, data, content_type, {
            "X-Audio-Title": urllib.parse.quote(title[:200], safe=""),
            "X-Audio-Duration": str(duration),
        })


if __name__ == "__main__":
    if len(SECRET) < 32:
        sys.exit("Set YT_FETCHER_SECRET to at least 32 characters.")
    log("listening", port=PORT, ytDlp=yt_dlp.version.__version__)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
