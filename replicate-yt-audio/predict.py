"""YouTube audio fetcher for the stem-splitter app.

Downloads the best audio-only track as M4A (Demucs ingests M4A directly).
Raises ValueError with student-readable messages; the Worker surfaces
prediction errors verbatim.
"""

import json
import os
import subprocess
import tempfile
from urllib.parse import urlparse

from cog import BaseModel, BasePredictor, Input, Path


class Output(BaseModel):
    audio: Path
    title: str
    duration: float


class Predictor(BasePredictor):
    def predict(
        self,
        url: str = Input(description="YouTube video URL"),
        max_duration: int = Input(
            description="Reject videos longer than this many seconds", default=900
        ),
    ) -> Output:
        # The URL is untrusted input; never let it be parsed as a yt-dlp flag.
        parsed = urlparse(url)
        if url.startswith("-") or parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError("Not a valid http(s) URL.")

        info = self._probe(url)

        if info.get("is_live"):
            raise ValueError("Live streams cannot be imported.")
        duration = float(info.get("duration") or 0)
        if duration > max_duration:
            minutes = max_duration // 60
            raise ValueError(f"Video is longer than {minutes} minutes — pick a shorter one.")

        tmp = tempfile.mkdtemp()
        # %(ext)s keeps a video-container download from colliding with the
        # extracted M4A; -x --audio-format m4a makes the final name stable.
        template = os.path.join(tmp, "audio.%(ext)s")
        out = os.path.join(tmp, "audio.m4a")
        # YouTube requires PO tokens for web-client format URLs from datacenter
        # IPs (media downloads 403 even when metadata succeeds). These app
        # clients are exempt from that requirement to varying degrees, so try
        # them in order until one delivers audio. Some expose no audio-only
        # formats, hence the /best fallback — extraction transcodes to M4A.
        last_error = None
        for client in ("android", "android_vr", "tv", "ios", "default"):
            try:
                self._run(
                    [
                        "yt-dlp",
                        "--no-playlist",
                        "--extractor-args",
                        f"youtube:player_client={client}",
                        "-f",
                        "bestaudio[ext=m4a]/bestaudio/best",
                        "-x",
                        "--audio-format",
                        "m4a",
                        "-o",
                        template,
                        "--",
                        url,
                    ]
                )
            except ValueError as err:
                last_error = err
                print(f"[yt-audio] client {client} failed: {err}", flush=True)
                continue
            if os.path.exists(out):
                print(f"[yt-audio] client {client} delivered audio", flush=True)
                break
        if not os.path.exists(out):
            if last_error is not None:
                raise last_error
            raise ValueError("YouTube returned no audio track for this video.")

        return Output(
            audio=Path(out),
            title=info.get("title") or "youtube-audio",
            duration=duration,
        )

    def _probe(self, url: str) -> dict:
        stdout = self._run(["yt-dlp", "-J", "--no-playlist", "--", url])
        return json.loads(stdout)

    def _run(self, cmd: list) -> str:
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            # Last stderr line usually carries yt-dlp's human-readable reason.
            reason = (proc.stderr or "").strip().splitlines()[-1:] or ["unknown error"]
            raise ValueError(f"YouTube fetch failed: {reason[0][:300]}")
        return proc.stdout
