#!/usr/bin/env python3
"""Smoke test for the Python `statsmodels` package.

Fully self-contained: no input files, no network, no packages beyond
statsmodels and its implied deps (numpy, pandas, scipy). Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 statsmodels.py

Install: pip install "statsmodels>=0.14.5"   (import name: statsmodels)

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
    import statsmodels
    import statsmodels.api as sm
except ImportError:
    print("FAIL: package 'statsmodels' is not installed")
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


print(f"statsmodels version: {_version(statsmodels, 'statsmodels')}")

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


def test_ols_recovers_slope():
    # Simulate y = 3 + 2*x + noise; OLS must recover intercept ~3, slope ~2.
    rng = np.random.default_rng(0)
    x = rng.uniform(0, 10, size=500)
    y = 3.0 + 2.0 * x + rng.normal(0, 1.0, size=500)
    X = sm.add_constant(x)
    res = sm.OLS(y, X).fit()
    assert res.params.shape == (2,)
    assert np.isclose(res.params[0], 3.0, atol=0.3)
    assert np.isclose(res.params[1], 2.0, atol=0.1)
    # Strong linear signal → high R^2 and a highly-significant slope.
    assert res.rsquared > 0.95
    assert res.pvalues[1] < 1e-6


def test_add_constant_shape():
    x = np.arange(10.0).reshape(10, 1)
    X = sm.add_constant(x)
    assert X.shape == (10, 2)
    # First column is the added intercept of all ones.
    assert np.allclose(X[:, 0], 1.0)


def test_summary_has_params_and_pvalues():
    rng = np.random.default_rng(1)
    x = rng.normal(size=200)
    y = 1.0 - 0.5 * x + rng.normal(0, 0.5, size=200)
    res = sm.OLS(y, sm.add_constant(x)).fit()
    # Both inferential vectors are present and finite for every term.
    assert len(res.params) == 2
    assert len(res.pvalues) == 2
    assert np.all(np.isfinite(res.pvalues))
    text = str(res.summary())
    assert "coef" in text and "P>|t|" in text


def test_glm_binomial_logit():
    # Logistic signal: higher x → higher P(y=1). GLM slope must be positive.
    rng = np.random.default_rng(2)
    x = rng.normal(size=400)
    p = 1.0 / (1.0 + np.exp(-(0.5 + 2.0 * x)))
    y = (rng.uniform(size=400) < p).astype(float)
    X = sm.add_constant(x)
    res = sm.GLM(y, X, family=sm.families.Binomial()).fit()
    assert res.params.shape == (2,)
    assert res.params[1] > 0.0
    assert np.all(np.isfinite(res.fittedvalues))


run_test("OLS recovers y=3+2x slope", test_ols_recovers_slope)
run_test("add_constant adds intercept", test_add_constant_shape)
run_test("summary has params + pvalues", test_summary_has_params_and_pvalues)
run_test("GLM binomial (logit)", test_glm_binomial_logit)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all statsmodels smoke tests passed")
