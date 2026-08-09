from __future__ import annotations

import json
import math
import socket
import threading
import time
import unittest
from array import array
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from constants import (
    CLASSIFIER_VERSION,
    DISCOVERY_SCHEMA_VERSION,
    INPUT_SAMPLE_RATE,
    MODEL_WEIGHTS_SHA256,
    VOCABULARY_SHA256,
    VOCABULARY_VERSION,
)
from contract import load_vocabulary
from service import DiscoveryApp, DiscoveryServer, config_from_env

TOKEN = "instrument-discovery-test-token-000000000000"
VOCABULARY = load_vocabulary(Path(__file__).with_name("vocabulary.json"))


class FakeBackend:
    def __init__(self, window_scores=None, *, warm_error: Exception | None = None):
        self.window_scores = window_scores
        self.warm_error = warm_error
        self.calls: list[tuple[int, tuple[int, ...]]] = []

    def warm(self) -> None:
        if self.warm_error:
            raise self.warm_error

    def score(self, windows, sample_rate):
        self.calls.append((sample_rate, tuple(len(window) for window in windows)))
        if self.window_scores is not None:
            return self.window_scores
        return [{instrument_id: 0.0 for instrument_id in VOCABULARY.ids} for _ in windows]


class ServiceHarness:
    def __init__(
        self,
        backend: FakeBackend,
        *,
        max_connections: int = 8,
        socket_timeout_seconds: float = 5.0,
    ):
        self.app = DiscoveryApp(
            token=TOKEN,
            vocabulary=VOCABULARY,
            backend=backend,
            max_concurrency=1,
        )
        self.app.wait_until_warm()
        self.server = DiscoveryServer(
            ("127.0.0.1", 0),
            self.app,
            max_connections=max_connections,
            socket_timeout_seconds=socket_timeout_seconds,
        )
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def get(self, path: str):
        return urlopen(f"{self.base}{path}")

    def classify(
        self,
        payload: bytes,
        counts: tuple[int, ...],
        *,
        token: str = TOKEN,
        header_overrides: dict[str, str] | None = None,
        path: str = "/v1/classify",
    ):
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/octet-stream",
            "X-Audio-Sample-Rate": str(INPUT_SAMPLE_RATE),
            "X-Audio-Window-Samples": ",".join(str(count) for count in counts),
            "X-Discovery-Schema-Version": DISCOVERY_SCHEMA_VERSION,
            "X-Expected-Classifier-Version": CLASSIFIER_VERSION,
            "X-Expected-Weights-SHA256": MODEL_WEIGHTS_SHA256,
            "X-Vocabulary-Version": VOCABULARY_VERSION,
            "X-Vocabulary-SHA256": VOCABULARY_SHA256,
        }
        headers.update(header_overrides or {})
        return urlopen(Request(f"{self.base}{path}", data=payload, headers=headers, method="POST"))

    @property
    def address(self) -> tuple[str, int]:
        host, port = self.server.server_address
        return str(host), int(port)

    def classification_headers(self, content_length: int) -> list[tuple[str, str]]:
        return [
            ("Host", f"{self.address[0]}:{self.address[1]}"),
            ("Authorization", f"Bearer {TOKEN}"),
            ("Content-Type", "application/octet-stream"),
            ("Content-Length", str(content_length)),
            ("X-Audio-Sample-Rate", str(INPUT_SAMPLE_RATE)),
            ("X-Audio-Window-Samples", str(content_length // 4)),
            ("X-Discovery-Schema-Version", DISCOVERY_SCHEMA_VERSION),
            ("X-Expected-Classifier-Version", CLASSIFIER_VERSION),
            ("X-Expected-Weights-SHA256", MODEL_WEIGHTS_SHA256),
            ("X-Vocabulary-Version", VOCABULARY_VERSION),
            ("X-Vocabulary-SHA256", VOCABULARY_SHA256),
            ("Connection", "close"),
        ]

    def open_raw_post(
        self,
        *,
        headers: list[tuple[str, str]],
        body: bytes = b"",
    ) -> socket.socket:
        connection = socket.create_connection(self.address, timeout=2)
        request = bytearray(b"POST /v1/classify HTTP/1.1\r\n")
        for name, value in headers:
            request.extend(f"{name}: {value}\r\n".encode("ascii"))
        request.extend(b"\r\n")
        request.extend(body)
        connection.sendall(request)
        return connection


def read_status(connection: socket.socket) -> int:
    connection.settimeout(3)
    response = bytearray()
    while b"\r\n" not in response:
        block = connection.recv(4096)
        if not block:
            break
        response.extend(block)
    status_line = bytes(response).split(b"\r\n", 1)[0]
    return int(status_line.split(b" ", 2)[1])


class ServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = FakeBackend()
        self.harness = ServiceHarness(self.backend)

    def tearDown(self) -> None:
        self.harness.close()

    def test_configuration_rejects_partial_or_unsafe_secrets(self) -> None:
        with self.assertRaisesRegex(Exception, "TOKEN"):
            config_from_env({})
        with self.assertRaisesRegex(Exception, "TOKEN"):
            config_from_env({"INSTRUMENT_DISCOVERY_TOKEN": TOKEN + "\n"})
        with self.assertRaisesRegex(Exception, "TOKEN"):
            config_from_env(
                {"INSTRUMENT_DISCOVERY_TOKEN": TOKEN[:20] + " " + TOKEN[20:]}
            )
        config = config_from_env(
            {
                "INSTRUMENT_DISCOVERY_TOKEN": TOKEN,
                "INSTRUMENT_DISCOVERY_MAX_CONCURRENCY": "1",
                "INSTRUMENT_DISCOVERY_TORCH_THREADS": "2",
                "PORT": "9090",
            }
        )
        self.assertEqual(config.port, 9090)
        self.assertEqual(config.max_concurrency, 1)
        self.assertEqual(config.torch_threads, 2)

    def test_liveness_and_readiness_expose_only_pins(self) -> None:
        with self.harness.get("/healthz") as response:
            self.assertEqual(
                json.load(response),
                {
                    "ok": True,
                    "service": "instrument-discovery",
                    "schemaVersion": DISCOVERY_SCHEMA_VERSION,
                },
            )
        with self.harness.get("/readyz") as response:
            self.assertEqual(
                json.load(response),
                {
                    "ready": True,
                    "classifierVersion": CLASSIFIER_VERSION,
                    "weightsSha256": MODEL_WEIGHTS_SHA256,
                    "vocabularyVersion": VOCABULARY_VERSION,
                    "vocabularySha256": VOCABULARY_SHA256,
                },
            )

    def test_authenticated_pcm_request_returns_bounded_advisory_metadata(self) -> None:
        base = {instrument_id: 0.0 for instrument_id in VOCABULARY.ids}
        self.backend.window_scores = [
            {**base, "saxophone": 0.82},
            {**base, "saxophone": 0.82},
            {**base, "saxophone": 0.20},
        ]
        counts = (4, 4, 4)
        samples = array("f", [0.0, 0.1, -0.1, 0.0] * 3).tobytes()
        with self.harness.classify(samples, counts) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get("Cache-Control"), "no-store")
            result = json.load(response)
        self.assertEqual(result["schemaVersion"], DISCOVERY_SCHEMA_VERSION)
        self.assertEqual(result["classifier"]["version"], CLASSIFIER_VERSION)
        self.assertEqual(result["classifier"]["weightsSha256"], MODEL_WEIGHTS_SHA256)
        self.assertEqual(result["vocabularyVersion"], VOCABULARY_VERSION)
        self.assertEqual(result["vocabularySha256"], VOCABULARY_SHA256)
        self.assertEqual(result["windowsAnalyzed"], 3)
        self.assertEqual(result["detections"][0]["id"], "saxophone")
        self.assertEqual(result["detections"][0]["state"], "uncertain")
        self.assertNotIn("sourceUrl", result)
        self.assertNotIn("model", result)
        self.assertEqual(self.backend.calls, [(INPUT_SAMPLE_RATE, counts)])

    def test_auth_contract_and_paths_fail_closed(self) -> None:
        payload = array("f", [0.0]).tobytes()
        for request in (
            lambda: self.harness.classify(payload, (1,), token="wrong-token"),
            lambda: self.harness.classify(
                payload,
                (1,),
                header_overrides={"X-Vocabulary-SHA256": "0" * 64},
            ),
            lambda: self.harness.classify(payload, (2,)),
            lambda: self.harness.classify(payload, (1,), path="/v1/classify?source=secret"),
        ):
            with self.assertRaises(HTTPError) as raised:
                request()
            self.assertIn(raised.exception.code, {400, 401, 404})
        self.assertEqual(self.backend.calls, [])

    def test_duplicate_or_ambiguous_framing_headers_fail_closed(self) -> None:
        payload = array("f", [0.0]).tobytes()
        cases = (
            self.harness.classification_headers(len(payload))
            + [("Content-Length", str(len(payload)))],
            self.harness.classification_headers(len(payload))
            + [("Authorization", f"Bearer {TOKEN}")],
            self.harness.classification_headers(len(payload))
            + [("Transfer-Encoding", "chunked")],
            self.harness.classification_headers(len(payload))
            + [("Content-Encoding", "gzip")],
        )
        for headers in cases:
            connection = self.harness.open_raw_post(headers=headers, body=payload)
            try:
                self.assertIn(read_status(connection), {400, 401, 411})
            finally:
                connection.close()
        self.assertEqual(self.backend.calls, [])

    def test_expect_continue_is_rejected_before_body_transfer(self) -> None:
        payload = array("f", [0.0]).tobytes()
        headers = self.harness.classification_headers(len(payload))
        headers.append(("Expect", "100-continue"))
        connection = self.harness.open_raw_post(headers=headers)
        try:
            self.assertEqual(read_status(connection), 417)
        finally:
            connection.close()
        self.assertEqual(self.backend.calls, [])

    def test_request_capacity_is_reserved_before_pcm_body_buffering(self) -> None:
        payload = array("f", [0.0]).tobytes()
        slow_connection = self.harness.open_raw_post(
            headers=self.harness.classification_headers(len(payload))
        )
        try:
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                if not self.harness.app.reserve_request():
                    break
                self.harness.app.release_request()
                time.sleep(0.01)
            else:
                self.fail("slow request never reserved body-buffer capacity")

            with self.assertRaises(HTTPError) as busy:
                self.harness.classify(payload, (1,))
            self.assertEqual(busy.exception.code, 503)
            self.assertEqual(json.load(busy.exception), {"error": "discovery_busy"})

            slow_connection.sendall(payload)
            self.assertEqual(read_status(slow_connection), 200)
        finally:
            slow_connection.close()

        self.assertEqual(self.backend.calls, [(INPUT_SAMPLE_RATE, (1,))])

    def test_non_finite_pcm_is_rejected_before_the_backend(self) -> None:
        payload = array("f", [math.nan]).tobytes()
        with self.assertRaises(HTTPError) as raised:
            self.harness.classify(payload, (1,))
        self.assertEqual(raised.exception.code, 422)
        self.assertEqual(self.backend.calls, [])


class ReadinessFailureTest(unittest.TestCase):
    def test_failed_model_warmup_preserves_liveness_but_blocks_classification(self) -> None:
        with self.assertLogs("instrument-discovery", level="ERROR") as captured:
            harness = ServiceHarness(FakeBackend(warm_error=RuntimeError("model unavailable")))
        self.assertEqual(len(captured.output), 1)
        self.assertTrue(captured.output[0].endswith("discovery_not_ready reason=classifier"))
        try:
            with harness.get("/healthz") as response:
                self.assertEqual(response.status, 200)
            with self.assertRaises(HTTPError) as ready_error:
                harness.get("/readyz")
            self.assertEqual(ready_error.exception.code, 503)
            self.assertEqual(json.load(ready_error.exception)["reason"], "classifier")
            with self.assertRaises(HTTPError) as classify_error:
                harness.classify(array("f", [0.0]).tobytes(), (1,))
            self.assertEqual(classify_error.exception.code, 503)
        finally:
            harness.close()


class ConnectionBoundaryTest(unittest.TestCase):
    def test_slow_header_connection_is_bounded_and_times_out(self) -> None:
        harness = ServiceHarness(
            FakeBackend(),
            max_connections=1,
            socket_timeout_seconds=0.2,
        )
        slow_connection = socket.create_connection(harness.address, timeout=1)
        slow_connection.sendall(b"POST /v1/classify HTTP/1.1\r\nHost: test")
        try:
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                if not harness.server._connection_capacity.acquire(blocking=False):
                    break
                harness.server._connection_capacity.release()
                time.sleep(0.01)
            else:
                self.fail("slow header connection never occupied the bounded slot")

            rejected = socket.create_connection(harness.address, timeout=1)
            try:
                rejected.sendall(b"GET /healthz HTTP/1.1\r\nHost: test\r\n\r\n")
                rejected.settimeout(1)
                try:
                    rejected_data = rejected.recv(1)
                except ConnectionResetError:
                    rejected_data = b""
                self.assertEqual(rejected_data, b"")
            finally:
                rejected.close()

            slow_connection.settimeout(1)
            try:
                slow_data = slow_connection.recv(1)
            except ConnectionResetError:
                slow_data = b""
            self.assertEqual(slow_data, b"")

            deadline = time.monotonic() + 1
            while True:
                try:
                    with harness.get("/healthz") as response:
                        self.assertEqual(response.status, 200)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.01)
        finally:
            slow_connection.close()
            harness.close()


if __name__ == "__main__":
    unittest.main()
