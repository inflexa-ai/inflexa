#!/usr/bin/env python3
"""Smoke test for the Python `fsspec` package.

Fully self-contained: no input files, no network, no packages beyond fsspec.
Exercises the core API surface against the built-in in-memory filesystem (no
disk, no network) and exits 0 only if every check passes, so it can be used as
a pass/fail library validator:

    python3 fsspec.py

Install: pip install fsspec   (import name: fsspec)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import fsspec
except ImportError:
    print("FAIL: package 'fsspec' is not installed")
    sys.exit(1)


def _version(mod, dist):
    """Best-effort version string: module.__version__, else installed metadata."""
    v = getattr(mod, "__version__", None)
    if v:
        return v
    try:
        import importlib.metadata as m

        return m.version(dist)
    except Exception:
        return "unknown"


print(f"fsspec version: {_version(fsspec, 'fsspec')}")

failures = 0


def run_test(name, fn):
    """Run one check; a raised exception is a failure, not a crash."""
    global failures
    try:
        fn()
    except Exception as e:  # noqa: BLE001 - any failure is a test failure
        failures += 1
        print(f"  FAIL {name}: {e}")
    else:
        print(f"  ok   {name}")


def test_memory_write_read():
    fs = fsspec.filesystem("memory")
    path = "/smoke/data.bin"
    payload = b"hello fsspec"
    with fs.open(path, "wb") as fh:
        fh.write(payload)
    assert fs.exists(path)
    with fs.open(path, "rb") as fh:
        assert fh.read() == payload
    # Clean up so repeat runs start empty (the memory store is process-global).
    fs.rm(path)


def test_memory_ls():
    fs = fsspec.filesystem("memory")
    for name in ("a.txt", "b.txt"):
        with fs.open(f"/lsdir/{name}", "wb") as fh:
            fh.write(b"x")
    listing = fs.ls("/lsdir", detail=False)
    basenames = sorted(p.rsplit("/", 1)[-1] for p in listing)
    assert basenames == ["a.txt", "b.txt"]
    fs.rm("/lsdir", recursive=True)


def test_open_convenience_helper():
    # fsspec.open() resolves the protocol from the URL and returns an OpenFile.
    with fsspec.open("memory://top/greeting.txt", "wb") as fh:
        fh.write(b"hi")
    with fsspec.open("memory://top/greeting.txt", "rb") as fh:
        assert fh.read() == b"hi"
    fsspec.filesystem("memory").rm("/top/greeting.txt")


run_test("memory FS write/read", test_memory_write_read)
run_test("memory FS ls", test_memory_ls)
run_test("fsspec.open convenience helper", test_open_convenience_helper)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all fsspec smoke tests passed")
