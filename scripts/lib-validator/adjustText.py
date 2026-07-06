#!/usr/bin/env python3
"""Smoke test for the Python `adjustText` package.

Fully self-contained: no input files, no network, no packages beyond adjustText
(and its implied deps: matplotlib + numpy). Forces the headless Agg backend
before importing, so it never opens a window. Exercises the core API surface and
exits 0 only if every check passes, so it can be used as a pass/fail library
validator:

    python3 adjustText.py

Install: pip install adjustText   (import name: adjustText)

NOTE — deliberately MODEST coverage: adjustText's one job is to iteratively
reposition overlapping matplotlib text labels, and its `adjust_text` return
value has varied across releases (iteration count vs None). So the checks assert
the callable surface plus that a real scatter + a few text handles can be run
through `adjust_text` without error, rather than pinning exact coordinates.

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

# Force the non-interactive Agg backend BEFORE adjustText (which pulls in
# pyplot): headless run, must never pop a window. matplotlib is a hard
# dependency of adjustText, so importing it here is safe when the package is
# present.
import matplotlib

matplotlib.use("Agg")

try:
    import adjustText
except ImportError:
    print("FAIL: package 'adjustText' is not installed")
    sys.exit(1)

import matplotlib.pyplot as plt
from adjustText import adjust_text


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


print(f"adjustText version: {_version(adjustText, 'adjustText')}")

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


def test_adjust_text_is_callable():
    assert callable(adjust_text)
    assert adjustText.adjust_text is adjust_text


def test_adjust_text_runs_on_scatter():
    fig, ax = plt.subplots()
    try:
        xs = [0.1, 0.15, 0.2, 0.22, 0.8]
        ys = [0.1, 0.12, 0.5, 0.52, 0.9]
        labels = ["a", "b", "c", "d", "e"]
        ax.scatter(xs, ys)
        texts = [ax.text(x, y, s) for x, y, s in zip(xs, ys, labels)]
        assert len(texts) == 5
        # Return type varies by version (iteration count or None); either way a
        # clean call over real Text handles is the smoke signal we want.
        result = adjust_text(texts, ax=ax)
        assert result is None or isinstance(result, int)
    finally:
        plt.close(fig)


run_test("adjust_text is callable", test_adjust_text_is_callable)
run_test("adjust_text runs on scatter", test_adjust_text_runs_on_scatter)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all adjustText smoke tests passed")
