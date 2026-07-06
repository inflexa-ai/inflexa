#!/usr/bin/env python3
"""Smoke test for the Python `scikit-survival` package (import name: sksurv).

Fully self-contained: no input files, no network, no packages beyond
scikit-survival and its implied deps (numpy, scikit-learn). All data is
simulated in-memory — the bundled `sksurv.datasets` loaders are deliberately
NOT used (some fetch remote data). Exits 0 only if every check passes, so it
can be used as a pass/fail library validator:

    python3 scikit-survival.py

Install: pip install scikit-survival   (import name: sksurv)

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
    import sksurv
except ImportError:
    print("FAIL: package 'scikit-survival' is not installed")
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


print(f"scikit-survival version: {_version(sksurv, 'scikit-survival')}")

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


def test_surv_from_arrays_structured():
    from sksurv.util import Surv

    event = np.array([True, False, True, True, False])
    time = np.array([5.0, 8.0, 2.0, 9.0, 3.0])
    y = Surv.from_arrays(event, time)
    # A structured array with an event-indicator field and a time field.
    assert y.shape == (5,)
    assert y.dtype.names == ("event", "time")
    assert y["event"].dtype == np.bool_
    assert np.allclose(y["time"], time)


def test_coxph_fit_predict_concordance():
    from sksurv.linear_model import CoxPHSurvivalAnalysis
    from sksurv.metrics import concordance_index_censored
    from sksurv.util import Surv

    rng = np.random.default_rng(0)
    n = 200
    X = rng.normal(size=(n, 3))
    beta = np.array([1.0, -0.5, 0.3])
    # Linear predictor drives the hazard: larger X@beta → shorter survival.
    lp = X @ beta
    baseline = rng.exponential(scale=10.0, size=n)
    time = baseline * np.exp(-lp)
    event = np.ones(n, dtype=bool)  # all observed (uncensored)
    y = Surv.from_arrays(event, time)

    est = CoxPHSurvivalAnalysis().fit(X, y)
    risk = est.predict(X)
    assert risk.shape == (n,)
    assert np.all(np.isfinite(risk))

    cindex = concordance_index_censored(event, time, risk)[0]
    assert 0.0 <= cindex <= 1.0
    # Recovered risk ordering must beat random discrimination.
    assert cindex > 0.5


run_test("Surv.from_arrays structured", test_surv_from_arrays_structured)
run_test("CoxPH fit/predict + c-index", test_coxph_fit_predict_concordance)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all scikit-survival smoke tests passed")
