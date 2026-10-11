"""Bounded import of permitted YouTube audio. No client/cookie/proxy rotation."""
import atexit
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
from pathlib import Path as FilePath
from urllib.parse import parse_qs, urlparse

from cog import BaseModel, BasePredictor, Input, Path

MAX_BYTES = 100 * 1024 * 1024
MAX_SECONDS = 900
TOTAL_SECONDS = 230
FORMAT_SELECTOR = "bestaudio[ext=m4a]/bestaudio/best"
ROOT = FilePath(tempfile.gettempdir()) / "stem-youtube-artifacts"
ACCESS_FAILURES = tuple((code, re.compile(pattern, re.I)) for code, pattern in (
    ("source_denied_bot_verification", r"\b(?:captcha|recaptcha)\b|\b(?:confirm|verify)\b[^\n]{0,120}\b(?:bot|human)\b|\b(?:bot|human)[ -]verification\b"),
    ("source_denied_age_restricted", r"\bage[ -](?:restricted|restriction|verification)\b|\bconfirm your age\b"),
    ("source_denied_private", r"\b(?:video|content) is private\b|\bprivate video\b"),
    ("source_denied_geo_restricted", r"\bnot available in (?:your )?(?:country|region)\b|\bnot made\b[^\n]{0,100}\bavailable in your country\b|\bgeo[ -]?(?:restricted|restriction|blocked)\b|\bblocked in (?:your )?(?:country|region)\b"),
    ("source_denied_content_restricted", r"\b(?:video|content|account|uploader)\b[^\n]{0,80}\b(?:removed|deleted|terminated|suspended)\b|\b(?:copyright|drm)\b|\b(?:video|content) (?:is )?(?:unavailable|not available)\b|\b(?:members|premium|subscriber)[ -]only\b"),
    ("source_denied_authentication", r"\b(?:sign[ -]?in|log[ -]?in) (?:to |is required|required|with )|\b(?:authentication|login) (?:is )?required\b|\brequires authentication\b"),
))
HTTP_STATUS = re.compile(r"\b(?:HTTP(?:Error|\s+(?:Error|status(?:\s+code)?))?|status(?:_code)?)\s*[:=]?\s*(401|403|429)\b", re.I)
JS_FAILURE = re.compile(
    r"\b(?:n|nsig|signature|sig)\s+(?:challenge\s+)?(?:solving|extraction|deciphering)\s+failed\b"
    r"|\b(?:no supported|missing|unsupported)\s+(?:javascript|js)\s+runtime\b"
    r"|\b(?:javascript|js)\s+runtime\b[^\n]{0,100}\b(?:missing|not found|unavailable|failed|required)\b"
    r"|\b(?:deno|ejs)\b[^\n]{0,100}\b(?:not found|missing|failed|unavailable|required)\b"
    r"|\b(?:challenge solver|challenge solving)\b[^\n]{0,100}\b(?:failed|unavailable|missing)\b", re.I)
FORMAT_FAILURE = re.compile(r"\brequested formats?\b[^\n]{0,80}\b(?:not available|unavailable)\b|\bno suitable (?:audio )?formats?\b|\bonly images are available\b", re.I)
_active = set()


def failure_code(stderr):
    """Return fixed diagnostics only; upstream text can contain private values.

    Explicit access failures take precedence over accompanying JS warnings.
    A challenge-solving warning or incidental HTTP digits alone is not denial.
    """
    for code, pattern in ACCESS_FAILURES:
        if pattern.search(stderr):
            return code
    statuses = set(HTTP_STATUS.findall(stderr))
    for status in ("401", "403"):
        if status in statuses:
            return "source_denied_http_" + status
    if "429" in statuses or re.search(r"\btoo many requests\b|\brate[ -]?limit(?:ed|ing)?\b", stderr, re.I):
        return "source_rate_limited"
    if JS_FAILURE.search(stderr):
        return "extractor_failed_js_runtime"
    if FORMAT_FAILURE.search(stderr):
        return "extractor_failed_format_unavailable"
    return "extractor_failed"


def canonical_url(url):
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password or parsed.port:
        raise ValueError("invalid_youtube_url")
    host = (parsed.hostname or "").lower()
    if host.startswith("www.") or host.startswith("m."):
        host = host.split(".", 1)[1]
    video = None
    if host == "youtu.be" and len(parsed.path.strip("/").split("/")) == 1:
        video = parsed.path.strip("/")
    elif host in ("youtube.com", "music.youtube.com", "youtube-nocookie.com"):
        if parsed.path == "/watch":
            video = parse_qs(parsed.query).get("v", [None])[0]
        elif re.fullmatch(r"/(shorts|embed|live)/[\w-]{11}/?", parsed.path):
            video = parsed.path.split("/")[2]
    if not video or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video):
        raise ValueError("invalid_youtube_url")
    return "https://www.youtube.com/watch?v=" + video


