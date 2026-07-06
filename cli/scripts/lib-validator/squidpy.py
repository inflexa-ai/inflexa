#!/usr/bin/env python3
"""Smoke test for the Python `squidpy` package.

Fully self-contained: no input files, no network. `squidpy.datasets` would
fetch over the network, so this test instead builds a synthetic AnnData with
`obsm["spatial"]` coordinates and runs the spatial-graph builder on it, exiting
0 only if every check passes, so it can be used as a pass/fail library
validator:

    python3 squidpy.py

Install: pip install squidpy   (import name: squidpy)

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.

NOTE (correct-by-review, deliberately MODEST): squidpy sits on the scverse
stack (anndata + scanpy), and its graph/enrichment tools mutate an AnnData in
place. This test seeds its RNG for determinism and only exercises the
graph-construction path (`gr.spatial_neighbors`) plus one enrichment
(`gr.nhood_enrichment`); it does not fetch datasets, plot, or run image
analysis.
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import squidpy
except ImportError:
    print("FAIL: package 'squidpy' is not installed")
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


print(f"squidpy version: {_version(squidpy, 'squidpy')}")

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


def _synthetic_adata(n=60, n_genes=8, seed=0):
    """AnnData with a seeded expression matrix and 2-D spatial coordinates."""
    import anndata as ad
    import numpy as np

    rng = np.random.default_rng(seed)
    X = rng.random((n, n_genes)).astype("float32")
    adata = ad.AnnData(X)
    # squidpy reads point coordinates from obsm["spatial"].
    adata.obsm["spatial"] = rng.random((n, 2)) * 100.0
    return adata


def test_spatial_neighbors_builds_graph():
    import numpy as np

    adata = _synthetic_adata()
    n = adata.n_obs
    # "generic" coord_type treats obsm["spatial"] as arbitrary point coordinates.
    squidpy.gr.spatial_neighbors(adata, coord_type="generic", n_neighs=6)
    assert "spatial_connectivities" in adata.obsp
    assert "spatial_distances" in adata.obsp
    conn = adata.obsp["spatial_connectivities"]
    assert conn.shape == (n, n)
    # A neighbor graph must have at least one edge.
    assert conn.nnz > 0
    _ = np  # keep the deterministic-import contract explicit


def test_nhood_enrichment_optional():
    import numpy as np
    import pandas as pd

    adata = _synthetic_adata(seed=1)
    rng = np.random.default_rng(2)
    adata.obs["cluster"] = pd.Categorical(rng.choice(["a", "b", "c"], size=adata.n_obs))
    squidpy.gr.spatial_neighbors(adata, coord_type="generic", n_neighs=6)
    # Permutation-based enrichment; seed + small n_perms keep it fast and stable.
    squidpy.gr.nhood_enrichment(
        adata, cluster_key="cluster", seed=0, n_perms=20, show_progress_bar=False
    )
    assert "cluster_nhood_enrichment" in adata.uns
    zscore = adata.uns["cluster_nhood_enrichment"]["zscore"]
    # 3 clusters -> a 3x3 enrichment matrix.
    assert zscore.shape == (3, 3)


run_test("gr.spatial_neighbors builds a spatial graph", test_spatial_neighbors_builds_graph)
run_test("gr.nhood_enrichment (optional)", test_nhood_enrichment_optional)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all squidpy smoke tests passed")
