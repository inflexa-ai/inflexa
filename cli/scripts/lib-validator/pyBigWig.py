#!/usr/bin/env python3
"""Smoke test for the Python `pyBigWig` package.

Fully self-contained: no input files, no network. Writes a tiny bigWig into a
tempfile, reopens it for reading, and deletes it afterwards. Exercises the core
API surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 pyBigWig.py

Install: pip install pyBigWig   (import name: pyBigWig)

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
    import pyBigWig
except ImportError:
    print("FAIL: package 'pyBigWig' is not installed")
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


print(f"pyBigWig version: {_version(pyBigWig, 'pyBigWig')}")

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


def test_write_then_read():
    import math
    import tempfile

    fd, path = tempfile.mkstemp(suffix=".bw")
    os.close(fd)
    try:
        # --- write ---
        bw = pyBigWig.open(path, "w")
        try:
            bw.addHeader([("chr1", 1000)])
            # Three fixed-span intervals: [0,100)=1.0, [100,200)=2.0, [200,300)=3.0.
            bw.addEntries(
                "chr1",
                [0, 100, 200],
                values=[1.0, 2.0, 3.0],
                span=100,
                step=100,
            )
        finally:
            bw.close()

        # --- read back ---
        bw = pyBigWig.open(path)
        try:
            assert bw.chroms("chr1") == 1000
            # mean of [0,100) is 1.0; of [100,200) is 2.0.
            assert abs(bw.stats("chr1", 0, 100)[0] - 1.0) < 1e-6
            assert abs(bw.stats("chr1", 100, 200)[0] - 2.0) < 1e-6
            # per-base values across the first three positions -> all 1.0.
            vals = bw.values("chr1", 0, 3)
            assert all(abs(v - 1.0) < 1e-6 for v in vals)
            # a position past the last entry is unset -> NaN.
            assert math.isnan(bw.values("chr1", 500, 501)[0])
        finally:
            bw.close()
    finally:
        os.remove(path)


run_test("write bigWig tempfile then read stats/values", test_write_then_read)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all pyBigWig smoke tests passed")
