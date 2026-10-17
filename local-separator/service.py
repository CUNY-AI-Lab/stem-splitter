#!/usr/bin/env python3
"""Small authenticated HTTP service around Audio Separator.

The Stem Splitter app submits a source URL, receives a completion webhook or
polls this service, and ingests the returned tracks through the same
provider-neutral contract used by Replicate. The same service runs on a
developer laptop (loopback only) and on the self-hosted GPU host behind a
Cloudflare Tunnel (docs/legion-separator.md). The service deliberately uses only
the Python standard library for HTTP; `audio-separator` and `torch` are imported
lazily by the real runner and the device probe.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import logging
import mimetypes
import os
import re
import secrets
import shutil
import signal
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen

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

# Match the pinned Replicate `ryan5453/demucs` inputs (shifts 1, overlap 0.25,
# split on, default segment) so a job sounds the same whichever provider ran
# it. Audio Separator's own default is shifts 2, which is slower and differs.
DEMUCS_PARAMS = {"segment_size": "Default", "shifts": 1, "overlap": 0.25, "segments_enabled": True}
DEMUCS_MODELS = frozenset({"htdemucs_ft", "htdemucs_6s"})
# Demucs's `rescale` clip mode divides a stem by 1.01x its peak only when it
# would clip. Audio Separator scales any stem whose peak exceeds this limit.
DEMUCS_PEAK_LIMIT = 0.99

DEFAULT_TOKEN = "local-separator-token"
MIN_PUBLIC_TOKEN_LENGTH = 32
# The app treats exactly this 404 body as "the service lost the job" (for
# example after a restart) and fails the job instead of polling forever.
JOB_NOT_FOUND = {"error": "job not found"}
WEBHOOK_BACKOFF_SECONDS: tuple[float, ...] = (0, 2, 10)
SWEEP_INTERVAL_SECONDS = 3600
DRAIN_FILENAME = "DRAIN"
TERMINAL_STATUSES = frozenset({"succeeded", "failed"})
# Errors after which the CUDA context is unusable for every later job.
FATAL_GPU_ERROR = re.compile(
    r"CUDA error|cuDNN error|CUBLAS_STATUS|CUDA driver|no CUDA-capable device|device-side assert",
    re.IGNORECASE,
)
GPU_FAILED_MESSAGE = "The GPU failed during this split. Start the split again."
EX_TEMPFAIL = 75


class Busy(Exception):
    """The service is draining or its pending-job cap is reached."""


class StartupError(Exception):
    """Configuration that must stop the service before it accepts traffic."""


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
    finished_at: float | None = None


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

    def pending_count(self) -> int:
        with self._lock:
            return sum(1 for job in self._jobs.values() if job.status not in TERMINAL_STATUSES)

    def evict_finished_before(self, cutoff: float) -> list[str]:
        """Forget terminal jobs that finished before `cutoff`; return their ids."""
        with self._lock:
            expired = [
                job.id
                for job in self._jobs.values()
                if job.finished_at is not None and job.finished_at < cutoff
            ]
            for job_id in expired:
                del self._jobs[job_id]
            return expired

    def update(
        self,
        job_id: str,
        *,
        status: str,
        stems: list[StemFile] | None = None,
        error: str | None = None,
        finished_at: float | None = None,
    ) -> Job:
        with self._lock:
            job = self._jobs[job_id]
            job.status = status
            if stems is not None:
                job.stems = stems
            job.error = error
            if finished_at is not None:
                job.finished_at = finished_at
            return job


def separator_options(model: str, job_dir: Path, model_root: Path) -> dict[str, object]:
    """Constructor arguments for Audio Separator's `Separator` for one profile."""
    options: dict[str, object] = {
        "model_file_dir": str(model_root),
        "output_dir": str(job_dir),
        "output_format": "MP3",
        "output_bitrate": "192k",
    }
    if model in DEMUCS_MODELS:
        options["demucs_params"] = dict(DEMUCS_PARAMS)
        options["normalization_threshold"] = DEMUCS_PEAK_LIMIT
    return options


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
                separator = Separator(**separator_options(model, job_dir, self.model_root))
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
        max_pending: int = 0,
        retention_seconds: float = 24 * 3600,
        device: str = "unknown",
        clock: Callable[[], float] = time.time,
        webhook_sender: Callable[[str, dict[str, object]], object] | None = None,
        on_gpu_failure: Callable[[], None] | None = None,
    ) -> None:
        self.token = token
        self.public_url = public_url.rstrip("/")
        self.data_root = data_root
        self.data_root.mkdir(parents=True, exist_ok=True)
        self.runner = runner
        self.downloader = downloader or download_source
        # 0 means unbounded, which keeps local dev and the e2e harnesses as they were.
        self.max_pending = max(0, max_pending)
        self.retention_seconds = retention_seconds
        self.device = device
        self.clock = clock
        self.webhook_sender = webhook_sender or send_webhook_in_background
        self.on_gpu_failure = on_gpu_failure or exit_for_restart
        self.gpu_failed = False
        self.jobs = JobStore()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="separator")
        self._admission = threading.Lock()

    def accepting(self) -> bool:
        if self.gpu_failed or (self.data_root / DRAIN_FILENAME).exists():
            return False
        return not self.max_pending or self.jobs.pending_count() < self.max_pending

    def submit(self, source_url: str, webhook_url: str | None, model: str) -> Job:
        with self._admission:
            if not self.accepting():
                raise Busy("separator busy")
            job = Job(id=str(uuid.uuid4()), source_url=source_url, webhook_url=webhook_url, model=model)
            self.jobs.add(job)
        self.executor.submit(self._run, job.id)
        return job

    def health(self) -> dict[str, object]:
        return {
            "ok": True,
            "models": list(MODEL_FILES),
            # "failed" makes an uptime monitor expecting "cuda" alert.
            "device": "failed" if self.gpu_failed else self.device,
            "pending": self.jobs.pending_count(),
            "accepting": self.accepting(),
        }

    def sweep(self) -> int:
        """Delete the files of terminal jobs older than the retention window."""
        expired = self.jobs.evict_finished_before(self.clock() - self.retention_seconds)
        for job_id in expired:
            shutil.rmtree(self.data_root / job_id, ignore_errors=True)
        return len(expired)

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

        gpu_failed = False
        try:
            self.downloader(job.source_url, source_path)
            stems = self.runner.separate(job.id, source_path, job.model)
            job = self.jobs.update(job.id, status="succeeded", stems=stems, finished_at=self.clock())
        except Exception as exc:
            LOG.error("job %s failed: %s", job.id, exc)
            gpu_failed = self.device == "cuda" and is_fatal_gpu_error(exc)
            if gpu_failed:
                # A poisoned CUDA context fails every later job too. Stop
                # admitting work at once so new starts fall back to Replicate.
                self.gpu_failed = True
            error = GPU_FAILED_MESSAGE if gpu_failed else str(exc)[:500]
            job = self.jobs.update(job.id, status="failed", error=error, finished_at=self.clock())
        finally:
            # The source is someone's song. Keep it only as long as inference needs it.
            source_path.unlink(missing_ok=True)

        if job.webhook_url:
            delivery = self.webhook_sender(job.webhook_url, self.payload(job))
            if gpu_failed and isinstance(delivery, threading.Thread):
                delivery.join(timeout=30)
        if gpu_failed:
            self.on_gpu_failure()


