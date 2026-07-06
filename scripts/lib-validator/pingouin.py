#!/usr/bin/env python3
"""Smoke test for the Python `pingouin` package.

Fully self-contained: no input files, no network, no packages beyond pingouin
and its implied deps (numpy, pandas, scipy). Exercises the core API surface and
exits 0 only if every check passes, so it can be used as a pass/fail library
validator:

    python3 pingouin.py

Install: pip install pingouin   (import name: pingouin)

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
    import pingouin as pg
except ImportError:
    print("FAIL: package 'pingouin' is not installed")
    sys.exit(1)

import numpy as np
import pandas as pd


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


print(f"pingouin version: {_version(pg, 'pingouin')}")

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


def test_ttest_columns_and_detects_difference():
    rng = np.random.default_rng(0)
    a = rng.normal(0.0, 1.0, size=40)
    b = rng.normal(2.0, 1.0, size=40)  # clearly shifted mean
    res = pg.ttest(a, b)
    assert isinstance(res, pd.DataFrame)
    for col in ("T", "p-val", "CI95%"):
        assert col in res.columns
    # A two-unit planted mean gap must register as significant.
    assert float(res["p-val"].iloc[0]) < 0.01


def test_corr_recovers_strong_relationship():
    rng = np.random.default_rng(1)
    x = rng.normal(size=120)
    y = 2.0 * x + rng.normal(0.0, 0.1, size=120)  # strong positive link
    res = pg.corr(x, y)
    assert isinstance(res, pd.DataFrame)
    assert "r" in res.columns and "p-val" in res.columns
    assert float(res["r"].iloc[0]) > 0.9
    assert float(res["p-val"].iloc[0]) < 1e-6


def test_anova_between_groups():
    rng = np.random.default_rng(2)
    df = pd.DataFrame(
        {
            "y": np.concatenate(
                [
                    rng.normal(0.0, 1.0, 20),
                    rng.normal(0.0, 1.0, 20),
                    rng.normal(5.0, 1.0, 20),  # one group shifted far up
                ]
            ),
            "group": (["a"] * 20) + (["b"] * 20) + (["c"] * 20),
        }
    )
    aov = pg.anova(data=df, dv="y", between="group")
    assert isinstance(aov, pd.DataFrame)
    assert "F" in aov.columns and "p-unc" in aov.columns
    assert float(aov["p-unc"].iloc[0]) < 0.01


run_test("ttest columns + detects diff", test_ttest_columns_and_detects_difference)
run_test("corr recovers relationship", test_corr_recovers_strong_relationship)
run_test("anova between groups", test_anova_between_groups)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all pingouin smoke tests passed")
