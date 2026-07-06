#!/usr/bin/env python3
"""Smoke test for the Python `scvelo` package.

Fully self-contained: no input files, no network. Exercises the core API
surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 scvelo.py

Install: pip install scvelo   (import name: scvelo)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

MODEST + FLAGGED: scVelo is RNA-velocity on top of scanpy/anndata. The bundled
`scvelo.datasets` fetch over the network (NOT used here) and a full velocity
graph is heavy, so this builds a tiny SEEDED synthetic AnnData with spliced /
unspliced layers, runs only the light `pp.moments` step, and asserts the
resulting layers/shapes. It does NOT compute the velocity graph.
(correct-by-review.)
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import scvelo
except ImportError:
    print("FAIL: package 'scvelo' is not installed")
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


print(f"scvelo version: {_version(scvelo, 'scvelo')}")

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


def test_exposes_pp_tl_namespaces():
    assert hasattr(scvelo, "pp")
    assert hasattr(scvelo, "tl")
    assert hasattr(scvelo.pp, "moments")


def test_moments_on_synthetic_anndata():
    import numpy as np
    from anndata import AnnData

    rng = np.random.default_rng(0)
    n_obs, n_vars = 40, 12
    counts = rng.poisson(5.0, size=(n_obs, n_vars)).astype(float)
    spliced = rng.poisson(4.0, size=(n_obs, n_vars)).astype(float)
    unspliced = rng.poisson(1.0, size=(n_obs, n_vars)).astype(float)
    adata = AnnData(X=counts, layers={"spliced": spliced, "unspliced": unspliced})

    scvelo.pp.moments(adata, n_neighbors=5, n_pcs=5)

    # moments derives first-order Ms/Mu layers from the neighbor graph.
    assert "Ms" in adata.layers and "Mu" in adata.layers
    assert adata.layers["Ms"].shape == (n_obs, n_vars)
    assert adata.layers["Mu"].shape == (n_obs, n_vars)


run_test("exposes scvelo.pp / scvelo.tl", test_exposes_pp_tl_namespaces)
run_test("pp.moments on synthetic spliced/unspliced AnnData", test_moments_on_synthetic_anndata)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all scvelo smoke tests passed")
