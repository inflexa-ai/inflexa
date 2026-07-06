#!/usr/bin/env python3
"""Smoke test for the Python `xgboost` package.

Fully self-contained: no input files, no network, no packages beyond xgboost
and its implied deps (numpy, scipy). Data is simulated in-memory. The native
`xgb.train` / Booster API is used rather than the `XGBClassifier` scikit-learn
wrapper, so this validator does not pull in scikit-learn.

RUNTIME NOTE: the xgboost wheel links against OpenMP; on macOS `import xgboost`
fails at load time unless libomp is present (`brew install libomp`). That shows
up here as the not-installed guard firing (ImportError) even when the wheel is
present — a missing libomp is reported the same as a missing package.

    python3 xgboost.py

Install: pip install xgboost   (import name: xgboost; macOS also needs libomp)

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
    import xgboost as xgb
except ImportError:
    print("FAIL: package 'xgboost' is not installed")
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


print(f"xgboost version: {_version(xgb, 'xgboost')}")

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


def _make_binary(rng, n=400, d=6):
    """Two offset Gaussian clusters → an easily-separable binary problem."""
    half = n // 2
    X0 = rng.normal(-1.0, 1.0, size=(half, d))
    X1 = rng.normal(1.0, 1.0, size=(half, d))
    X = np.vstack([X0, X1])
    y = np.concatenate([np.zeros(half, dtype=int), np.ones(half, dtype=int)])
    return X, y


def test_dmatrix_shapes():
    rng = np.random.default_rng(0)
    X, y = _make_binary(rng)
    d = xgb.DMatrix(X, label=y)
    assert d.num_row() == X.shape[0]
    assert d.num_col() == X.shape[1]


def test_train_predict_accuracy():
    rng = np.random.default_rng(1)
    X, y = _make_binary(rng)
    dtrain = xgb.DMatrix(X, label=y)
    params = {
        "objective": "binary:logistic",
        "max_depth": 3,
        "eta": 0.3,
        "seed": 0,
        "verbosity": 0,
    }
    booster = xgb.train(params, dtrain, num_boost_round=20)
    proba = booster.predict(dtrain)
    assert proba.shape == (X.shape[0],)
    assert np.all((proba >= 0.0) & (proba <= 1.0))
    preds = (proba > 0.5).astype(int)
    # A planted, separable signal must be fit well above chance on train data.
    assert float((preds == y).mean()) > 0.8


def test_feature_importances():
    rng = np.random.default_rng(2)
    X, y = _make_binary(rng)
    dtrain = xgb.DMatrix(X, label=y)
    booster = xgb.train(
        {"objective": "binary:logistic", "max_depth": 3, "seed": 0, "verbosity": 0},
        dtrain,
        num_boost_round=20,
    )
    # get_score reports importance only for features used in a split.
    scores = booster.get_score(importance_type="weight")
    assert isinstance(scores, dict)
    assert 0 < len(scores) <= X.shape[1]
    assert all(v > 0.0 for v in scores.values())


run_test("DMatrix shapes", test_dmatrix_shapes)
run_test("train + predict accuracy", test_train_predict_accuracy)
run_test("feature importances", test_feature_importances)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all xgboost smoke tests passed")
