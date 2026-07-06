#!/usr/bin/env python3
"""Smoke test for the Python `bioframe` package.

Fully self-contained: no input files, no network, no packages beyond bioframe
and its implied deps (numpy, pandas). Exercises the core API surface and exits
0 only if every check passes, so it can be used as a pass/fail library
validator:

    python3 bioframe.py

Install: pip install bioframe   (import name: bioframe)

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
    import bioframe
except ImportError:
    print("FAIL: package 'bioframe' is not installed")
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


print(f"bioframe version: {_version(bioframe, 'bioframe')}")

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


def _df(rows):
    import pandas as pd

    return pd.DataFrame(rows, columns=["chrom", "start", "end"])


def test_overlap():
    df1 = _df([["chr1", 0, 10], ["chr1", 20, 30], ["chr2", 0, 10]])
    df2 = _df([["chr1", 5, 15], ["chr1", 25, 35]])
    ov = bioframe.overlap(df1, df2, how="inner", suffixes=("", "_"))
    # (0,10)∩(5,15) and (20,30)∩(25,35) overlap; (chr2,0,10) has no partner.
    assert len(ov) == 2
    assert set(ov["chrom"]) == {"chr1"}


def test_cluster():
    # (0,10) and (5,15) touch → one cluster; (40,50) stands alone → another.
    df = _df([["chr1", 0, 10], ["chr1", 5, 15], ["chr1", 40, 50]])
    clustered = bioframe.cluster(df)
    assert "cluster" in clustered.columns
    assert clustered["cluster"].nunique() == 2


def test_merge():
    df = _df([["chr1", 0, 10], ["chr1", 5, 15], ["chr1", 40, 50]])
    merged = bioframe.merge(df).sort_values("start").reset_index(drop=True)
    # Overlapping (0,10)+(5,15) collapse into (0,15); (40,50) survives intact.
    assert len(merged) == 2
    assert int(merged.loc[0, "start"]) == 0
    assert int(merged.loc[0, "end"]) == 15
    assert int(merged.loc[1, "start"]) == 40
    assert int(merged.loc[1, "end"]) == 50


def test_closest():
    df1 = _df([["chr1", 0, 10]])
    df2 = _df([["chr1", 20, 30], ["chr1", 100, 110]])
    closest = bioframe.closest(df1, df2, suffixes=("", "_"))
    assert len(closest) == 1
    # The nearer downstream feature is (20,30); its distance from (0,10) is 10.
    assert int(closest.iloc[0]["distance"]) == 10


run_test("overlap", test_overlap)
run_test("cluster", test_cluster)
run_test("merge", test_merge)
run_test("closest", test_closest)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all bioframe smoke tests passed")
