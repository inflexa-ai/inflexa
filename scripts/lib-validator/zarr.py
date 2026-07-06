#!/usr/bin/env python3
"""Smoke test for the Python `zarr` package.

Fully self-contained: no input files, no network, no packages beyond zarr
(and its implied deps: numpy). Exercises the core API surface and exits 0 only
if every check passes, so it can be used as a pass/fail library validator:

    python3 zarr.py

Install: pip install zarr   (import name: zarr)

Targets the installed zarr v3 API (zarr.zeros/zarr.array return in-memory
arrays by default; slicing reads/writes chunks). zarr v2 differs — e.g. store
plumbing and some kwargs — so this asserts against the v3 surface that ships
here.

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
    import zarr
except ImportError:
    print("FAIL: package 'zarr' is not installed")
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


print(f"zarr version: {_version(zarr, 'zarr')}")

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


def test_zeros_shape_chunks_and_slice_write():
    import numpy as np

    z = zarr.zeros(shape=(10, 10), chunks=(5, 5), dtype="int32")
    assert z.shape == (10, 10)
    assert z.chunks == (5, 5)
    assert int(z[0, 0]) == 0
    z[0:5, 0:5] = 7
    assert int(z[0, 0]) == 7
    assert int(z[4, 4]) == 7
    assert int(z[5, 5]) == 0
    # 25 cells set to 7, the rest still zero.
    assert int(np.asarray(z[:]).sum()) == 7 * 25


def test_array_from_numpy_roundtrip():
    import numpy as np

    source = np.arange(12, dtype="int64").reshape(3, 4)
    z = zarr.array(source, chunks=(3, 2))
    assert z.shape == (3, 4)
    assert z.chunks == (3, 2)
    assert int(z[2, 3]) == 11
    assert np.array_equal(np.asarray(z[:]), source)


def test_slice_read_back():
    import numpy as np

    z = zarr.zeros(shape=(6,), chunks=(3,), dtype="float64")
    z[1:4] = np.array([1.5, 2.5, 3.5])
    assert np.allclose(np.asarray(z[1:4]), [1.5, 2.5, 3.5])
    assert float(z[0]) == 0.0
    assert float(z[5]) == 0.0


run_test("zeros shape/chunks + slice write", test_zeros_shape_chunks_and_slice_write)
run_test("array from numpy roundtrip", test_array_from_numpy_roundtrip)
run_test("slice read-back", test_slice_read_back)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all zarr smoke tests passed")
