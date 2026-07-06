#!/usr/bin/env python3
"""Smoke test for the Python `snf` package (Similarity Network Fusion).

Fully self-contained: no input files, no network, no packages beyond snfpy
(and its implied deps: numpy, scipy, scikit-learn). Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 snfpy.py

Install: pip install snfpy   (import name: snf)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

snf is genuinely offline-shaped: Similarity Network Fusion runs entirely in
memory over synthetic matrices. make_affinity(data_list, K, mu) turns a list of
(samples x features) views — same samples, different feature spaces (the
canonical multi-omics setup) — into per-view sample-by-sample affinity
matrices; snf(affinity_list, K) fuses them into ONE sample-by-sample network;
get_n_clusters(fused) estimates the number of clusters via eigengap. Checks are
seeded and structural / tolerance-based. (correct-by-review — genuinely
offline-shaped.)
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import snf
except ImportError:
    print("FAIL: package 'snfpy' is not installed")
    sys.exit(1)


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


print(f"snf version: {_version(snf, 'snfpy')}")

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


def _two_views(seed):
    """Two seeded views over the SAME 40 samples in DIFFERENT feature spaces."""
    import numpy as np

    rng = np.random.default_rng(seed)
    n_samples = 40
    view1 = rng.standard_normal((n_samples, 15))
    view2 = rng.standard_normal((n_samples, 25))
    return n_samples, [view1, view2]


def test_make_affinity_shapes():
    import numpy as np

    n_samples, views = _two_views(0)
    affinities = snf.make_affinity(views, K=20, mu=0.5)
    # A list in → a list of sample-by-sample affinity matrices out, one per view.
    assert isinstance(affinities, list)
    assert len(affinities) == 2
    for aff in affinities:
        assert aff.shape == (n_samples, n_samples)
        assert np.all(np.isfinite(aff))


def test_snf_fusion_is_square_symmetric_finite():
    import numpy as np

    n_samples, views = _two_views(0)
    affinities = snf.make_affinity(views, K=20, mu=0.5)
    fused = snf.snf(affinities, K=20)
    assert fused.shape == (n_samples, n_samples)
    assert np.all(np.isfinite(fused))
    # SNF's final step symmetrises the fused network.
    assert np.allclose(fused, fused.T, atol=1e-8)


def test_get_n_clusters_returns_candidates():
    n_samples, views = _two_views(1)
    affinities = snf.make_affinity(views, K=20, mu=0.5)
    fused = snf.snf(affinities, K=20)
    candidates = snf.get_n_clusters(fused)
    # get_n_clusters returns the top-two eigengap estimates of the cluster count.
    assert len(candidates) == 2
    assert all(int(c) >= 1 for c in candidates)


run_test("make_affinity yields per-view sample x sample matrices", test_make_affinity_shapes)
run_test("snf fuses to a square, symmetric, finite network", test_snf_fusion_is_square_symmetric_finite)
run_test("get_n_clusters returns candidate cluster counts", test_get_n_clusters_returns_candidates)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all snf smoke tests passed")
