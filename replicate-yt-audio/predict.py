"""YouTube audio fetcher for the stem-splitter app.

Downloads the best audio-only track as M4A (Demucs ingests M4A directly).
Raises ValueError with student-readable messages; the Worker surfaces
prediction errors verbatim.
"""

import json
import os
import subprocess
import tempfile

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
        info = self._probe(url)

        if info.get("is_live"):
            raise ValueError("Live streams cannot be imported.")
        duration = float(info.get("duration") or 0)
        if duration > max_duration:
            minutes = max_duration // 60
            raise ValueError(f"Video is longer than {minutes} minutes — pick a shorter one.")

        tmp = tempfile.mkdtemp()
        out = os.path.join(tmp, "audio.m4a")
        self._run(
            [
                "yt-dlp",
                "--no-playlist",
                "-f",
                "bestaudio[ext=m4a]/bestaudio",
                "-x",
                "--audio-format",
                "m4a",
                "-o",
                out,
                url,
            ]
        )
        if not os.path.exists(out):
            raise ValueError("YouTube returned no audio track for this video.")

        return Output(
            audio=Path(out),
            title=info.get("title") or "youtube-audio",
            duration=duration,
        )

    def _probe(self, url: str) -> dict:
        stdout = self._run(["yt-dlp", "-J", "--no-playlist", url])
        return json.loads(stdout)

    def _run(self, cmd: list) -> str:
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            # Last stderr line usually carries yt-dlp's human-readable reason.
            reason = (proc.stderr or "").strip().splitlines()[-1:] or ["unknown error"]
            raise ValueError(f"YouTube fetch failed: {reason[0][:300]}")
        return proc.stdout
