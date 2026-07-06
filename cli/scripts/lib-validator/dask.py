#!/usr/bin/env python3
"""Smoke test for the Python `dask` package.

Fully self-contained: no input files, no network, no packages beyond dask
(and its implied deps: numpy, pandas for the array/dataframe collections).
Exercises the core API surface and exits 0 only if every check passes, so it
can be used as a pass/fail library validator:

    python3 dask.py

Install: pip install "dask[array,dataframe]"   (import name: dask)

The [array,dataframe] extras pull in numpy/pandas so dask.array and
dask.dataframe are usable — the bare `dask` install ships only the core
scheduler.

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
    import dask
except ImportError:
    print("FAIL: package 'dask' is not installed")
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


print(f"dask version: {_version(dask, 'dask')}")

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


def test_array_compute_equals_numpy():
    import dask.array as da
    import numpy as np

    source = np.arange(100, dtype="float64").reshape(10, 10)
    d = da.from_array(source, chunks=(5, 5))
    assert d.shape == (10, 10)
    assert np.allclose(d.compute(), source)
    assert abs(float(d.sum().compute()) - float(source.sum())) < 1e-9


def test_dataframe_groupby_mean():
    import dask.dataframe as dd
    import pandas as pd

    pdf = pd.DataFrame({"g": ["a", "a", "b", "b", "b"], "v": [1.0, 3.0, 2.0, 4.0, 6.0]})
    ddf = dd.from_pandas(pdf, npartitions=2)
    means = ddf.groupby("g")["v"].mean().compute()
    assert abs(means.loc["a"] - 2.0) < 1e-9
    assert abs(means.loc["b"] - 4.0) < 1e-9


run_test("dask.array compute equals numpy", test_array_compute_equals_numpy)
run_test("dask.dataframe groupby mean", test_dataframe_groupby_mean)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all dask smoke tests passed")
