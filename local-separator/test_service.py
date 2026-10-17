import json
import socketserver
import sys
import tempfile
import threading
import time
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from service import (
    DEFAULT_TOKEN,
    DEMUCS_PARAMS,
    DRAIN_FILENAME,
    MODEL_FILES,
    MODEL_STEMS,
    AppServer,
    Job,
    SeparationApp,
    StartupError,
    StemFile,
    deliver_webhook,
    detect_device,
    post_webhook,
    purge_orphans,
    separator_options,
    validate_public_config,
    verify_file_sha256,
)


class FakeRunner:
    def __init__(self, root: Path):
        self.root = root

    def separate(self, job_id: str, source_path: Path, model: str) -> list[StemFile]:
        job_dir = self.root / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        results = []
        for stem in MODEL_STEMS[model]:
            path = job_dir / f"{stem}.mp3"
            path.write_bytes(b"ID3-test-audio")
            results.append(StemFile(stem, path))
        return results


def fake_download(_url: str, destination: Path) -> None:
    destination.write_bytes(b"RIFF-test-source")


class BlockingRunner(FakeRunner):
    """Holds every job in "processing" until the test releases it."""

    def __init__(self, root: Path):
        super().__init__(root)
        self.release = threading.Event()

    def separate(self, job_id: str, source_path: Path, model: str) -> list[StemFile]:
        self.release.wait(5)
        return super().separate(job_id, source_path, model)


class ServiceContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.webhooks: list[tuple[str, dict]] = []
        self.start_service(runner=FakeRunner(self.root))

    def start_service(self, **options) -> None:
        options.setdefault("webhook_sender", lambda url, payload: self.webhooks.append((url, payload)))
        self.app = SeparationApp(
            token="test-token",
            public_url="http://127.0.0.1:0",
            data_root=self.root,
            downloader=fake_download,
            **options,
        )
        self.server = AppServer(("127.0.0.1", 0), self.app)
        port = self.server.server_address[1]
        self.app.public_url = f"http://127.0.0.1:{port}"
        self.base = self.app.public_url
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def stop_service(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.app.close()

    def tearDown(self) -> None:
        release = getattr(self.app.runner, "release", None)
        if release is not None:
            release.set()
        self.stop_service()
        self.temp.cleanup()

    def submit(self, model: str = "htdemucs_ft", webhook_url: str | None = None) -> dict:
        body = {"audio_url": "https://example.invalid/source.wav", "model": model}
        if webhook_url:
            body["webhook_url"] = webhook_url
        with self.request("/v1/jobs", method="POST", body=body) as response:
            self.assertEqual(response.status, 202)
            return json.load(response)

    def wait_for(self, job_id: str, status: str = "succeeded") -> dict:
        deadline = time.time() + 3
        while time.time() < deadline:
            with self.request(f"/v1/jobs/{job_id}") as response:
                payload = json.load(response)
            if payload["status"] == status:
                return payload
            time.sleep(0.02)
        self.fail(f"job {job_id} never reached {status}")

    def request(self, path: str, *, method: str = "GET", body=None, authorized=True):
        headers = {}
        if authorized:
            headers["Authorization"] = "Bearer test-token"
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        return urlopen(Request(f"{self.base}{path}", method=method, data=data, headers=headers))

    def test_bs_roformer_profile_is_pinned_to_two_tracks(self) -> None:
        self.assertEqual(
            MODEL_FILES["bs_roformer_vocals"],
            "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
        )
        self.assertEqual(MODEL_STEMS["bs_roformer_vocals"], ("vocals", "instrumental"))

    def test_all_advertised_profiles_have_exact_stem_contracts(self) -> None:
        self.assertEqual(set(MODEL_FILES), set(MODEL_STEMS))
        self.assertEqual(
            MODEL_STEMS,
            {
                "bs_roformer_vocals": ("vocals", "instrumental"),
                "htdemucs_ft": ("vocals", "drums", "bass", "other"),
                "htdemucs_6s": ("vocals", "drums", "bass", "guitar", "piano", "other"),
            },
        )

    def test_checksum_verification_rejects_changed_model_bytes(self) -> None:
        path = Path(self.temp.name) / "fixture.ckpt"
        path.write_bytes(b"known model bytes")
        verify_file_sha256(
            path,
            "e88b6e0d664778236e7603e9453d5414397860c0d395b150f9b98ef3aeed9f08",
        )
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            verify_file_sha256(path, "0" * 64)

    def test_authenticated_job_lifecycle_and_file_download(self) -> None:
        with self.request(
            "/v1/jobs",
            method="POST",
            body={
                "audio_url": "https://example.invalid/source.wav",
                "model": "bs_roformer_vocals",
            },
        ) as response:
            self.assertEqual(response.status, 202)
            job = json.load(response)

        deadline = time.time() + 3
        while time.time() < deadline:
            with self.request(f"/v1/jobs/{job['id']}") as response:
                status = json.load(response)
            if status["status"] == "succeeded":
                break
            time.sleep(0.02)

        self.assertEqual(status["status"], "succeeded")
        self.assertEqual([stem["name"] for stem in status["stems"]], ["vocals", "instrumental"])
        file_path = status["stems"][0]["url"].removeprefix(self.base)
        with urlopen(file_path if file_path.startswith("http") else f"{self.base}{file_path}") as response:
            self.assertEqual(response.headers.get_content_type(), "audio/mpeg")
            self.assertEqual(response.read(), b"ID3-test-audio")

    def test_job_api_requires_bearer_token(self) -> None:
        with self.assertRaises(HTTPError) as raised:
            self.request("/v1/jobs/not-a-job", authorized=False)
        self.assertEqual(raised.exception.code, 401)

    def test_unknown_job_returns_the_exact_lost_job_body(self) -> None:
        # src/separation/audio-separator.ts fails a job only on this exact body.
        with self.assertRaises(HTTPError) as raised:
            self.request("/v1/jobs/not-a-job")
        self.assertEqual(raised.exception.code, 404)
        self.assertEqual(json.load(raised.exception), {"error": "job not found"})

    def test_source_audio_is_deleted_once_the_split_finishes(self) -> None:
        job = self.submit()
        self.wait_for(job["id"])
        job_dir = self.root / job["id"]
        self.assertFalse((job_dir / "source.wav").exists())
        self.assertTrue((job_dir / "vocals.mp3").exists())

    def test_completion_webhook_carries_the_service_payload(self) -> None:
        job = self.submit(webhook_url="https://app.invalid/api/webhooks/separation?job=j&token=t")
        self.wait_for(job["id"])
        deadline = time.time() + 2
        while not self.webhooks and time.time() < deadline:
            time.sleep(0.01)
        [(url, payload)] = self.webhooks
        self.assertEqual(url, "https://app.invalid/api/webhooks/separation?job=j&token=t")
        self.assertEqual(payload["id"], job["id"])
        self.assertEqual(payload["status"], "succeeded")
        self.assertEqual(len(payload["stems"]), 4)

    def test_full_queue_answers_503_so_the_app_falls_back(self) -> None:
        self.stop_service()
        self.start_service(runner=BlockingRunner(self.root), max_pending=1)
        self.submit()
        with self.assertRaises(HTTPError) as raised:
            self.submit()
        self.assertEqual(raised.exception.code, 503)
        self.assertEqual(raised.exception.headers.get("Retry-After"), "30")
        self.assertEqual(json.load(raised.exception), {"error": "separator busy"})

    def test_drain_file_stops_admission_without_dropping_work(self) -> None:
        (self.root / DRAIN_FILENAME).write_text("")
        with self.assertRaises(HTTPError) as raised:
            self.submit()
        self.assertEqual(raised.exception.code, 503)
        (self.root / DRAIN_FILENAME).unlink()
        self.wait_for(self.submit()["id"])

    def test_health_is_public_and_value_free(self) -> None:
        self.stop_service()
        self.start_service(runner=BlockingRunner(self.root), max_pending=1, device="cuda")
        self.submit()
        with self.request("/health", authorized=False) as response:
            health = json.load(response)
        self.assertEqual(
            health,
            {
                "ok": True,
                "models": list(MODEL_FILES),
                "device": "cuda",
                "pending": 1,
                "accepting": False,
            },
        )

    def test_a_gpu_failure_stops_admission_and_requests_a_restart(self) -> None:
        restarts: list[bool] = []

        class BrokenGpu(FakeRunner):
            def separate(self, job_id, source_path, model):
                raise RuntimeError("CUDA error: unspecified launch failure")

        self.stop_service()
        self.start_service(
            runner=BrokenGpu(self.root), device="cuda", on_gpu_failure=lambda: restarts.append(True)
        )
        failed = self.wait_for(self.submit()["id"], status="failed")
        self.assertEqual(failed["error"], "The GPU failed during this split. Start the split again.")
        deadline = time.time() + 2
        while not restarts and time.time() < deadline:
            time.sleep(0.01)
        self.assertEqual(restarts, [True])
        with self.request("/health", authorized=False) as response:
            health = json.load(response)
        self.assertEqual((health["device"], health["accepting"]), ("failed", False))
        with self.assertRaises(HTTPError) as raised:
            self.submit()
        self.assertEqual(raised.exception.code, 503)

    def test_out_of_memory_is_an_ordinary_job_failure(self) -> None:
        restarts: list[bool] = []

        class OutOfMemory(FakeRunner):
            def separate(self, job_id, source_path, model):
                raise RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB")

        self.stop_service()
        self.start_service(
            runner=OutOfMemory(self.root), device="cuda", on_gpu_failure=lambda: restarts.append(True)
        )
        failed = self.wait_for(self.submit()["id"], status="failed")
        self.assertIn("out of memory", failed["error"])
        self.assertEqual(restarts, [])
        self.wait_for(self.submit()["id"], status="failed")

    def test_sweep_evicts_only_terminal_jobs_past_retention(self) -> None:
        now = [1_000_000.0]
        app = SeparationApp(
            token="t",
            public_url="http://127.0.0.1:1",
            data_root=self.root,
            runner=FakeRunner(self.root),
            retention_seconds=3600,
            clock=lambda: now[0],
        )
        self.addCleanup(app.close)
        old = Job(id=str(uuid.uuid4()), source_url="", webhook_url=None, model="htdemucs_ft")
        fresh = Job(id=str(uuid.uuid4()), source_url="", webhook_url=None, model="htdemucs_ft")
        running = Job(id=str(uuid.uuid4()), source_url="", webhook_url=None, model="htdemucs_ft")
        for job in (old, fresh, running):
            app.jobs.add(job)
            (self.root / job.id).mkdir()
        app.jobs.update(old.id, status="succeeded", finished_at=now[0] - 7200)
        app.jobs.update(fresh.id, status="failed", finished_at=now[0] - 60)
        app.jobs.update(running.id, status="processing")

        self.assertEqual(app.sweep(), 1)
        self.assertIsNone(app.jobs.get(old.id))
        self.assertFalse((self.root / old.id).exists())
        self.assertIsNotNone(app.jobs.get(fresh.id))
        self.assertIsNotNone(app.jobs.get(running.id))
        self.assertTrue((self.root / running.id).exists())


class HousekeepingTest(unittest.TestCase):
    def test_purge_orphans_removes_only_uuid_job_folders(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            orphan = root / str(uuid.uuid4())
            orphan.mkdir()
            (orphan / "vocals.mp3").write_bytes(b"x")
            (root / "models").mkdir()
            (root / "notes.txt").write_text("keep")
            self.assertEqual(purge_orphans(root), 1)
            self.assertFalse(orphan.exists())
            self.assertTrue((root / "models").exists())
            self.assertTrue((root / "notes.txt").exists())

    def test_demucs_profiles_match_the_replicate_pin(self) -> None:
        self.assertEqual(
            DEMUCS_PARAMS,
            {"segment_size": "Default", "shifts": 1, "overlap": 0.25, "segments_enabled": True},
        )
        for model in ("htdemucs_ft", "htdemucs_6s"):
            options = separator_options(model, Path("/job"), Path("/models"))
            self.assertEqual(options["demucs_params"], DEMUCS_PARAMS)
            self.assertEqual(options["normalization_threshold"], 0.99)
            self.assertEqual((options["output_format"], options["output_bitrate"]), ("MP3", "192k"))
        roformer = separator_options("bs_roformer_vocals", Path("/job"), Path("/models"))
        self.assertNotIn("demucs_params", roformer)
        self.assertNotIn("normalization_threshold", roformer)

    def test_public_exposure_requires_a_strong_token(self) -> None:
        strong = "a" * 64
        validate_public_config(DEFAULT_TOKEN, "http://127.0.0.1:8765", "127.0.0.1")
        validate_public_config("", "http://localhost:8765", "localhost")
        validate_public_config(strong, "https://separator.example.org", "127.0.0.1")
        for token, url, host in (
            (DEFAULT_TOKEN, "https://separator.example.org", "127.0.0.1"),
            ("", "https://separator.example.org", "127.0.0.1"),
            ("short-secret", "https://separator.example.org", "127.0.0.1"),
            (DEFAULT_TOKEN, "http://127.0.0.1:8765", "0.0.0.0"),
        ):
            with self.subTest(token=token, url=url, host=host):
                with self.assertRaises(StartupError):
                    validate_public_config(token, url, host)

    def test_required_cuda_refuses_to_start_without_a_working_gpu(self) -> None:
        no_gpu = SimpleNamespace(
            cuda=SimpleNamespace(is_available=lambda: False),
            backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
        )
        with mock.patch.dict(sys.modules, {"torch": no_gpu}):
            self.assertEqual(detect_device(False), "cpu")
            with self.assertRaises(StartupError):
                detect_device(True)

        def no_kernel_image(*_args, **_kwargs):
            raise RuntimeError("CUDA error: no kernel image is available for execution on the device")

        wrong_build = SimpleNamespace(
            cuda=SimpleNamespace(is_available=lambda: True),
            backends=SimpleNamespace(mps=None),
            ones=no_kernel_image,
        )
        with mock.patch.dict(sys.modules, {"torch": wrong_build}):
            # Audio Separator would still pick this GPU, so neither mode starts.
            for required in (True, False):
                with self.assertRaisesRegex(StartupError, "no kernel image"):
                    detect_device(required)

    def test_a_declared_tunnel_needs_its_https_hostname_and_a_strong_token(self) -> None:
        strong = "a" * 64
        validate_public_config(strong, "https://separator.example.org", "127.0.0.1", True)
        for token, url in (
            (strong, "http://127.0.0.1:8765"),
            (strong, "http://separator.example.org"),
            (DEFAULT_TOKEN, "https://separator.example.org"),
            ("", "https://separator.example.org"),
        ):
            with self.subTest(token=len(token), url=url):
                with self.assertRaises(StartupError):
                    validate_public_config(token, url, "127.0.0.1", True)


class WebhookDeliveryTest(unittest.TestCase):
    def serve(self, statuses: list[int]) -> tuple[str, list[dict]]:
        received: list[dict] = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args) -> None:
                pass

            def do_POST(self) -> None:
                size = int(self.headers.get("content-length", "0"))
                received.append(json.loads(self.rfile.read(size)))
                status = statuses[min(len(received), len(statuses)) - 1]
                self.send_response(status)
                self.send_header("Content-Length", "0")
                self.end_headers()

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}/hook?token=secret", received

    def test_retries_server_errors_until_delivered(self) -> None:
        url, received = self.serve([500, 502, 200])
        self.assertTrue(deliver_webhook(url, {"id": "j"}, backoff=(0, 0, 0)))
        self.assertEqual(len(received), 3)

    def test_does_not_retry_a_rejection(self) -> None:
        url, received = self.serve([403])
        with self.assertLogs("local-separator", level="WARNING") as logs:
            self.assertFalse(deliver_webhook(url, {"id": "j"}, backoff=(0, 0, 0)))
        self.assertEqual(len(received), 1)
        # The webhook URL carries the app's WEBHOOK_SECRET and must never be logged.
        self.assertNotIn("secret", "\n".join(logs.output))

    def test_a_redirect_is_reported_rather_than_followed(self) -> None:
        url, received = self.serve([302])
        with self.assertLogs("local-separator", level="WARNING"):
            self.assertFalse(deliver_webhook(url, {"id": "j"}, backoff=(0, 0, 0)))
        self.assertEqual(len(received), 1)

    def test_a_malformed_response_is_retried_without_a_traceback(self) -> None:
        class Garbage(socketserver.BaseRequestHandler):
            def handle(self) -> None:
                self.request.recv(65536)
                self.request.sendall(b"not http at all\r\n\r\n")

        server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Garbage)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_address[1]}/hook"
        outcome, detail = post_webhook(url, {"id": "j"})
        self.assertEqual(outcome, "retry")
        self.assertTrue(detail)


if __name__ == "__main__":
    unittest.main()