def cleanup_stale(now=None):
    """Finished output is retained briefly for Cog's uploader, then collected.
    Failed/cancelled work is removed immediately; startup also clears old roots.
    """
    now = time.time() if now is None else now
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    for child in ROOT.iterdir():
        if child.is_dir() and str(child) not in _active and now - child.stat().st_mtime > 3600:
            shutil.rmtree(child, ignore_errors=True)


class Output(BaseModel):
    audio: Path
    title: str
    duration: float


class Predictor(BasePredictor):
    def setup(self):
        cleanup_stale()
        for command in ("yt-dlp", "deno", "ffmpeg", "ffprobe"):
            if shutil.which(command) is None:
                raise RuntimeError("extractor_dependency_missing")
        atexit.register(self._cleanup_active)

    def _cleanup_active(self):
        for directory in list(_active):
            shutil.rmtree(directory, ignore_errors=True)

    def predict(self, url: str = Input(description="Permitted YouTube video URL"),
                max_duration: int = Input(description="Duration ceiling", default=900)) -> Output:
        url = canonical_url(url)
        ceiling = min(MAX_SECONDS, max(1, int(max_duration)))
        cleanup_stale()
        directory = tempfile.mkdtemp(prefix="import-", dir=ROOT)
        _active.add(directory)
        keep = False
        deadline = time.monotonic() + TOTAL_SECONDS
        common = ["yt-dlp", "--ignore-config", "--no-playlist", "--no-cookies", "--no-cache-dir",
                  "--js-runtimes", "deno", "--no-remote-components", "--socket-timeout", "20",
                  "--retries", "0", "--fragment-retries", "0", "--extractor-retries", "0",
                  "--concurrent-fragments", "1", "--max-filesize", str(MAX_BYTES)]
        try:
            info = json.loads(self._run(common + ["-J", "--skip-download", "--", url], deadline))
            if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
                raise ValueError("Live streams cannot be imported.")
            duration = float(info.get("duration") or 0)
            if not 0 < duration <= ceiling:
                raise ValueError("Video is longer than 15 minutes or has no usable duration.")
            availability = info.get("availability")
            if availability in ("private", "premium_only", "subscriber_only", "needs_auth"):
                reason = "private" if availability == "private" else "authentication" if availability == "needs_auth" else "content_restricted"
                raise ValueError("source_denied_" + reason)
            if info.get("age_limit", 0) > 0:
                raise ValueError("source_denied_age_restricted")
            self._run(common + ["-f", FORMAT_SELECTOR, "-x", "--audio-format", "m4a",
                              "--postprocessor-args", "ffmpeg:-fs 104857600", "-o", os.path.join(directory, "audio.%(ext)s"), "--", url], deadline)
            out = os.path.join(directory, "audio.m4a")
            if not os.path.isfile(out) or not 1024 <= os.path.getsize(out) <= MAX_BYTES:
                raise ValueError("invalid_audio_response")
            probe = json.loads(self._run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name", "-of", "json", out], deadline))
            decoded_duration = float(probe.get("format", {}).get("duration") or 0)
            if not 0 < decoded_duration <= ceiling or not any(s.get("codec_type") == "audio" for s in probe.get("streams", [])):
                raise ValueError("invalid_audio_response")
            # ffprobe metadata alone is not successful decoding.
            self._run(["ffmpeg", "-v", "error", "-xerror", "-i", out, "-map", "0:a:0", "-f", "null", "-"], deadline)
            for child in FilePath(directory).iterdir():
                if str(child) != out:
                    child.unlink(missing_ok=True)
            keep = True
            return Output(audio=Path(out), title=str(info.get("title") or "youtube-audio")[:200], duration=decoded_duration)
        finally:
            _active.discard(directory)
            if not keep:
                shutil.rmtree(directory, ignore_errors=True)

    def _run(self, cmd, deadline=None):
        timeout = min(90, (deadline or time.monotonic() + 90) - time.monotonic())
        if timeout <= 0:
            raise ValueError("extractor_timeout")
        # A process group lets timeout/cancellation kill ffmpeg descendants too.
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
            proc = subprocess.Popen(cmd, stdout=output, stderr=errors, start_new_session=True)
            try:
                proc.wait(timeout=timeout)
            except BaseException:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait()
                raise ValueError("extractor_timeout_or_cancelled") from None
            # Keep provider diagnostics bounded and private. Disk-backed capture
            # prevents a giant metadata/error response exhausting process RAM.
            output.seek(0, os.SEEK_END)
            if output.tell() > 8 * 1024 * 1024:
                raise ValueError("extractor_response_too_large")
            output.seek(0)
            stdout = output.read(8 * 1024 * 1024).decode("utf-8", errors="strict")
            errors.seek(0)
            stderr = errors.read(64 * 1024).decode("utf-8", errors="replace")
            if proc.returncode:
                raise ValueError(failure_code(stderr))
            return stdout
