#!/usr/bin/env python3
"""Smoke test for the Python `pandas` package.

Fully self-contained: no input files, no network, no packages beyond pandas
(and its implied deps). Exercises the core API surface and exits 0 only if
every check passes, so it can be used as a pass/fail library validator:

    python3 pandas.py

Install: pip install pandas   (import name: pandas)

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
    import pandas as pd
except ImportError:
    print("FAIL: package 'pandas' is not installed")
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


print(f"pandas version: {_version(pd, 'pandas')}")

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


def test_dataframe_construct_and_dtypes():
    df = pd.DataFrame({"i": [1, 2, 3], "f": [1.5, 2.5, 3.5], "s": ["a", "b", "c"]})
    assert df.shape == (3, 3)
    assert list(df.columns) == ["i", "f", "s"]
    assert df["i"].dtype == "int64"
    assert df["f"].dtype == "float64"
    assert df["s"].dtype == object
    assert df["i"].sum() == 6


def test_groupby_agg_exact_means():
    df = pd.DataFrame({"g": ["a", "a", "b", "b", "b"], "v": [1.0, 3.0, 2.0, 4.0, 6.0]})
    means = df.groupby("g")["v"].mean()
    assert means.loc["a"] == 2.0
    assert means.loc["b"] == 4.0
    agg = df.groupby("g")["v"].agg(["sum", "count"])
    assert agg.loc["a", "sum"] == 4.0
    assert agg.loc["b", "sum"] == 12.0
    assert int(agg.loc["b", "count"]) == 3


def test_merge_join():
    left = pd.DataFrame({"id": [1, 2, 3], "x": ["a", "b", "c"]})
    right = pd.DataFrame({"id": [2, 3, 4], "y": [20, 30, 40]})
    inner = left.merge(right, on="id", how="inner")
    assert list(inner["id"]) == [2, 3]
    assert list(inner["y"]) == [20, 30]
    outer = left.merge(right, on="id", how="left")
    assert list(outer["id"]) == [1, 2, 3]
    assert pd.isna(outer["y"].iloc[0])


def test_loc_iloc_selection():
    df = pd.DataFrame({"a": [10, 20, 30], "b": [40, 50, 60]}, index=["r0", "r1", "r2"])
    assert df.loc["r1", "b"] == 50
    assert df.iloc[2, 0] == 30
    assert list(df.loc[df["a"] > 15, "a"]) == [20, 30]


def test_to_dict_roundtrip():
    df = pd.DataFrame({"a": [1, 2], "b": ["x", "y"]})
    d = df.to_dict(orient="list")
    assert d == {"a": [1, 2], "b": ["x", "y"]}
    back = pd.DataFrame(d)
    assert back.equals(df)


def test_csv_roundtrip_tempfile():
    import tempfile

    df = pd.DataFrame({"i": [1, 2, 3], "f": [1.5, 2.5, 3.5], "s": ["w", "x", "y"]})
    fd, path = tempfile.mkstemp(suffix=".csv")
    os.close(fd)
    try:
        df.to_csv(path, index=False)
        back = pd.read_csv(path)
        assert list(back.columns) == ["i", "f", "s"]
        assert list(back["i"]) == [1, 2, 3]
        assert list(back["f"]) == [1.5, 2.5, 3.5]
        assert list(back["s"]) == ["w", "x", "y"]
    finally:
        os.remove(path)


run_test("DataFrame construct and dtypes", test_dataframe_construct_and_dtypes)
run_test("groupby().agg exact means", test_groupby_agg_exact_means)
run_test("merge/join", test_merge_join)
run_test("loc/iloc selection", test_loc_iloc_selection)
run_test("to_dict roundtrip", test_to_dict_roundtrip)
run_test("CSV tempfile round-trip", test_csv_roundtrip_tempfile)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all pandas smoke tests passed")
