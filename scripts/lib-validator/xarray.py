#!/usr/bin/env python3
"""Smoke test for the Python `xarray` package.

Fully self-contained: no input files, no network, no packages beyond xarray
(and its implied deps, notably numpy). Exercises the core labelled-array API
and exits 0 only if every check passes, so it can be used as a pass/fail
library validator:

    python3 xarray.py

Install: pip install xarray   (import name: xarray)

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
    import xarray
except ImportError:
    print("FAIL: package 'xarray' is not installed")
    sys.exit(1)

# numpy is a hard dependency of xarray, so it is importable whenever xarray is.
import numpy as np


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


print(f"xarray version: {_version(xarray, 'xarray')}")

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


def test_dataarray_construct_dims_shape():
    da = xarray.DataArray(
        np.arange(12).reshape(3, 4),
        dims=("x", "y"),
        coords={"x": [10, 20, 30], "y": [0, 1, 2, 3]},
    )
    assert da.dims == ("x", "y")
    assert da.shape == (3, 4)
    assert da.sizes["x"] == 3
    assert da.sizes["y"] == 4
    assert list(da.coords["x"].values) == [10, 20, 30]


def test_label_and_positional_selection():
    da = xarray.DataArray(
        np.arange(12).reshape(3, 4),
        dims=("x", "y"),
        coords={"x": [10, 20, 30], "y": [0, 1, 2, 3]},
    )
    # .sel is label-based: x == 20 is the middle row; .isel is positional and
    # should land on the same row.
    by_label = da.sel(x=20)
    by_index = da.isel(x=1)
    assert np.array_equal(by_label.values, np.array([4, 5, 6, 7]))
    assert np.array_equal(by_index.values, np.array([4, 5, 6, 7]))
    assert int(da.sel(x=30, y=3)) == 11


def test_reduction_mean_over_dim():
    da = xarray.DataArray(
        np.arange(12).reshape(3, 4),
        dims=("x", "y"),
        coords={"x": [10, 20, 30], "y": [0, 1, 2, 3]},
    )
    m = da.mean(dim="x")
    assert m.dims == ("y",)
    # Column means of [[0..3],[4..7],[8..11]] are [4, 5, 6, 7].
    assert np.allclose(m.values, np.array([4.0, 5.0, 6.0, 7.0]))


def test_dataset_variable_access():
    da = xarray.DataArray(
        np.arange(12).reshape(3, 4),
        dims=("x", "y"),
        coords={"x": [10, 20, 30], "y": [0, 1, 2, 3]},
    )
    ds = xarray.Dataset({"a": da})
    assert "a" in ds.data_vars
    assert ds["a"].shape == (3, 4)
    assert np.array_equal(ds["a"].values, da.values)


def test_to_dict_roundtrip():
    da = xarray.DataArray(
        np.arange(12).reshape(3, 4),
        dims=("x", "y"),
        coords={"x": [10, 20, 30], "y": [0, 1, 2, 3]},
    )
    d = da.to_dict()
    back = xarray.DataArray.from_dict(d)
    assert back.dims == da.dims
    assert np.array_equal(back.values, da.values)
    assert list(back.coords["x"].values) == list(da.coords["x"].values)


run_test("DataArray construct: dims/shape/coords", test_dataarray_construct_dims_shape)
run_test("label (.sel) and positional (.isel) selection", test_label_and_positional_selection)
run_test("mean reduction over a dim", test_reduction_mean_over_dim)
run_test("Dataset variable access", test_dataset_variable_access)
run_test("to_dict/from_dict roundtrip", test_to_dict_roundtrip)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all xarray smoke tests passed")
