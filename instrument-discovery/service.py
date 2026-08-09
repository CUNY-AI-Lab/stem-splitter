#!/usr/bin/env python3
"""Authenticated PCM-only instrument discovery service for Railway.

The service receives only bounded mono f32le windows from audio-analysis. It
does not receive a source URL, filename, job id, class code, or storage token,
and it cannot choose or run a separation model.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import re
import secrets
import sys
import threading
import time
from array import array
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Mapping, Protocol, Sequence
from urllib.parse import urlsplit

from clap_backend import ClapBackend
from constants import (
    CLASSIFIER_VERSION,
    DISCOVERY_SCHEMA_VERSION,
    INPUT_SAMPLE_RATE,
    MAX_PCM_BYTES,
    MAX_RESPONSE_BYTES,
    MAX_WINDOW_SAMPLES,
    MAX_WINDOWS,
    MODEL_WEIGHTS_SHA256,
    VOCABULARY_SHA256,
    VOCABULARY_VERSION,
)
from contract import (
    DiscoveryContractError,
    Vocabulary,
    aggregate_window_scores,
    load_vocabulary,
)

LOG = logging.getLogger("instrument-discovery")
WINDOW_COUNTS_PATTERN = re.compile(r"^[1-9]\d*(?:,[1-9]\d*){0,2}$")


class DiscoveryBackend(Protocol):
    def warm(self) -> None: ...

    def score(
        self, windows: Sequence[Sequence[float]], sample_rate: int
    ) -> list[Mapping[str, float]]: ...


@dataclass(frozen=True)
class ServiceConfig:
    token: str
    vocabulary_path: Path
    model_dir: Path
    port: int
    max_concurrency: int
    torch_threads: int


def _bounded_integer(
    env: Mapping[str, str], name: str, fallback: int, minimum: int, maximum: int
) -> int:
    raw = env.get(name)
    if raw is None or raw == "":
        return fallback
    if raw != raw.strip() or not raw.isdigit():
        raise DiscoveryContractError(f"{name} is invalid")
    value = int(raw)
    if value < minimum or value > maximum:
        raise DiscoveryContractError(f"{name} is invalid")
    return value


def config_from_env(env: Mapping[str, str] = os.environ) -> ServiceConfig:
    token = env.get("INSTRUMENT_DISCOVERY_TOKEN", "")
    if (
        len(token) < 32
        or token != token.strip()
        or any(
            character.isspace() or ord(character) < 32 or ord(character) == 127
            for character in token
        )
    ):
        raise DiscoveryContractError(
            "INSTRUMENT_DISCOVERY_TOKEN must contain at least 32 safe characters"
        )
    vocabulary_path = Path(
        env.get(
            "INSTRUMENT_DISCOVERY_VOCABULARY",
            str(Path(__file__).with_name("vocabulary.json")),
        )
    )
    model_dir = Path(env.get("INSTRUMENT_DISCOVERY_MODEL_DIR", "/models/larger_clap_music"))
    return ServiceConfig(
        token=token,
        vocabulary_path=vocabulary_path,
        model_dir=model_dir,
        port=_bounded_integer(env, "PORT", 8080, 1, 65_535),
        max_concurrency=_bounded_integer(
            env, "INSTRUMENT_DISCOVERY_MAX_CONCURRENCY", 1, 1, 2
        ),
        torch_threads=_bounded_integer(env, "INSTRUMENT_DISCOVERY_TORCH_THREADS", 1, 1, 4),
    )


def parse_window_counts(value: str | None, content_length: int) -> tuple[int, ...]:
    if value is None or not WINDOW_COUNTS_PATTERN.fullmatch(value):
        raise DiscoveryContractError("PCM window header is invalid")
    counts = tuple(int(candidate) for candidate in value.split(","))
    if (
        len(counts) < 1
        or len(counts) > MAX_WINDOWS
        or any(count < 1 or count > MAX_WINDOW_SAMPLES for count in counts)
        or sum(counts) * 4 != content_length
    ):
        raise DiscoveryContractError("PCM window sizes do not match the body")
    return counts


def decode_pcm_windows(payload: bytes, counts: Sequence[int]) -> list[memoryview]:
    if sys.byteorder != "little":
        raise DiscoveryContractError("instrument discovery requires a little-endian runtime")
    if len(payload) != sum(counts) * 4:
        raise DiscoveryContractError("PCM byte length does not match its windows")
    samples = array("f")
    samples.frombytes(payload)
    if any(not math.isfinite(sample) for sample in samples):
        raise DiscoveryContractError("PCM contains a non-finite sample")
    view = memoryview(samples)
    windows: list[memoryview] = []
    offset = 0
    for count in counts:
        windows.append(view[offset : offset + count])
        offset += count
    return windows


class DiscoveryApp:
    def __init__(
        self,
        *,
        token: str,
        vocabulary: Vocabulary,
        backend: DiscoveryBackend,
        max_concurrency: int = 1,
        warm_async: bool = True,
    ) -> None:
        self.token = token
        self.vocabulary = vocabulary
        self.backend = backend
        self._request_capacity = threading.BoundedSemaphore(max_concurrency)
        self._capacity = threading.BoundedSemaphore(max_concurrency)
        self._ready = threading.Event()
        self._warm_finished = threading.Event()
        self._warm_failed = False
        if warm_async:
            threading.Thread(
                target=self._warm,
                name="instrument-discovery-warmup",
                daemon=True,
            ).start()

    def _warm(self) -> None:
        try:
            self.backend.warm()
            self._ready.set()
            LOG.info("discovery_ready classifier=%s", CLASSIFIER_VERSION)
        except Exception:
            self._warm_failed = True
            LOG.error("discovery_not_ready reason=classifier")
        finally:
            self._warm_finished.set()

    def warm_now(self) -> None:
        self._warm()

    def wait_until_warm(self, timeout: float = 5.0) -> bool:
        return self._warm_finished.wait(timeout)

    @property
    def ready(self) -> bool:
        return self._ready.is_set()

    @property
    def warm_failed(self) -> bool:
        return self._warm_failed

    def authorized(self, authorization: str | None) -> bool:
        return isinstance(authorization, str) and secrets.compare_digest(
            authorization, f"Bearer {self.token}"
        )

    def reserve_request(self) -> bool:
        """Bound request-body buffering before any PCM is read from the socket."""

        return self._request_capacity.acquire(blocking=False)

    def release_request(self) -> None:
        self._request_capacity.release()

    def classify(self, payload: bytes, counts: Sequence[int]) -> dict[str, object]:
        if not self._capacity.acquire(blocking=False):
            raise RuntimeError("busy")
        started = time.monotonic()
        try:
            windows = decode_pcm_windows(payload, counts)
            scores = self.backend.score(windows, INPUT_SAMPLE_RATE)
            detections = aggregate_window_scores(self.vocabulary, scores)
            timing_ms = max(0, round((time.monotonic() - started) * 1000))
            if timing_ms > 30_000:
                raise RuntimeError("classifier exceeded the response timing contract")
            return {
                "schemaVersion": DISCOVERY_SCHEMA_VERSION,
                "classifier": {
                    "version": CLASSIFIER_VERSION,
                    "weightsSha256": MODEL_WEIGHTS_SHA256,
                },
                "vocabularyVersion": VOCABULARY_VERSION,
                "vocabularySha256": VOCABULARY_SHA256,
                "detections": detections,
                "windowsAnalyzed": len(windows),
                "timingMs": timing_ms,
            }
        finally:
            self._capacity.release()


class DiscoveryServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int],
        app: DiscoveryApp,
        *,
        max_connections: int = 8,
        socket_timeout_seconds: float = 5.0,
    ):
        if max_connections < 1 or max_connections > 32:
            raise DiscoveryContractError("connection limit is invalid")
        if socket_timeout_seconds <= 0 or socket_timeout_seconds > 30:
            raise DiscoveryContractError("socket timeout is invalid")
        self._connection_capacity = threading.BoundedSemaphore(max_connections)
        self._socket_timeout_seconds = socket_timeout_seconds
        super().__init__(address, RequestHandler)
        self.app = app

    def get_request(self):
        request, client_address = super().get_request()
        request.settimeout(self._socket_timeout_seconds)
        return request, client_address

    def process_request(self, request, client_address) -> None:
        if not self._connection_capacity.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._connection_capacity.release()
            raise

    def process_request_thread(self, request, client_address) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._connection_capacity.release()


class RequestHandler(BaseHTTPRequestHandler):
    server: DiscoveryServer
    protocol_version = "HTTP/1.1"
    server_version = "instrument-discovery/1"
    sys_version = ""

    def log_message(self, _format: str, *_args: object) -> None:
        # Default logs can include attacker-controlled paths and headers.
        return

    def handle_expect_100(self) -> bool:
        self._json(417, {"error": "expectation_failed"})
        return False

    def _json(self, status: int, payload: Mapping[str, object]) -> None:
        body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if len(body) > MAX_RESPONSE_BYTES:
            status = 500
            body = b'{"error":"discovery_failed"}'
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        if status == 401:
            self.send_header("WWW-Authenticate", "Bearer")
        if status == 503:
            self.send_header("Retry-After", "1")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def _exact_path(self) -> str | None:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return None
        return parsed.path

    def _single_header(self, name: str) -> str | None:
        values = self.headers.get_all(name, [])
        return values[0] if len(values) == 1 else None

    def do_GET(self) -> None:
        path = self._exact_path()
        if path == "/healthz":
            self._json(
                200,
                {
                    "ok": True,
                    "service": "instrument-discovery",
                    "schemaVersion": DISCOVERY_SCHEMA_VERSION,
                },
            )
            return
        if path == "/readyz":
            if self.server.app.ready:
                self._json(
                    200,
                    {
                        "ready": True,
                        "classifierVersion": CLASSIFIER_VERSION,
                        "weightsSha256": MODEL_WEIGHTS_SHA256,
                        "vocabularyVersion": VOCABULARY_VERSION,
                        "vocabularySha256": VOCABULARY_SHA256,
                    },
                )
            else:
                self._json(
                    503,
                    {
                        "ready": False,
                        "reason": "classifier" if self.server.app.warm_failed else "warming",
                    },
                )
            return
        self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if not self.server.app.authorized(self._single_header("Authorization")):
            self._json(401, {"error": "unauthorized"})
            return
        if self._exact_path() != "/v1/classify":
            self._json(404, {"error": "not_found"})
            return
        if not self.server.app.ready:
            self._json(503, {"error": "service_not_ready"})
            return
        if self.headers.get_all("Transfer-Encoding", []):
            self._json(400, {"error": "invalid_request"})
            return
        if self.headers.get_all("Content-Encoding", []):
            self._json(400, {"error": "invalid_request"})
            return
        if self._single_header("Content-Type") != "application/octet-stream":
            self._json(415, {"error": "unsupported_media_type"})
            return
        if (
            self._single_header("X-Audio-Sample-Rate") != str(INPUT_SAMPLE_RATE)
            or self._single_header("X-Discovery-Schema-Version")
            != DISCOVERY_SCHEMA_VERSION
            or self._single_header("X-Expected-Classifier-Version")
            != CLASSIFIER_VERSION
            or self._single_header("X-Expected-Weights-SHA256")
            != MODEL_WEIGHTS_SHA256
            or self._single_header("X-Vocabulary-Version") != VOCABULARY_VERSION
            or self._single_header("X-Vocabulary-SHA256") != VOCABULARY_SHA256
        ):
            self._json(400, {"error": "contract_mismatch"})
            return

        declared = self._single_header("Content-Length")
        if declared is None:
            self._json(411, {"error": "content_length_required"})
            return
        if not declared.isdigit():
            self._json(400, {"error": "invalid_request"})
            return
        content_length = int(declared)
        if content_length < 4 or content_length > MAX_PCM_BYTES:
            self._json(413, {"error": "pcm_too_large"})
            return
        try:
            counts = parse_window_counts(
                self._single_header("X-Audio-Window-Samples"), content_length
            )
        except DiscoveryContractError:
            self._json(400, {"error": "invalid_request"})
            return

        if not self.server.app.reserve_request():
            self._json(503, {"error": "discovery_busy"})
            return
        try:
            self.connection.settimeout(5)
            try:
                payload = self.rfile.read(content_length)
            except (OSError, TimeoutError):
                self._json(400, {"error": "invalid_request"})
                return
            if len(payload) != content_length:
                self._json(400, {"error": "invalid_request"})
                return
            try:
                result = self.server.app.classify(payload, counts)
            except DiscoveryContractError:
                self._json(422, {"error": "invalid_pcm"})
                return
            except RuntimeError as error:
                if str(error) == "busy":
                    self._json(503, {"error": "discovery_busy"})
                else:
                    LOG.error("discovery_failed reason=classifier")
                    self._json(500, {"error": "discovery_failed"})
                return
            except Exception:
                LOG.error("discovery_failed reason=classifier")
                self._json(500, {"error": "discovery_failed"})
                return

            LOG.info(
                "discovery_complete windows=%d detections=%d timing_ms=%d",
                result["windowsAnalyzed"],
                len(result["detections"]),
                result["timingMs"],
            )
            self._json(200, result)
        finally:
            self.server.app.release_request()


def create_app(config: ServiceConfig) -> DiscoveryApp:
    vocabulary = load_vocabulary(config.vocabulary_path)
    backend = ClapBackend(
        config.model_dir,
        vocabulary,
        torch_threads=config.torch_threads,
    )
    return DiscoveryApp(
        token=config.token,
        vocabulary=vocabulary,
        backend=backend,
        max_concurrency=config.max_concurrency,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int)
    args = parser.parse_args()
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(message)s")
    config = config_from_env()
    port = args.port if args.port is not None else config.port
    if port < 1 or port > 65_535:
        raise DiscoveryContractError("port is invalid")
    app = create_app(config)
    server = DiscoveryServer(("0.0.0.0", port), app)
    LOG.info("discovery_started port=%d", port)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
