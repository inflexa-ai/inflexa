#!/usr/bin/env python3
"""Unit tests for the link rule of ``load-check.py``.

These cover the source-build slice of the check: each ELF file of a staged
directory that carries a build record reads ``R CMD ldd`` (R track) or plain
``ldd``, and a ``not found`` line fails the run with the library named. Every
external tool the check shells out to (``Rscript``, ``ldd``, the interpreter)
is monkeypatched at ``load_check.subprocess.run``, so the suite runs with only
the standard library and needs neither R nor a real ELF toolchain.

Run with either::

    cd images/package-store && python3 -m unittest -v test_load_check
    python3 images/package-store/test_load_check.py
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import shutil
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path
from types import SimpleNamespace

_spec = importlib.util.spec_from_file_location(
    "load_check", Path(__file__).with_name("load-check.py"))
load_check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(load_check)


class LinkRuleTestCase(unittest.TestCase):
    """Base: a fresh temp store per test, and a stdlib-only fake subprocess."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="loadcheck-test-"))
        self.store = self.root / "store"
        self.store.mkdir(parents=True)
        # The stdout of every ldd probe, as whole output lines.
        self.ldd_lines: list[str] = []
        # The argv of every external tool the check shelled out to.
        self.calls: list[list[str]] = []
        self._orig_run = load_check.subprocess.run
        load_check.subprocess.run = self._fake_run

    def tearDown(self):
        load_check.subprocess.run = self._orig_run
        shutil.rmtree(self.root, ignore_errors=True)

    def _fake_run(self, cmd, *args, **kwargs):
        """Stand in for the R loader, the Python import, and the two ldd forms."""
        argv = list(cmd)
        self.calls.append(argv)
        prog = argv[0]
        if prog == "Rscript":
            names = (kwargs.get("input") or "").splitlines()[1:]
            return SimpleNamespace(returncode=0,
                                   stdout="".join(f"{name}\tok\n" for name in names),
                                   stderr="")
        if prog == load_check.PYTHON:
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        if prog == "ldd" or argv[:3] == ["R", "CMD", "ldd"]:
            return SimpleNamespace(returncode=0,
                                   stdout="".join(line + "\n" for line in self.ldd_lines),
                                   stderr="")
        raise AssertionError(f"test triggered an unexpected subprocess: {argv!r}")

    # -- fixtures ---------------------------------------------------------------
    @staticmethod
    def _elf_bytes() -> bytes:
        return b"\x7fELF" + b"\x00" * 16

    def _source_r_dir(self, name: str = "srcpkg", elf: str | None = "src.so") -> Path:
        store_dir = self.store / f"{name.lower()}-1.0-000000000000000a"
        inner = store_dir / name
        inner.mkdir(parents=True)
        (inner / "DESCRIPTION").write_text(f"Package: {name}\nVersion: 1.0\n")
        if elf is not None:
            (inner / elf).write_bytes(self._elf_bytes())
        (inner / load_check.BUILD_MARKER).write_text("{}\n")
        return store_dir

    def _source_python_dir(self, name: str = "pydemo") -> Path:
        store_dir = self.store / f"{name}-1.0-000000000000000b"
        (store_dir / name).mkdir(parents=True)
        (store_dir / name / "__init__.py").write_text("x = 1\n")
        (store_dir / name / "_ext.so").write_bytes(self._elf_bytes())
        (store_dir / load_check.BUILD_MARKER).write_text("{}\n")
        return store_dir

    def _index_r_dir(self, name: str = "plainpkg") -> Path:
        store_dir = self.store / f"{name.lower()}-2.0-000000000000000c"
        inner = store_dir / name
        inner.mkdir(parents=True)
        (inner / "DESCRIPTION").write_text(f"Package: {name}\nVersion: 2.0\n")
        (inner / "compiled.so").write_bytes(self._elf_bytes())
        return store_dir

    def _nodes(self, *entries: tuple[str, str]) -> dict:
        return {store_dir.name: {"track": track, "name": store_dir.name.rsplit("-", 2)[0]}
                for store_dir, track in entries}

    def _from_nodes(self, nodes: dict) -> list[dict]:
        return load_check.from_nodes(self.root, {"nodes": nodes})

    def _ldd_calls(self) -> list[list[str]]:
        return [argv for argv in self.calls
                if argv[0] == "ldd" or argv[:3] == ["R", "CMD", "ldd"]]


