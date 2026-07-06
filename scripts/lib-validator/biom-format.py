#!/usr/bin/env python3
"""Smoke test for the Python `biom-format` package (import name: biom).

Fully self-contained: no input files, no network, no packages beyond
biom-format and its implied deps (numpy, scipy). Exercises the core API surface
and exits 0 only if every check passes, so it can be used as a pass/fail
library validator:

    python3 biom-format.py

Install: pip install biom-format   (import name: biom)

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
    import biom
except ImportError:
    print("FAIL: package 'biom-format' is not installed")
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


print(f"biom-format version: {_version(biom, 'biom-format')}")

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


# A small dense feature table shared across the checks below: 3 observations
# (OTUs/features) x 2 samples. biom.Table takes data as [observation, sample].
_DATA = None
_OBS = ["O1", "O2", "O3"]
_SAMPLES = ["S1", "S2"]


def _make_table():
    import numpy as np

    global _DATA
    _DATA = np.array(
        [
            [1.0, 3.0],
            [0.0, 2.0],
            [4.0, 5.0],
        ]
    )
    return biom.Table(_DATA, _OBS, _SAMPLES)


def test_construct_shape_and_ids():
    t = _make_table()
    # biom reports shape as (num_observations, num_samples).
    assert t.shape == (3, 2)
    assert list(t.ids("observation")) == _OBS
    assert list(t.ids("sample")) == _SAMPLES


def test_sums_per_sample():
    import numpy as np

    t = _make_table()
    # Per-sample totals: column sums of the observation-by-sample matrix.
    per_sample = t.sum("sample")
    assert np.allclose(per_sample, np.array([5.0, 10.0]))
    # Grand total of all counts.
    assert abs(float(t.sum()) - 15.0) < 1e-9


def test_to_dataframe_roundtrip():
    import numpy as np

    t = _make_table()
    df = t.to_dataframe(dense=True)
    # DataFrame is observation-indexed with sample columns.
    assert list(df.index) == _OBS
    assert list(df.columns) == _SAMPLES
    assert np.allclose(df.to_numpy(), _DATA)


def test_hdf5_tempfile_roundtrip():
    import tempfile

    # biom's native on-disk format is HDF5 (needs h5py). Skip cleanly if h5py
    # is absent so the check reflects biom itself, not an optional backend.
    try:
        import h5py  # noqa: F401
    except ImportError:
        return

    import numpy as np

    t = _make_table()
    fd, path = tempfile.mkstemp(suffix=".biom")
    os.close(fd)
    try:
        with h5py.File(path, "w") as fh:
            t.to_hdf5(fh, generated_by="lib-validator smoke test")
        back = biom.load_table(path)
        assert back.shape == (3, 2)
        assert list(back.ids("observation")) == _OBS
        assert list(back.ids("sample")) == _SAMPLES
        assert np.allclose(back.sum("sample"), np.array([5.0, 10.0]))
    finally:
        os.remove(path)


run_test("Table construct: shape + ids", test_construct_shape_and_ids)
run_test("per-sample sums", test_sums_per_sample)
run_test("to_dataframe roundtrip", test_to_dataframe_roundtrip)
run_test("HDF5 tempfile roundtrip (if h5py)", test_hdf5_tempfile_roundtrip)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all biom-format smoke tests passed")
