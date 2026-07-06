#!/usr/bin/env python3
"""Smoke test for the Python `lifelines` package.

Fully self-contained: no input files, no network, no packages beyond lifelines
and its implied deps (numpy, pandas, scipy). Exercises the core API surface and
exits 0 only if every check passes, so it can be used as a pass/fail library
validator:

    python3 lifelines.py

Install: pip install lifelines   (import name: lifelines)

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
    import lifelines
except ImportError:
    print("FAIL: package 'lifelines' is not installed")
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


print(f"lifelines version: {_version(lifelines, 'lifelines')}")

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


def test_kaplan_meier_monotone_from_one():
    from lifelines import KaplanMeierFitter

    rng = np.random.default_rng(0)
    durations = rng.exponential(scale=10.0, size=200)
    events = rng.integers(0, 2, size=200)  # 0/1 censoring indicator
    kmf = KaplanMeierFitter()
    kmf.fit(durations, event_observed=events)
    vals = kmf.survival_function_.values.ravel()
    # Survival curve starts at 1, is non-increasing, and stays within [0, 1].
    assert np.isclose(vals[0], 1.0)
    assert np.all(np.diff(vals) <= 1e-9)
    assert np.all((vals >= -1e-9) & (vals <= 1.0 + 1e-9))
    assert kmf.median_survival_time_ > 0.0


def test_cox_ph_summary_and_concordance():
    from lifelines import CoxPHFitter

    rng = np.random.default_rng(1)
    n = 300
    x = rng.normal(size=n)
    # Higher x raises the hazard, so it shortens the simulated survival time.
    baseline = rng.exponential(scale=10.0, size=n)
    T = baseline * np.exp(-0.8 * x)
    E = np.ones(n, dtype=int)  # every subject observed (uncensored)
    df = pd.DataFrame({"T": T, "E": E, "x": x})
    cph = CoxPHFitter()
    cph.fit(df, duration_col="T", event_col="E")
    summ = cph.summary
    assert isinstance(summ, pd.DataFrame)
    assert "coef" in summ.columns and "p" in summ.columns
    # A hazard-raising covariate yields a positive Cox coefficient.
    assert float(summ.loc["x", "coef"]) > 0.0
    c = cph.concordance_index_
    assert 0.0 <= c <= 1.0
    # A real prognostic signal discriminates better than a coin flip.
    assert c > 0.5


run_test("Kaplan-Meier monotone from 1", test_kaplan_meier_monotone_from_one)
run_test("CoxPH summary + concordance", test_cox_ph_summary_and_concordance)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all lifelines smoke tests passed")