def is_fatal_gpu_error(exc: BaseException) -> bool:
    """True for CUDA failures that poison the process (not an out-of-memory error)."""
    message = f"{type(exc).__name__}: {exc}"
    if "out of memory" in message.lower():
        return False
    return bool(FATAL_GPU_ERROR.search(message))


def exit_for_restart() -> None:
    LOG.critical("the GPU failed during a split; exiting so systemd restarts and re-probes CUDA")
    # os._exit skips interpreter cleanup that a broken CUDA context can hang in.
    os._exit(EX_TEMPFAIL)


def purge_orphans(data_root: Path) -> int:
    """Delete job folders left by a previous process; nothing can serve them now.

    Only UUID-named folders are touched, so a model cache or any other folder
    that shares the data root survives.
    """
    removed = 0
    if not data_root.is_dir():
        return removed
    for entry in data_root.iterdir():
        if not entry.is_dir() or entry.is_symlink():
            continue
        try:
            uuid.UUID(entry.name)
        except ValueError:
            continue
        shutil.rmtree(entry, ignore_errors=True)
        removed += 1
    return removed


def _is_loopback(host: str | None) -> bool:
    if not host:
        return False
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def validate_public_config(
    token: str, public_url: str, bind_host: str, declared_exposed: bool = False
) -> None:
    """Refuse a weak token whenever the service can be reached off this machine.

    A tunnel forwards to 127.0.0.1, so a loopback bind proves nothing. The GPU
    host's unit sets AUDIO_SEPARATOR_EXPOSED=1 (declared_exposed), which makes a
    missing or misspelled public URL a startup error instead of a quiet
    downgrade to the dev rules.
    """
    public_host = urlparse(public_url).hostname
    if declared_exposed and (_is_loopback(public_host) or urlparse(public_url).scheme != "https"):
        raise StartupError(
            "AUDIO_SEPARATOR_PUBLIC_URL must be the tunnel's https:// hostname when "
            "AUDIO_SEPARATOR_EXPOSED is set; the app downloads stems from it"
        )
    exposed = declared_exposed or not _is_loopback(bind_host) or not _is_loopback(public_host)
    if not exposed:
        return
    if not token or token == DEFAULT_TOKEN or len(token) < MIN_PUBLIC_TOKEN_LENGTH:
        raise StartupError(
            "AUDIO_SEPARATOR_TOKEN must be a non-default secret of at least "
            f"{MIN_PUBLIC_TOKEN_LENGTH} characters when the service is reachable off loopback"
        )