class LinkRuleTests(LinkRuleTestCase):
    """The ldd rule over the staged source-built directories."""

    def test_a_dynamic_link_to_an_absent_library_fails_and_names_the_library(self):
        r_dir = self._source_r_dir()
        self.ldd_lines = ["\tlinux-vdso.so.1 (0x00007fff)",
                          "\tlibfoo.so.1 => not found",
                          "\tlibR.so => /usr/lib/R/lib/libR.so (0x7f00)"]

        results = self._from_nodes(self._nodes((r_dir, "r")))

        link = next(r for r in results if r["package"] == r_dir.name and "error" in r)
        self.assertFalse(link["ok"])
        self.assertIn("libfoo.so.1", link["error"])
        # The load itself passed; the link rule alone stops the commit.
        self.assertTrue(all(r["ok"] for r in results if r["package"] != r_dir.name or "error" not in r))

    def test_the_r_track_reads_r_cmd_ldd_and_the_python_track_plain_ldd(self):
        r_dir = self._source_r_dir()
        py_dir = self._source_python_dir()
        index_dir = self._index_r_dir()

        self._from_nodes(self._nodes((r_dir, "r"), (py_dir, "python"), (index_dir, "r")))

        ldd = self._ldd_calls()
        self.assertIn(["R", "CMD", "ldd", str(r_dir / "srcpkg" / "src.so")], ldd)
        self.assertIn(["ldd", str(py_dir / "pydemo" / "_ext.so")], ldd)
        # An index package carries no build record, thus the rule never reads
        # its ELF file.
        self.assertFalse(any(index_dir.name in " ".join(argv) for argv in ldd))

    def test_a_link_the_image_carries_passes(self):
        r_dir = self._source_r_dir()
        self.ldd_lines = ["\tlibR.so => /usr/lib/R/lib/libR.so (0x7f00)",
                          "\tlibopenblas.so.0 => /usr/lib/libopenblas.so.0 (0x7f01)"]

        results = self._from_nodes(self._nodes((r_dir, "r")))

        link = next(r for r in results if r["package"] == r_dir.name)
        self.assertTrue(link["ok"])

    def test_a_source_directory_without_elf_files_passes_vacuously(self):
        r_dir = self._source_r_dir(elf=None)

        results = self._from_nodes(self._nodes((r_dir, "r")))

        link = next(r for r in results if r["package"] == r_dir.name)
        self.assertTrue(link["ok"])
        self.assertEqual(self._ldd_calls(), [])

    def test_main_fails_the_run_when_a_library_is_missing(self):
        r_dir = self._source_r_dir()
        self.ldd_lines = ["\tlibbar.so.2 => not found"]
        report = self.root / "report.json"
        report.write_text(json.dumps({"nodes": self._nodes((r_dir, "r"))}))

        argv = ["load-check.py", "--store-root", str(self.root), "--nodes", str(report)]
        with unittest.mock.patch.object(sys, "argv", argv), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(load_check.main(), 1)


class FarmLockTrackTests(unittest.TestCase):
    """The farm-lock reader loads every R track the lock writer emits."""

    def test_the_r_filter_carries_the_source_track_beside_the_named_tracks(self):
        lock = {"packages": [
            {"track": "cran", "name": "SeedCran", "store_dir": "seedcran-1.0-aaaaaaaaaaaaaaaa"},
            {"track": "github", "name": "SeedGit", "store_dir": "seedgit-1.0-bbbbbbbbbbbbbbbb"},
            {"track": "source", "name": "SeedSrc", "store_dir": "seedsrc-1.0-cccccccccccccccc"},
            {"track": "python", "name": "seedpy", "store_dir": "seedpy-1.0-dddddddddddddddd"},
        ]}
        seen = {}

        def record_r(pairs, _lib_paths):
            seen["r"] = [name for name, _store in pairs]
            return []

        root = Path(tempfile.mkdtemp())
        try:
            with unittest.mock.patch.object(load_check, "check_r", side_effect=record_r), \
                    unittest.mock.patch.object(load_check, "check_python", side_effect=lambda *_a, **_k: []):
                load_check.from_farm_lock(root, root / "farm", lock)
        finally:
            shutil.rmtree(root, ignore_errors=True)

        self.assertEqual(seen["r"], ["SeedCran", "SeedGit", "SeedSrc"])


if __name__ == "__main__":
    unittest.main()
