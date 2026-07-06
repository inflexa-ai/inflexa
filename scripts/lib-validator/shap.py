#!/usr/bin/env python3
"""Smoke test for the Python `shap` package.

Fully self-contained: no input files, no network, no packages beyond shap and
its implied deps (numpy, scipy, numba). Data and the model are defined
in-memory as a plain numpy function, and shap is exercised through its
model-agnostic `shap.Explainer` + `shap.maskers.Independent` path.

DESIGN NOTE: `shap.TreeExplainer` needs a fitted tree model from a *separate*
library (scikit-learn / xgboost / lightgbm) that is not a shap dependency, so
wiring it in would break self-containment. Instead we validate the core
Shapley guarantee — additivity / local accuracy — model-agnostically, which
exercises the same machinery and is the property TreeExplainer also asserts.

    python3 shap.py

Install: pip install shap   (import name: shap)

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
    import shap
except ImportError:
    print("FAIL: package 'shap' is not installed")
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


print(f"shap version: {_version(shap, 'shap')}")

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


def test_explainer_class_surface():
    # The headline explainer classes are part of shap's public API.
    assert hasattr(shap, "Explainer")
    assert hasattr(shap, "TreeExplainer")
    assert hasattr(shap, "maskers")


def test_linear_additivity_and_shape():
    rng = np.random.default_rng(0)
    n, d = 40, 4
    background = rng.normal(size=(100, d))
    X = rng.normal(size=(n, d))
    w = np.array([1.0, -2.0, 0.5, 3.0])
    b = 0.7

    def f(x):
        return x @ w + b

    masker = shap.maskers.Independent(background, max_samples=100)
    explainer = shap.Explainer(f, masker)
    exp = explainer(X)
    # One attribution per (sample, feature).
    assert exp.values.shape == (n, d)
    # Local accuracy: base value + summed attributions reconstruct the output.
    recon = exp.base_values + exp.values.sum(axis=1)
    assert np.allclose(recon, f(X), atol=1e-6)


def test_nonlinear_efficiency_holds():
    rng = np.random.default_rng(1)
    n, d = 30, 3
    background = rng.normal(size=(80, d))
    X = rng.normal(size=(n, d))

    def f(x):
        # A nonlinear model: Shapley efficiency must still hold exactly.
        return np.sin(x[:, 0]) + x[:, 1] * x[:, 2]

    masker = shap.maskers.Independent(background, max_samples=80)
    exp = shap.Explainer(f, masker)(X)
    assert exp.values.shape == (n, d)
    recon = exp.base_values + exp.values.sum(axis=1)
    assert np.allclose(recon, f(X), atol=1e-6)


run_test("Explainer class surface", test_explainer_class_surface)
run_test("linear additivity + shape", test_linear_additivity_and_shape)
run_test("nonlinear efficiency holds", test_nonlinear_efficiency_holds)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all shap smoke tests passed")
