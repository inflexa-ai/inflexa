#!/usr/bin/env python3
"""Smoke test for the Python `umap-learn` package (import name: umap).

Fully self-contained: no input files, no network, no packages beyond umap-learn
(and its implied deps — numpy, scikit-learn, numba). Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a pass/fail
library validator:

    python3 umap-learn.py

Install: pip install umap-learn   (import name: umap)

FLAG — numba dependency + slow. umap-learn JIT-compiles with numba on first use,
so even this tiny fit is comparatively slow (seconds, not milliseconds). The fit
is seeded (`random_state=0`) for determinism.

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
    import umap
except ImportError:
    print("FAIL: package 'umap-learn' is not installed")
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


print(f"umap-learn version: {_version(umap, 'umap-learn')}")

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


def _make_blobs():
    """Three seeded Gaussian blobs in 10-D — 150 points, well separated."""
    rng = np.random.default_rng(0)
    centers = np.array([[0.0] * 10, [8.0] * 10, [-8.0] * 10])
    X = np.vstack([c + rng.normal(scale=0.5, size=(50, 10)) for c in centers])
    return X


def test_umap_embedding_shape():
    # FLAG: numba-compiled + slow. Seeded for a deterministic embedding.
    X = _make_blobs()
    reducer = umap.UMAP(n_neighbors=10, n_components=2, random_state=0)
    emb = reducer.fit_transform(X)
    assert emb.shape == (150, 2)
    assert np.isfinite(emb).all()


run_test("UMAP fit_transform 2D embedding (numba, slow)", test_umap_embedding_shape)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all umap-learn smoke tests passed")
