#!/usr/bin/env python3
"""Smoke test for the Python `anndata` package.

Fully self-contained: no input files, no network, no packages beyond anndata
(and its implied deps — numpy, pandas, h5py). Exercises the core API surface and
exits 0 only if every check passes, so it can be used as a pass/fail library
validator:

    python3 anndata.py

Install: pip install anndata   (import name: anndata)

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
    import anndata as ad
except ImportError:
    print("FAIL: package 'anndata' is not installed")
    sys.exit(1)

import numpy as np
import pandas as pd


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


print(f"anndata version: {_version(ad, 'anndata')}")

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
    """A seeded 50x20 count matrix with labelled obs/var — the shared fixture."""
    rng = np.random.default_rng(0)
    X = rng.poisson(5, (50, 20)).astype(float)
    obs = pd.DataFrame(
        {"cell_type": ["A" if i % 2 == 0 else "B" for i in range(50)]},
        index=[f"cell{i}" for i in range(50)],
    )
    var = pd.DataFrame(
        {"gene_symbol": [f"g{j}" for j in range(20)]},
        index=[f"gene{j}" for j in range(20)],
    )
    return ad.AnnData(X=X, obs=obs, var=var)


def test_construct_shape_and_counts():
    adata = _make_adata()
    assert adata.shape == (50, 20)
    assert adata.n_obs == 50
    assert adata.n_vars == 20
    assert adata.X.shape == (50, 20)


def test_obs_var_column_access():
    adata = _make_adata()
    assert list(adata.obs["cell_type"][:4]) == ["A", "B", "A", "B"]
    assert adata.var["gene_symbol"].iloc[0] == "g0"
    assert adata.var["gene_symbol"].iloc[-1] == "g19"
    assert list(adata.obs_names[:2]) == ["cell0", "cell1"]
    assert list(adata.var_names[:2]) == ["gene0", "gene1"]


def test_layers_roundtrip():
    adata = _make_adata()
    adata.layers["counts"] = adata.X.copy()
    adata.layers["doubled"] = adata.X * 2.0
    assert "counts" in adata.layers
    assert adata.layers["counts"].shape == (50, 20)
    assert np.allclose(adata.layers["counts"], adata.X)
    assert np.allclose(adata.layers["doubled"], adata.X * 2.0)


def test_obsm_pca_roundtrip():
    adata = _make_adata()
    pca = np.random.default_rng(1).standard_normal((50, 5))
    adata.obsm["X_pca"] = pca
    assert adata.obsm["X_pca"].shape == (50, 5)
    assert np.allclose(adata.obsm["X_pca"], pca)


def test_subset_view_shape():
    adata = _make_adata()
    sub = adata[:10, :5]
    assert sub.shape == (10, 5)
    assert sub.n_obs == 10
    assert sub.n_vars == 5
    assert np.allclose(sub.X, adata.X[:10, :5])


def test_h5ad_write_read_roundtrip():
    import tempfile

    adata = _make_adata()
    adata.layers["counts"] = adata.X.copy()
    adata.obsm["X_pca"] = np.random.default_rng(2).standard_normal((50, 4))
    fd, path = tempfile.mkstemp(suffix=".h5ad")
    os.close(fd)
    try:
        adata.write_h5ad(path)
        back = ad.read_h5ad(path)
        assert back.shape == (50, 20)
        assert np.allclose(back.X, adata.X)
        assert np.allclose(back.layers["counts"], adata.layers["counts"])
        assert np.allclose(back.obsm["X_pca"], adata.obsm["X_pca"])
        assert list(back.obs["cell_type"]) == list(adata.obs["cell_type"])
    finally:
        os.remove(path)


run_test("construct: shape / n_obs / n_vars", test_construct_shape_and_counts)
run_test("obs/var column access", test_obs_var_column_access)
run_test("layers assignment + readback", test_layers_roundtrip)
run_test("obsm X_pca roundtrip", test_obsm_pca_roundtrip)
run_test("subset [:10, :5] shape", test_subset_view_shape)
run_test("h5ad tempfile write/read round-trip", test_h5ad_write_read_roundtrip)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all anndata smoke tests passed")
