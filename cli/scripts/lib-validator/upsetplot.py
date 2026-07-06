#!/usr/bin/env python3
"""Smoke test for the Python `upsetplot` package.

Fully self-contained: no input files, no network, no packages beyond upsetplot
(and its implied deps — pandas, matplotlib). Forces the headless Agg backend
before any pyplot import, so it never opens a window; figures are built in
memory and discarded. Exercises the membership-reshaping helpers and the UpSet
plotter and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 upsetplot.py

Install: pip install upsetplot   (import name: upsetplot)

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

# Force the non-interactive Agg backend BEFORE importing pyplot: UpSet.plot()
# creates a figure, and this test runs headless and must never pop a window.
import matplotlib

matplotlib.use("Agg")

try:
    import upsetplot
except ImportError:
    print("FAIL: package 'upsetplot' is not installed")
    sys.exit(1)

import matplotlib.pyplot as plt
import pandas as pd
from matplotlib.axes import Axes
from upsetplot import UpSet, from_contents, from_memberships


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


print(f"upsetplot version: {_version(upsetplot, 'upsetplot')}")

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


def _membership_series():
    """A Series indexed by a boolean (cat1, cat2) MultiIndex, counts as values."""
    return from_memberships(
        [[], ["cat1"], ["cat2"], ["cat1", "cat2"]],
        data=[10, 20, 30, 40],
    )


def test_from_memberships_multiindex_and_counts():
    data = _membership_series()
    assert isinstance(data, pd.Series)
    assert isinstance(data.index, pd.MultiIndex)
    assert set(data.index.names) == {"cat1", "cat2"}
    assert int(data.sum()) == 100
    # The (cat1=True, cat2=True) combination carries the value we supplied.
    assert int(data.loc[(True, True)]) == 40
    # The empty membership (neither category) carries its value too.
    assert int(data.loc[(False, False)]) == 10


def test_from_contents_dataframe():
    df = from_contents({"A": ["x", "y", "z"], "B": ["y", "z", "w"]})
    assert isinstance(df, pd.DataFrame)
    assert isinstance(df.index, pd.MultiIndex)
    assert set(df.index.names) == {"A", "B"}
    # Four distinct elements across the two contents: x, y, z, w.
    assert len(df) == 4
    assert "id" in df.columns


def test_upset_constructs():
    us = UpSet(_membership_series())
    assert us is not None


def test_plot_returns_axes_dict():
    fig = plt.figure()
    try:
        axes = UpSet(_membership_series()).plot(fig=fig)
        assert isinstance(axes, dict)
        # The matrix subplot is always part of an UpSet rendering.
        assert "matrix" in axes
        assert all(isinstance(ax, Axes) for ax in axes.values())
    finally:
        plt.close("all")


run_test("from_memberships MultiIndex and counts", test_from_memberships_multiindex_and_counts)
run_test("from_contents DataFrame", test_from_contents_dataframe)
run_test("UpSet constructs", test_upset_constructs)
run_test("plot returns Axes dict", test_plot_returns_axes_dict)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all upsetplot smoke tests passed")
