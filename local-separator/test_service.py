import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from service import (
    MODEL_FILES,
    MODEL_STEMS,
    AppServer,
    SeparationApp,
    StemFile,
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


class ServiceContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.app = SeparationApp(
            token="test-token",
            public_url="http://127.0.0.1:0",
            data_root=root,
            runner=FakeRunner(root),
            downloader=fake_download,
        )
        self.server = AppServer(("127.0.0.1", 0), self.app)
        port = self.server.server_address[1]
        self.app.public_url = f"http://127.0.0.1:{port}"
        self.base = self.app.public_url
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.app.close()
        self.temp.cleanup()

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


if __name__ == "__main__":
    unittest.main()
