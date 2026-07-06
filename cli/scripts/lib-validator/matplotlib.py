#!/usr/bin/env python3
"""Smoke test for the Python `matplotlib` package.

Fully self-contained: no input files, no network, no packages beyond
matplotlib (and its implied deps). Forces the headless Agg backend before any
pyplot import, so it never opens a window. Exercises the core plotting API and
exits 0 only if every check passes, so it can be used as a pass/fail library
validator:

    python3 matplotlib.py

Install: pip install matplotlib   (import name: matplotlib)

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
    import matplotlib
except ImportError:
    print("FAIL: package 'matplotlib' is not installed")
    sys.exit(1)

# Force the non-interactive Agg backend BEFORE importing pyplot: this test runs
# headless (CI, no DISPLAY), must never pop a window, and Agg renders to memory
# / PNG. Selecting the backend after pyplot is imported is a no-op, so it has to
# come first.
matplotlib.use("Agg")
import tempfile

import matplotlib.pyplot as plt


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


print(f"matplotlib version: {_version(matplotlib, 'matplotlib')}")

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


def test_line_plot_data_roundtrips():
    fig, ax = plt.subplots()
    try:
        (line,) = ax.plot([0, 1, 2, 3], [0, 1, 4, 9])
        assert len(ax.lines) == 1
        assert ax.lines[0] is line
        assert [int(v) for v in line.get_xdata()] == [0, 1, 2, 3]
        assert [int(v) for v in line.get_ydata()] == [0, 1, 4, 9]
    finally:
        plt.close(fig)


def test_title_set_and_get():
    fig, ax = plt.subplots()
    try:
        ax.set_title("smoke test")
        assert ax.get_title() == "smoke test"
    finally:
        plt.close(fig)


def test_savefig_png_to_tempfile():
    fig, ax = plt.subplots()
    ax.plot([1, 2, 3], [1, 4, 9])
    fd, path = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        fig.savefig(path)
        assert os.path.getsize(path) > 0
    finally:
        os.remove(path)
        plt.close(fig)


def test_colormap_lookup():
    cmap = matplotlib.colormaps["viridis"]
    assert cmap.N == 256
    rgba = cmap(0.0)
    assert len(rgba) == 4
    # RGBA channels are normalized floats in [0, 1].
    assert all(0.0 <= float(c) <= 1.0 for c in rgba)


def test_figure_dimensions():
    fig = plt.figure()
    try:
        fig.set_size_inches(4, 3)
        w, h = fig.get_size_inches()
        assert abs(float(w) - 4.0) < 1e-9
        assert abs(float(h) - 3.0) < 1e-9
        assert abs(fig.get_figwidth() - 4.0) < 1e-9
        assert abs(fig.get_figheight() - 3.0) < 1e-9
    finally:
        plt.close(fig)


run_test("line plot data roundtrips", test_line_plot_data_roundtrips)
run_test("axes title set/get", test_title_set_and_get)
run_test("savefig PNG to tempfile", test_savefig_png_to_tempfile)
run_test("colormap lookup", test_colormap_lookup)
run_test("figure dimensions", test_figure_dimensions)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all matplotlib smoke tests passed")
