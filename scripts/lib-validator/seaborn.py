#!/usr/bin/env python3
"""Smoke test for the Python `seaborn` package.

Fully self-contained: no input files, no network, no packages beyond seaborn
(and its implied deps — matplotlib, pandas, numpy). Forces the headless Agg
backend before any pyplot import, so it never opens a window, and builds its
own pandas DataFrames rather than calling `sns.load_dataset` (which downloads
sample data over the network). Exercises the core statistical-plot API and
exits 0 only if every check passes, so it can be used as a pass/fail library
validator:

    python3 seaborn.py

Install: pip install seaborn   (import name: seaborn)

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

# Force the non-interactive Agg backend BEFORE importing pyplot (and before
# seaborn, which pulls pyplot in): this test runs headless and must never pop a
# window. Selecting the backend after pyplot is imported is a no-op.
import matplotlib

matplotlib.use("Agg")

try:
    import seaborn as sns
except ImportError:
    print("FAIL: package 'seaborn' is not installed")
    sys.exit(1)

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.axes import Axes


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


print(f"seaborn version: {_version(sns, 'seaborn')}")

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


def _frame():
    """A small deterministic DataFrame built in-process (no network download)."""
    rng = np.random.default_rng(0)
    n = 30
    return pd.DataFrame(
        {
            "x": rng.standard_normal(n),
            "y": rng.standard_normal(n),
            "group": np.where(np.arange(n) % 2 == 0, "a", "b"),
            "value": rng.uniform(0, 10, n),
        }
    )


def test_scatterplot_returns_axes():
    df = _frame()
    ax = sns.scatterplot(data=df, x="x", y="y", hue="group")
    try:
        assert isinstance(ax, Axes)
        # One PathCollection per hue level (two groups: "a", "b").
        assert len(ax.collections) >= 1
    finally:
        plt.close("all")


def test_boxplot_returns_axes():
    df = _frame()
    ax = sns.boxplot(data=df, x="group", y="value")
    try:
        assert isinstance(ax, Axes)
        # Two categories on the x axis.
        assert len(ax.get_xticks()) == 2
    finally:
        plt.close("all")


def test_histplot_returns_axes():
    df = _frame()
    ax = sns.histplot(data=df, x="x", bins=5)
    try:
        assert isinstance(ax, Axes)
        # Histogram bars are drawn as patches.
        assert len(ax.patches) >= 1
    finally:
        plt.close("all")


def test_color_palette_returns_n_rgb_tuples():
    pal = sns.color_palette("deep", 4)
    assert len(pal) == 4
    for rgb in pal:
        assert len(rgb) == 3
        assert all(0.0 <= float(c) <= 1.0 for c in rgb)


def test_heatmap_on_small_matrix():
    mat = np.arange(9).reshape(3, 3).astype(float)
    ax = sns.heatmap(mat)
    try:
        assert isinstance(ax, Axes)
        # A heatmap draws a QuadMesh into the axes collections.
        assert len(ax.collections) >= 1
    finally:
        plt.close("all")


run_test("scatterplot returns Axes", test_scatterplot_returns_axes)
run_test("boxplot returns Axes", test_boxplot_returns_axes)
run_test("histplot returns Axes", test_histplot_returns_axes)
run_test("color_palette returns n RGB tuples", test_color_palette_returns_n_rgb_tuples)
run_test("heatmap on small matrix", test_heatmap_on_small_matrix)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all seaborn smoke tests passed")
