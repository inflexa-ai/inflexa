#!/usr/bin/env python3
"""Smoke test for the Python `scikit-learn` package (import name: sklearn).

Fully self-contained: no input files, no network, no packages beyond
scikit-learn and its implied deps (numpy). Exercises the core API surface and
exits 0 only if every check passes, so it can be used as a pass/fail library
validator:

    python3 scikit-learn.py

Install: pip install scikit-learn   (import name: sklearn)

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
    import sklearn
except ImportError:
    print("FAIL: package 'scikit-learn' is not installed")
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


print(f"scikit-learn version: {_version(sklearn, 'scikit-learn')}")

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


def test_logistic_regression_learns():
    from sklearn.datasets import make_classification
    from sklearn.linear_model import LogisticRegression

    X, y = make_classification(
        n_samples=200, n_features=10, n_informative=5, random_state=0
    )
    clf = LogisticRegression(max_iter=1000).fit(X, y)
    # A linearly-separable-ish planted signal must be learnable well above chance.
    assert clf.score(X, y) > 0.7
    preds = clf.predict(X)
    assert preds.shape == (200,)
    assert set(np.unique(preds)).issubset({0, 1})


def test_random_forest_split_and_accuracy():
    from sklearn.datasets import make_classification
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.metrics import accuracy_score
    from sklearn.model_selection import train_test_split

    X, y = make_classification(
        n_samples=300, n_features=8, n_informative=5, random_state=1
    )
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.25, random_state=1)
    assert Xtr.shape == (225, 8)
    assert Xte.shape == (75, 8)
    clf = RandomForestClassifier(n_estimators=50, random_state=0).fit(Xtr, ytr)
    acc = accuracy_score(yte, clf.predict(Xte))
    assert 0.0 <= acc <= 1.0
    assert acc > 0.7


def test_standard_scaler_standardizes():
    from sklearn.preprocessing import StandardScaler

    rng = np.random.default_rng(0)
    X = rng.normal(loc=5.0, scale=3.0, size=(500, 4))
    Xs = StandardScaler().fit_transform(X)
    # Standardized columns are centered (~0) with unit variance (~1).
    assert np.allclose(Xs.mean(axis=0), 0.0, atol=1e-8)
    assert np.allclose(Xs.std(axis=0), 1.0, atol=1e-6)


def test_kmeans_recovers_k_clusters():
    from sklearn.cluster import KMeans
    from sklearn.datasets import make_blobs

    X, _ = make_blobs(n_samples=300, centers=3, cluster_std=0.6, random_state=0)
    km = KMeans(n_clusters=3, n_init=10, random_state=0).fit(X)
    assert km.cluster_centers_.shape == (3, 2)
    # Three well-separated blobs → three occupied labels.
    assert len(np.unique(km.labels_)) == 3


def test_pipeline_scale_then_classify():
    from sklearn.datasets import make_classification
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler

    X, y = make_classification(n_samples=200, n_features=6, random_state=2)
    pipe = Pipeline(
        [
            ("scale", StandardScaler()),
            ("clf", LogisticRegression(max_iter=1000)),
        ]
    )
    pipe.fit(X, y)
    assert pipe.score(X, y) > 0.7
    assert pipe.predict(X).shape == (200,)


run_test("logistic regression learns signal", test_logistic_regression_learns)
run_test("random forest split + accuracy", test_random_forest_split_and_accuracy)
run_test("StandardScaler standardizes", test_standard_scaler_standardizes)
run_test("KMeans recovers 3 clusters", test_kmeans_recovers_k_clusters)
run_test("Pipeline scale->classify", test_pipeline_scale_then_classify)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all scikit-learn smoke tests passed")
