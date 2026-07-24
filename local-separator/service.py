#!/usr/bin/env python3
"""Small authenticated HTTP service around Audio Separator.

The Cloudflare Worker submits a source URL, polls this service, and ingests the
two returned tracks through the same provider-neutral contract used by
Replicate. The service deliberately uses only the Python standard library for
HTTP; `audio-separator` is imported lazily by the real runner.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import mimetypes
import os
import re
import secrets
import shutil
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urlparse
from urllib.request import Request, urlopen

LOG = logging.getLogger("local-separator")

BS_ROFORMER_CHECKPOINT = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
BS_ROFORMER_CONFIG = "model_bs_roformer_ep_317_sdr_12.9755.yaml"
PINNED_FILE_SHA256 = {
    BS_ROFORMER_CHECKPOINT: "5b84f37e8d444c8cb30c79d77f613a41c05868ff9c9ac6c7049c00aefae115aa",
    BS_ROFORMER_CONFIG: "2bfdd16c656bd9519aba757cc4f8834b7ede675eb1e00ec4772d74ae1c41af7f",
}
MODEL_FILES = {
    "bs_roformer_vocals": BS_ROFORMER_CHECKPOINT,
    "htdemucs_ft": "htdemucs_ft.yaml",
    "htdemucs_6s": "htdemucs_6s.yaml",
}
MODEL_STEMS = {
    "bs_roformer_vocals": ("vocals", "instrumental"),
    "htdemucs_ft": ("vocals", "drums", "bass", "other"),
    "htdemucs_6s": ("vocals", "drums", "bass", "guitar", "piano", "other"),
}
MAX_SOURCE_BYTES = 100 * 1024 * 1024


@dataclass
class StemFile:
    name: str
    path: Path


@dataclass
class Job:
    id: str
    source_url: str
    webhook_url: str | None
    model: str
    status: str = "queued"
    stems: list[StemFile] = field(default_factory=list)
    error: str | None = None
    file_token: str = field(default_factory=lambda: secrets.token_urlsafe(24))


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def add(self, job: Job) -> None:
        with self._lock:
            self._jobs[job.id] = job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def update(
        self,
        job_id: str,
        *,
        status: str,
        stems: list[StemFile] | None = None,
        error: str | None = None,
    ) -> Job:
        with self._lock:
            job = self._jobs[job_id]
            job.status = status
            if stems is not None:
                job.stems = stems
            job.error = error
            return job


class AudioSeparatorRunner:
    """Caches loaded models and serializes inference on the local accelerator."""

    def __init__(self, output_root: Path, model_root: Path) -> None:
        self.output_root = output_root
        self.model_root = model_root
        self._separators: dict[str, object] = {}
        self._lock = threading.Lock()

    def separate(self, job_id: str, source_path: Path, model: str) -> list[StemFile]:
        from audio_separator.separator import Separator

        model_file = MODEL_FILES[model]
        stems = MODEL_STEMS[model]
        job_dir = self.output_root / job_id
        job_dir.mkdir(parents=True, exist_ok=True)

        with self._lock:
            separator = self._separators.get(model)
            if separator is None:
                separator = Separator(
                    model_file_dir=str(self.model_root),
                    output_dir=str(job_dir),
                    output_format="MP3",
                    output_bitrate="192k",
                )
                if model == "bs_roformer_vocals":
                    # Download without deserializing the checkpoint, verify the
                    # pinned model and config, then allow load_model to read it.
                    separator.download_model_and_data(model_filename=model_file)
                    for filename, expected in PINNED_FILE_SHA256.items():
                        verify_file_sha256(self.model_root / filename, expected)
                separator.load_model(model_filename=model_file)
                self._separators[model] = separator
            else:
                separator.output_dir = str(job_dir)
                separator.model_instance.output_dir = str(job_dir)

            output_names = {stem: stem for stem in stems}
            output_paths = separator.separate(
                str(source_path),
                custom_output_names=output_names,
            )

        by_name: dict[str, Path] = {}
        for output_path in output_paths:
            resolved = Path(output_path)
            if not resolved.is_absolute():
                resolved = job_dir / resolved
            by_name[resolved.stem.lower()] = resolved.resolve()

        results: list[StemFile] = []
        for stem in stems:
            path = by_name.get(stem)
            if path is None or not path.is_file():
                raise RuntimeError(f"separator did not produce the {stem} track")
            if job_dir.resolve() not in path.parents:
                raise RuntimeError("separator output escaped its job directory")
            results.append(StemFile(stem, path))
        return results


def verify_file_sha256(path: Path, expected: str) -> None:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
    except FileNotFoundError:
        raise RuntimeError(f"pinned Audio Separator file is missing: {path.name}") from None
    if not secrets.compare_digest(digest.hexdigest(), expected):
        raise RuntimeError(f"checksum mismatch for pinned Audio Separator file: {path.name}")


class SeparationApp:
    def __init__(
        self,
        *,
        token: str,
        public_url: str,
        data_root: Path,
        runner: AudioSeparatorRunner,
        downloader: Callable[[str, Path], None] | None = None,
    ) -> None:
        self.token = token
        self.public_url = public_url.rstrip("/")
        self.data_root = data_root
        self.data_root.mkdir(parents=True, exist_ok=True)
        self.runner = runner
        self.downloader = downloader or download_source
        self.jobs = JobStore()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="separator")

    def submit(self, source_url: str, webhook_url: str | None, model: str) -> Job:
        job = Job(id=str(uuid.uuid4()), source_url=source_url, webhook_url=webhook_url, model=model)
        self.jobs.add(job)
        self.executor.submit(self._run, job.id)
        return job

    def payload(self, job: Job) -> dict[str, object]:
        file_token = f"?token={quote(job.file_token)}"
        stems = [
            {
                "name": stem.name,
                "url": (
                    f"{self.public_url}/v1/files/{quote(job.id)}/"
                    f"{quote(stem.name)}.mp3{file_token}"
                ),
            }
            for stem in job.stems
        ]
        return {
            "id": job.id,
            "status": job.status,
            "stems": stems,
            "error": job.error,
        }

    def close(self) -> None:
        self.executor.shutdown(wait=True, cancel_futures=True)

    def _run(self, job_id: str) -> None:
        job = self.jobs.update(job_id, status="processing")
        job_dir = self.data_root / job.id
        job_dir.mkdir(parents=True, exist_ok=True)
        suffix = Path(unquote(urlparse(job.source_url).path)).suffix.lower()
        if suffix not in {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aiff", ".aif"}:
            suffix = ".audio"
        source_path = job_dir / f"source{suffix}"

        try:
            self.downloader(job.source_url, source_path)
            stems = self.runner.separate(job.id, source_path, job.model)
            job = self.jobs.update(job.id, status="succeeded", stems=stems)
        except Exception as exc:
            LOG.error("job %s failed: %s", job.id, exc)
            job = self.jobs.update(job.id, status="failed", error=str(exc)[:500])

        if job.webhook_url:
            post_webhook(job.webhook_url, self.payload(job))


def download_source(url: str, destination: Path) -> None:
    request = Request(url, headers={"User-Agent": "stem-splitter-local-separator/0.1"})
    try:
        with urlopen(request, timeout=120) as response, destination.open("wb") as output:
            declared = int(response.headers.get("content-length", "0") or 0)
            if declared > MAX_SOURCE_BYTES:
                raise RuntimeError("source audio exceeds 100 MB")
            total = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_SOURCE_BYTES:
                    raise RuntimeError("source audio exceeds 100 MB")
                output.write(chunk)
    except HTTPError as exc:
        raise RuntimeError(f"source download failed with HTTP {exc.code}") from None
    except URLError:
        raise RuntimeError("source download failed") from None


def post_webhook(url: str, payload: dict[str, object]) -> None:
    request = Request(
        url,
        method="POST",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urlopen(request, timeout=15) as response:
            if response.status >= 300:
                LOG.warning("webhook returned HTTP %s", response.status)
    except (HTTPError, URLError):
        # Polling is the durable fallback, so a localhost race is harmless.
        LOG.warning("webhook delivery failed; the Worker can reconcile by polling")


class AppServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], app: SeparationApp):
        super().__init__(address, RequestHandler)
        self.app = app


class RequestHandler(BaseHTTPRequestHandler):
    server: AppServer

    def log_message(self, pattern: str, *args: object) -> None:
        message = re.sub(r"([?&]token=)[^ &\"]+", r"\1[redacted]", pattern % args)
        LOG.info("%s - %s", self.client_address[0], message)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/health":
            self._json(200, {"ok": True, "models": list(MODEL_FILES)})
            return

        parts = path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["v1", "jobs"]:
            if not self._authorized():
                return
            job = self.server.app.jobs.get(unquote(parts[2]))
            if job is None:
                self._json(404, {"error": "job not found"})
                return
            self._json(200, self.server.app.payload(job))
            return

        if len(parts) == 4 and parts[:2] == ["v1", "files"]:
            job = self.server.app.jobs.get(unquote(parts[2]))
            stem_name = Path(unquote(parts[3])).stem
            if job is None or job.status != "succeeded":
                self._json(404, {"error": "file not found"})
                return
            query_token = parse_qs(urlparse(self.path).query).get("token", [""])[0]
            if not secrets.compare_digest(query_token, job.file_token):
                self._json(401, {"error": "unauthorized"})
                return
            stem = next((item for item in job.stems if item.name == stem_name), None)
            if stem is None or not stem.path.is_file():
                self._json(404, {"error": "file not found"})
                return
            self._file(stem.path)
            return

        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path != "/v1/jobs":
            self._json(404, {"error": "not found"})
            return
        if not self._authorized():
            return

        try:
            size = int(self.headers.get("content-length", "0"))
            if size <= 0 or size > 64 * 1024:
                raise ValueError("invalid body size")
            body = json.loads(self.rfile.read(size))
        except (ValueError, json.JSONDecodeError):
            self._json(400, {"error": "invalid JSON body"})
            return

        source_url = body.get("audio_url")
        webhook_url = body.get("webhook_url")
        model = body.get("model") or "bs_roformer_vocals"
        if not isinstance(source_url, str) or not source_url.startswith(("http://", "https://")):
            self._json(400, {"error": "audio_url must be HTTP(S)"})
            return
        if webhook_url is not None and (
            not isinstance(webhook_url, str) or not webhook_url.startswith(("http://", "https://"))
        ):
            self._json(400, {"error": "webhook_url must be HTTP(S)"})
            return
        if model not in MODEL_FILES:
            self._json(400, {"error": f"unsupported model: {model}"})
            return

        job = self.server.app.submit(source_url, webhook_url, model)
        self._json(202, self.server.app.payload(job))

    def _authorized(self) -> bool:
        expected = self.server.app.token
        supplied = self.headers.get("authorization", "")
        bearer_ok = secrets.compare_digest(supplied, f"Bearer {expected}")
        if expected and not bearer_ok:
            self._json(401, {"error": "unauthorized"})
            return False
        return True

    def _json(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path) -> None:
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "audio/mpeg")
        self.send_header("Content-Length", str(path.stat().st_size))
        self.send_header("Cache-Control", "private, max-age=3600")
        self.end_headers()
        with path.open("rb") as source:
            shutil.copyfileobj(source, self.wfile)


def build_app(host: str, port: int) -> tuple[SeparationApp, AppServer]:
    root = Path(os.environ.get("AUDIO_SEPARATOR_DATA_DIR", "local-separator/.data")).resolve()
    models = Path(os.environ.get("AUDIO_SEPARATOR_MODEL_DIR", "local-separator/.models")).resolve()
    root.mkdir(parents=True, exist_ok=True)
    models.mkdir(parents=True, exist_ok=True)
    public_url = os.environ.get("AUDIO_SEPARATOR_PUBLIC_URL", f"http://{host}:{port}")
    token = os.environ.get("AUDIO_SEPARATOR_TOKEN", "local-separator-token")
    runner = AudioSeparatorRunner(root, models)
    app = SeparationApp(
        token=token,
        public_url=public_url,
        data_root=root,
        runner=runner,
    )
    return app, AppServer((host, port), app)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local Audio Separator service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    app, server = build_app(args.host, args.port)
    LOG.info("Audio Separator service listening on http://%s:%s", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
        app.close()


if __name__ == "__main__":
    main()
