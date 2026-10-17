"""The CUDA project must install the same packages as the CPU lock, plus CUDA torch."""

import tomllib
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
TORCH_FAMILY = {"torch", "torchvision"}
PROJECT = "stem-splitter-local-separator"


def cpu_lock_versions() -> dict[str, str]:
    """name -> version from ../uv.lock as resolved for Python 3.12."""
    lock = tomllib.loads((HERE / "uv.lock").read_text())
    versions: dict[str, str] = {}
    for package in lock["package"]:
        name = package["name"]
        if name == PROJECT:
            continue
        markers = package.get("resolution-markers")
        if markers and not any(">= '3.12'" in marker for marker in markers):
            continue
        # torch and torchvision appear twice (PyPI and +cpu); keep the public version.
        versions.setdefault(name, package["version"].split("+")[0])
    return versions


def pin(requirement: str) -> tuple[str, str]:
    name, version = requirement.split("==")
    return name.split("[")[0].strip(), version.strip()


class CudaProjectMatchesCpuLockTest(unittest.TestCase):
    def setUp(self) -> None:
        self.project = tomllib.loads((HERE / "cuda" / "pyproject.toml").read_text())
        self.cpu = cpu_lock_versions()

    def test_direct_pins_match_the_cpu_lock(self) -> None:
        for requirement in self.project["project"]["dependencies"]:
            name, version = pin(requirement)
            self.assertEqual(version, self.cpu[name], f"{name} drifted from ../uv.lock")

    def test_every_other_package_is_constrained_to_its_cpu_version(self) -> None:
        constraints = dict(pin(item) for item in self.project["tool"]["uv"]["constraint-dependencies"])
        direct = {pin(item)[0] for item in self.project["project"]["dependencies"]}
        expected = {name: version for name, version in self.cpu.items() if name not in direct}
        self.assertEqual(constraints, expected)

    def test_torch_comes_from_a_cuda_index_with_blackwell_kernels(self) -> None:
        indexes = {index["name"]: index for index in self.project["tool"]["uv"]["index"]}
        for name in TORCH_FAMILY:
            index = indexes[self.project["tool"]["uv"]["sources"][name]["index"]]
            self.assertTrue(index["url"].endswith("/cu130"), index["url"])
            self.assertTrue(index["explicit"])


if __name__ == "__main__":
    unittest.main()
