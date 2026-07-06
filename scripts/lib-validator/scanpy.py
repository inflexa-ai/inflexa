#!/usr/bin/env python3
"""Smoke test for the Python `scanpy` package.

Fully self-contained: no input files, no network, no packages beyond scanpy
(and its implied deps — anndata, numpy, scipy, scikit-learn). Exercises the core
API surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 scanpy.py

Install: pip install scanpy   (import name: scanpy)

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
    import scanpy as sc
except ImportError:
    print("FAIL: package 'scanpy' is not installed")
    sys.exit(1)

import anndata as ad
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


print(f"scanpy version: {_version(sc, 'scanpy')}")

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


def _make_adata():
    """A seeded 100x50 count matrix — enough cells/genes for PCA + a graph."""
    rng = np.random.default_rng(0)
    X = rng.poisson(3, (100, 50)).astype(np.float32)
    return ad.AnnData(X=X)


def test_normalize_and_log1p():
    adata = _make_adata()
    sc.pp.normalize_total(adata, target_sum=1e4)
    sc.pp.log1p(adata)
    assert adata.shape == (100, 50)
    assert np.isfinite(np.asarray(adata.X)).all()


def test_pca_shape():
    adata = _make_adata()
    sc.pp.normalize_total(adata, target_sum=1e4)
    sc.pp.log1p(adata)
    sc.pp.pca(adata, n_comps=10)
    assert "X_pca" in adata.obsm
    assert adata.obsm["X_pca"].shape == (100, 10)
    assert np.isfinite(adata.obsm["X_pca"]).all()


def test_neighbors_and_leiden():
    # sc.tl.leiden needs the optional `leidenalg` (or igraph flavor) backend and
    # may be absent — FLAG: this check exercises a dependency scanpy itself does
    # not vendor. sc.tl.louvain likewise needs `louvain`.
    adata = _make_adata()
    sc.pp.normalize_total(adata, target_sum=1e4)
    sc.pp.log1p(adata)
    sc.pp.pca(adata, n_comps=10)
    sc.pp.neighbors(adata, n_neighbors=10)
    assert "neighbors" in adata.uns
    sc.tl.leiden(adata, resolution=1.0, flavor="igraph", n_iterations=2)
    assert "leiden" in adata.obs
    assert str(adata.obs["leiden"].dtype) == "category"
    assert adata.obs["leiden"].notna().all()


def test_umap_shape():
    # sc.tl.umap needs the `umap-learn` backend (numba-compiled, slow) — FLAG.
    adata = _make_adata()
    sc.pp.normalize_total(adata, target_sum=1e4)
    sc.pp.log1p(adata)
    sc.pp.pca(adata, n_comps=10)
    sc.pp.neighbors(adata, n_neighbors=10)
    sc.tl.umap(adata)
    assert adata.obsm["X_umap"].shape == (100, 2)
    assert np.isfinite(adata.obsm["X_umap"]).all()


run_test("normalize_total + log1p finite", test_normalize_and_log1p)
run_test("pca(n_comps=10) obsm shape", test_pca_shape)
run_test("neighbors + leiden categorical (needs leidenalg)", test_neighbors_and_leiden)
run_test("umap 2D embedding (needs umap-learn)", test_umap_shape)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all scanpy smoke tests passed")
