#!/usr/bin/env python3
"""Smoke test for the Python `joblib` package.

Fully self-contained: no input files, no network, no packages beyond joblib.
Exercises the core API surface and exits 0 only if every check passes, so it
can be used as a pass/fail library validator:

    python3 joblib.py

Install: pip install joblib   (import name: joblib)

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
    import joblib
except ImportError:
    print("FAIL: package 'joblib' is not installed")
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


print(f"joblib version: {_version(joblib, 'joblib')}")

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


def _square(i):
    """Top-level so it stays picklable for any multiprocessing backend."""
    return i * i


def test_parallel_delayed():
    from joblib import Parallel, delayed

    # n_jobs=1 keeps it single-process and deterministic — no worker pool.
    out = Parallel(n_jobs=1)(delayed(_square)(i) for i in range(6))
    assert out == [0, 1, 4, 9, 16, 25]


def test_dump_load_tempfile():
    import tempfile

    obj = {"weights": [1.0, 2.0, 3.0], "label": "model", "nested": {"k": [4, 5]}}
    fd, path = tempfile.mkstemp(suffix=".joblib")
    os.close(fd)
    try:
        joblib.dump(obj, path)
        back = joblib.load(path)
        assert back == obj
    finally:
        os.remove(path)


def test_hash_is_stable():
    # joblib.hash is deterministic for equal inputs — used for memo cache keys.
    assert joblib.hash([1, 2, 3]) == joblib.hash([1, 2, 3])
    assert joblib.hash([1, 2, 3]) != joblib.hash([1, 2, 4])


run_test("Parallel/delayed (n_jobs=1)", test_parallel_delayed)
run_test("dump/load tempfile roundtrip", test_dump_load_tempfile)
run_test("hash is stable", test_hash_is_stable)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all joblib smoke tests passed")
