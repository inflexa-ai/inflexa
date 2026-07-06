#!/usr/bin/env python3
"""Smoke test for the Python `h5py` package.

Fully self-contained: no input files, no network, no packages beyond h5py
(and its implied deps: numpy). Exercises the core API surface and exits 0 only
if every check passes, so it can be used as a pass/fail library validator:

    python3 h5py.py

Install: pip install h5py   (import name: h5py)

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
    import h5py
except ImportError:
    print("FAIL: package 'h5py' is not installed")
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


print(f"h5py version: {_version(h5py, 'h5py')}")

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


def test_in_memory_dataset_and_attrs():
    import numpy as np

    # driver="core" with backing_store=False keeps the whole file in RAM — no
    # disk touched, so this check needs no tempfile cleanup.
    f = h5py.File("mem.h5", "w", driver="core", backing_store=False)
    try:
        payload = np.arange(6, dtype="int64").reshape(2, 3)
        dset = f.create_dataset("data", data=payload)
        dset.attrs["units"] = "counts"
        assert np.array_equal(f["data"][...], payload)
        assert f["data"][1, 2] == 5
        assert f["data"].attrs["units"] == "counts"
        assert f["data"].shape == (2, 3)
    finally:
        f.close()


def test_groups_tempfile():
    import numpy as np
    import tempfile

    fd, path = tempfile.mkstemp(suffix=".h5")
    os.close(fd)
    try:
        with h5py.File(path, "w") as f:
            grp = f.create_group("group_a")
            grp.create_dataset("vec", data=np.array([1.5, 2.5, 3.5]))
            f.attrs["root_note"] = "top-level"
        with h5py.File(path, "r") as f:
            assert list(f.keys()) == ["group_a"]
            assert list(f["group_a"].keys()) == ["vec"]
            assert np.allclose(f["group_a/vec"][...], [1.5, 2.5, 3.5])
            assert f.attrs["root_note"] == "top-level"
    finally:
        os.remove(path)


run_test("in-memory dataset + attribute", test_in_memory_dataset_and_attrs)
run_test("groups via tempfile", test_groups_tempfile)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all h5py smoke tests passed")
