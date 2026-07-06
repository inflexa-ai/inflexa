#!/usr/bin/env python3
"""Smoke test for the Python `matplotlib-venn` package (import name: matplotlib_venn).

Fully self-contained: no input files, no network, no packages beyond
matplotlib-venn (and its implied dep: matplotlib). Forces the headless Agg
backend before importing the package, so it never opens a window. Exercises the
core API surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 matplotlib-venn.py

Install: pip install matplotlib-venn   (import name: matplotlib_venn)

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

# Force the non-interactive Agg backend BEFORE matplotlib_venn (which imports
# pyplot at module load): this test runs headless (CI, no DISPLAY), must never
# pop a window, and Agg renders to memory. matplotlib is a hard dependency of
# matplotlib-venn, so importing it here is safe whenever the package is present.
import matplotlib

matplotlib.use("Agg")

try:
    import matplotlib_venn
except ImportError:
    print("FAIL: package 'matplotlib-venn' is not installed")
    sys.exit(1)

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


print(f"matplotlib-venn version: {_version(matplotlib_venn, 'matplotlib-venn')}")

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


def test_venn2_diagram_and_labels():
    fig, ax = plt.subplots()
    try:
        v = matplotlib_venn.venn2(subsets=(3, 2, 1), ax=ax)
        assert v is not None
        # Region "10" is "in A only"; its subset size (3) becomes the label text.
        label = v.get_label_by_id("10")
        assert label is not None
        assert label.get_text() == "3"
        # Every region also carries a drawable patch.
        assert v.get_patch_by_id("10") is not None
    finally:
        plt.close(fig)


def test_venn3_diagram_and_labels():
    fig, ax = plt.subplots()
    try:
        v = matplotlib_venn.venn3(subsets=(1, 2, 3, 4, 5, 6, 7), ax=ax)
        assert v is not None
        # Region "100" is "in A only" -> first subset value (1).
        label = v.get_label_by_id("100")
        assert label is not None
        assert label.get_text() == "1"
        assert v.get_patch_by_id("111") is not None
    finally:
        plt.close(fig)


run_test("venn2 diagram + labels", test_venn2_diagram_and_labels)
run_test("venn3 diagram + labels", test_venn3_diagram_and_labels)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all matplotlib-venn smoke tests passed")
