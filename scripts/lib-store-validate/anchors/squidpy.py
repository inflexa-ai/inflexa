#!/usr/bin/env python3
"""Anchor: squidpy (spatial) — build a small spatial AnnData and compute a
spatial neighbors graph. Exercises squidpy's compiled graph backend on a
synthetic tissue coordinate set."""
import numpy as np
import scanpy as sc
import squidpy as sq
from anndata import AnnData

rng = np.random.default_rng(0)
n = 150
X = rng.poisson(1.0, size=(n, 40)).astype("float32")
coords = rng.uniform(0, 100, size=(n, 2)).astype("float32")
adata = AnnData(X)
adata.obsm["spatial"] = coords

sc.pp.normalize_total(adata)
sc.pp.log1p(adata)
sq.gr.spatial_neighbors(adata, coord_type="generic", n_neighs=6)

assert "spatial_connectivities" in adata.obsp, "spatial graph not built"
assert adata.obsp["spatial_connectivities"].shape == (n, n)
print(f"squidpy anchor OK: spatial graph over {n} spots")
