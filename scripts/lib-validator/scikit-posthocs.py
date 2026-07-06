#!/usr/bin/env python3
"""Smoke test for the Python `scikit-posthocs` package (import: scikit_posthocs).

Fully self-contained: no input files, no network, no packages beyond
scikit-posthocs and its implied deps (numpy, pandas, scipy). Exercises the core
API surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 scikit-posthocs.py

Install: pip install scikit-posthocs   (import name: scikit_posthocs)

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
    import scikit_posthocs
except ImportError:
    print("FAIL: package 'scikit-posthocs' is not installed")
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


print(f"scikit-posthocs version: {_version(scikit_posthocs, 'scikit-posthocs')}")

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


def test_posthoc_dunn_square_symmetric_pvalues():
    import scikit_posthocs as sp

    rng = np.random.default_rng(0)
    g1 = rng.normal(0.0, 1.0, 20)
    g2 = rng.normal(0.0, 1.0, 20)
    g3 = rng.normal(5.0, 1.0, 20)  # clearly shifted group
    out = sp.posthoc_dunn([g1, g2, g3])
    vals = out.values
    assert out.shape == (3, 3)
    # Self-comparison diagonal is 1.0; p-values live in [0, 1]; matrix is symmetric.
    assert np.allclose(np.diag(vals), 1.0)
    assert np.all((vals >= 0.0) & (vals <= 1.0))
    assert np.allclose(vals, vals.T)
    # Group 3 is far from group 1 → a small off-diagonal p-value.
    assert out.iloc[0, 2] < 0.05


def test_posthoc_conover_shape():
    import scikit_posthocs as sp

    rng = np.random.default_rng(1)
    groups = [
        rng.normal(0.0, 1.0, 15),
        rng.normal(1.0, 1.0, 15),
        rng.normal(2.0, 1.0, 15),
        rng.normal(3.0, 1.0, 15),
    ]
    out = sp.posthoc_conover(groups)
    vals = out.values
    assert out.shape == (4, 4)
    assert np.allclose(np.diag(vals), 1.0)
    assert np.all((vals >= 0.0) & (vals <= 1.0))


def test_posthoc_ttest_matrix():
    import scikit_posthocs as sp

    rng = np.random.default_rng(2)
    groups = [
        rng.normal(0.0, 1.0, 20),
        rng.normal(0.0, 1.0, 20),
        rng.normal(4.0, 1.0, 20),
    ]
    out = sp.posthoc_ttest(groups)
    assert out.shape == (3, 3)
    assert np.allclose(np.diag(out.values), 1.0)


run_test("posthoc_dunn square/symmetric", test_posthoc_dunn_square_symmetric_pvalues)
run_test("posthoc_conover shape", test_posthoc_conover_shape)
run_test("posthoc_ttest matrix", test_posthoc_ttest_matrix)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all scikit-posthocs smoke tests passed")
