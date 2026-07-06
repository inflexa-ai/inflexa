#!/usr/bin/env python3
"""Smoke test for the Python `scikit-misc` package (import name: skmisc).

Fully self-contained: no input files, no network, no packages beyond scikit-misc
(and its implied dep — numpy). Exercises the core API surface and exits 0 only
if every check passes, so it can be used as a pass/fail library validator:

    python3 scikit-misc.py

Install: pip install scikit-misc   (import name: skmisc)

scikit-misc provides `skmisc.loess.loess` — the local-regression smoother scanpy
uses for `flavor="seurat_v3"` highly-variable-gene selection.

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
    import skmisc
except ImportError:
    print("FAIL: package 'scikit-misc' is not installed")
    sys.exit(1)

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


print(f"scikit-misc version: {_version(skmisc, 'scikit-misc')}")

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


def _make_xy():
    """Seeded noisy sine: x on [0, 2pi], y = sin(x) + small Gaussian noise."""
    rng = np.random.default_rng(0)
    x = np.linspace(0.0, 2.0 * np.pi, 120)
    y = np.sin(x) + rng.normal(scale=0.1, size=x.shape)
    return x, y


def test_loess_fit_and_predict():
    from skmisc.loess import loess

    x, y = _make_xy()
    lo = loess(x, y)
    lo.fit()
    pred = lo.predict(x)
    values = pred.values
    assert len(values) == len(x)
    assert np.isfinite(values).all()
    # The smoother should track the sine far better than a flat line.
    assert np.mean((values - y) ** 2) < np.var(y)


run_test("loess fit + predict finite, length matches", test_loess_fit_and_predict)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all scikit-misc smoke tests passed")