def detect_device(require_cuda: bool) -> str:
    """Report the accelerator torch will use; prove CUDA works when it is required."""
    try:
        import torch
    except ImportError:
        if require_cuda:
            raise StartupError("AUDIO_SEPARATOR_REQUIRE_CUDA is set but torch is not installed") from None
        return "cpu"

    if torch.cuda.is_available():
        try:
            # A tiny matmul fails with "no kernel image is available" when the
            # installed wheel has no kernels for this GPU (e.g. sm_120 on a
            # cu126 build), which is_available() alone does not catch.
            probe = torch.ones(8, 8, device="cuda")
            float((probe @ probe).sum().item())
        except Exception as exc:
            # Audio Separator picks CUDA from is_available() alone, so it would
            # run every split on this broken device. Refuse to start either way.
            raise StartupError(f"CUDA is present but unusable: {exc}") from None
        major, minor = torch.cuda.get_device_capability(0)
        LOG.info(
            "CUDA device %s (sm_%s%s), torch %s built for %s",
            torch.cuda.get_device_name(0),
            major,
            minor,
            torch.__version__,
            " ".join(torch.cuda.get_arch_list()),
        )
        return "cuda"
    if require_cuda:
        raise StartupError("AUDIO_SEPARATOR_REQUIRE_CUDA is set but CUDA is not available")
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


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


