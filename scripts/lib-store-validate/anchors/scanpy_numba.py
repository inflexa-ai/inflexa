#!/usr/bin/env python3
"""Anchor: scanpy + numba — a small end-to-end pipeline that forces the numba
JIT path (neighbors) plus PCA. On the read-only runtime mount the JIT cache
cannot be written, so this is exactly the class the build-time load check
(a writable builder) can miss and acceptance must catch."""
import numpy as np
import scanpy as sc
from anndata import AnnData

rng = np.random.default_rng(0)
X = rng.poisson(1.0, size=(200, 50)).astype("float32")
adata = AnnData(X)

sc.pp.normalize_total(adata, target_sum=1e4)
sc.pp.log1p(adata)
sc.pp.pca(adata, n_comps=10)
sc.pp.neighbors(adata, n_neighbors=10, n_pcs=10)  # numba-compiled path
sc.tl.leiden(adata, flavor="igraph", n_iterations=2, directed=False)

assert "X_pca" in adata.obsm, "PCA did not run"
assert "leiden" in adata.obs, "clustering did not run"
assert adata.obsm["X_pca"].shape == (200, 10)
print(f"scanpy anchor OK: {adata.n_obs} cells, {adata.obs['leiden'].nunique()} clusters")