class _RefuseRedirects(HTTPRedirectHandler):
    """A redirected webhook would become a body-less GET; report it instead."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


WEBHOOK_OPENER = build_opener(_RefuseRedirects)


def post_webhook(url: str, payload: dict[str, object]) -> tuple[str, str]:
    """POST one completion webhook. Returns (outcome, detail) and never logs the URL.

    outcome is "delivered", "retry" (network error, timeout, 429 or 5xx), or
    "rejected" (any other 4xx, which another attempt would not change).
    """
    request = Request(
        url,
        method="POST",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with WEBHOOK_OPENER.open(request, timeout=15):
            return "delivered", ""
    except HTTPError as exc:
        # Redirects are refused (WEBHOOK_OPENER), so a 3xx lands here as a rejection.
        try:
            detail = exc.read(500).decode(errors="replace").strip()
        except Exception:
            detail = ""
        described = f"HTTP {exc.code}{f': {detail}' if detail else ''}"
        if exc.code == 429 or exc.code >= 500:
            return "retry", described
        return "rejected", described
    except URLError as exc:
        return "retry", str(exc.reason)
    except Exception as exc:
        # Timeouts, resets, TLS errors and malformed responses are transient,
        # and must never escape the webhook thread as an unhandled traceback.
        return "retry", type(exc).__name__


def deliver_webhook(
    url: str,
    payload: dict[str, object],
    *,
    backoff: Sequence[float] = WEBHOOK_BACKOFF_SECONDS,
    sleep: Callable[[float], None] = time.sleep,
) -> bool:
    detail = ""
    for attempt, delay in enumerate(backoff, start=1):
        if delay:
            sleep(delay)
        outcome, detail = post_webhook(url, payload)
        if outcome == "delivered":
            return True
        if outcome == "rejected":
            break
        if attempt < len(backoff):
            LOG.info("webhook attempt %s failed (%s); retrying", attempt, detail)
    LOG.warning(
        "webhook delivery failed (%s); the app can reconcile by polling",
        detail,
    )
    return False


def send_webhook_in_background(url: str, payload: dict[str, object]) -> threading.Thread:
    # Off the inference thread, so retries never delay the next queued split.
    thread = threading.Thread(target=deliver_webhook, args=(url, payload), name="webhook", daemon=True)
    thread.start()
    return thread


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
            self._json(200, self.server.app.health())
            return

        parts = path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["v1", "jobs"]:
            if not self._authorized():
                return
            job = self.server.app.jobs.get(unquote(parts[2]))
            if job is None:
                self._json(404, JOB_NOT_FOUND)
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

        try:
            job = self.server.app.submit(source_url, webhook_url, model)
        except Busy:
            # The app reads any start failure as "use the fallback provider".
            self._json(503, {"error": "separator busy"}, headers={"Retry-After": "30"})
            return
        self._json(202, self.server.app.payload(job))

    def _authorized(self) -> bool:
        expected = self.server.app.token
        supplied = self.headers.get("authorization", "")
        bearer_ok = secrets.compare_digest(supplied, f"Bearer {expected}")
        if expected and not bearer_ok:
            self._json(401, {"error": "unauthorized"})
            return False
        return True

    def _json(
        self,
        status: int,
        payload: dict[str, object],
        headers: dict[str, str] | None = None,
    ) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path) -> None:
        try:
            source = path.open("rb")
        except FileNotFoundError:
            # The retention sweep removed it between the lookup and now.
            self._json(404, {"error": "file not found"})
            return
        with source:
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "audio/mpeg")
            self.send_header("Content-Length", str(os.fstat(source.fileno()).st_size))
            self.send_header("Cache-Control", "private, max-age=3600")
            self.end_headers()
            shutil.copyfileobj(source, self.wfile)


def _env_number(name: str, default: float, cast: Callable[[str], float]) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = cast(raw)
    except ValueError:
        raise StartupError(f"{name} must be a number") from None
    if value < 0:
        raise StartupError(f"{name} must not be negative")
    return value


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes"}


def build_app(host: str, port: int) -> tuple[SeparationApp, AppServer]:
    root = Path(os.environ.get("AUDIO_SEPARATOR_DATA_DIR", "local-separator/.data")).resolve()
    models = Path(os.environ.get("AUDIO_SEPARATOR_MODEL_DIR", "local-separator/.models")).resolve()
    public_url = os.environ.get("AUDIO_SEPARATOR_PUBLIC_URL", f"http://{host}:{port}")
    token = os.environ.get("AUDIO_SEPARATOR_TOKEN", DEFAULT_TOKEN)
    validate_public_config(token, public_url, host, _env_flag("AUDIO_SEPARATOR_EXPOSED"))
    max_pending = int(_env_number("AUDIO_SEPARATOR_MAX_PENDING", 0, int))
    retention_hours = _env_number("AUDIO_SEPARATOR_RETENTION_HOURS", 24, float)
    device = detect_device(_env_flag("AUDIO_SEPARATOR_REQUIRE_CUDA"))

    models.mkdir(parents=True, exist_ok=True)
    runner = AudioSeparatorRunner(root, models)
    app = SeparationApp(
        token=token,
        public_url=public_url,
        data_root=root,
        runner=runner,
        max_pending=max_pending,
        retention_seconds=retention_hours * 3600,
        device=device,
    )
    try:
        server = AppServer((host, port), app)
    except OSError as exc:
        app.close()
        raise StartupError(f"cannot listen on {host}:{port}: {exc.strerror or exc}") from None
    # Only after the port is ours: a second copy started by mistake must not
    # delete the job folders of the instance that is already serving them.
    purged = purge_orphans(root)
    if purged:
        LOG.info("removed %s job folder(s) left by a previous run", purged)
    return app, server


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local Audio Separator service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    try:
        app, server = build_app(args.host, args.port)
    except StartupError as exc:
        LOG.error("refusing to start: %s", exc)
        # EX_CONFIG. Under systemd the unit restarts and keeps failing, so the
        # tunnel answers 502 and the app sends every job to its fallback.
        raise SystemExit(78) from None
    LOG.info(
        "Audio Separator service listening on http://%s:%s (device %s)",
        args.host,
        args.port,
        app.device,
    )

    stop_sweeping = threading.Event()
    # Hourly in normal use; a short retention window (as in an acceptance test)
    # is swept often enough to be observable.
    sweep_interval = min(SWEEP_INTERVAL_SECONDS, max(60.0, app.retention_seconds / 4))

    def sweep_forever() -> None:
        while not stop_sweeping.wait(sweep_interval):
            try:
                app.sweep()
            except Exception:
                LOG.exception("retention sweep failed")

    threading.Thread(target=sweep_forever, name="retention", daemon=True).start()

    def stop_server(_signum: int, _frame: object) -> None:
        # BaseServer.shutdown() must run on a different thread from
        # serve_forever(), including when a test runner sends SIGTERM.
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, stop_server)
    signal.signal(signal.SIGTERM, stop_server)
    try:
        server.serve_forever()
    finally:
        stop_sweeping.set()
        server.server_close()
        app.close()


if __name__ == "__main__":
    main()
