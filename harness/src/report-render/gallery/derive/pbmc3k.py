# /// script
# dependencies = ["scanpy", "anndata", "pandas", "numpy", "h5py", "scipy"]
# [tool.uv]
# exclude-newer = "2026-09-25T00:00:00Z"
# ///
"""
Build derived/singlecell/cells.csv and derived/singlecell/marker_dotplot.csv
from scanpy's pbmc3k_processed() dataset (2,638 PBMCs, 10x Genomics 2016,
reprocessed by the scanpy project per the pbmc3k clustering tutorial).

Usage: uv run pbmc3k.py <gallery-data work dir>

scripts/gallery-data.sh downloads the file that pbmc3k_processed() reads to
raw/singlecell/pbmc3k_processed.h5ad, thus scanpy reads it in place and
downloads nothing.

Deterministic: no random sampling is performed (whole dataset, 2,638 cells,
fits well under the 2 MB per-table bound), so no seed is needed.
"""

import pathlib
import sys

import numpy as np
import pandas as pd
import scanpy as sc
import scipy.sparse as sp

BASE = pathlib.Path(sys.argv[1])
RAW_DIR = BASE / "raw" / "singlecell"
DERIVED_DIR = BASE / "derived" / "singlecell"
RAW_DIR.mkdir(parents=True, exist_ok=True)
DERIVED_DIR.mkdir(parents=True, exist_ok=True)

MARKERS = [
    "IL7R", "CD14", "LYZ", "MS4A1", "CD8A", "GNLY",
    "NKG7", "FCGR3A", "MS4A7", "FCER1A", "CST3", "PPBP",
]

# louvain cluster order (0-7) -> cell type name, as assigned by the scanpy
# pbmc3k clustering tutorial. The pbmc3k_processed() object already ships
# louvain as a categorical whose 8 categories are, in this exact order:
# ['CD4 T cells', 'CD14+ Monocytes', 'B cells', 'CD8 T cells', 'NK cells',
#  'FCGR3A+ Monocytes', 'Dendritic cells', 'Megakaryocytes']
# Verified against marker-gene expression in this script's own data (see
# derivation note below and the manifest fragment): for every canonical
# marker gene the cluster with the highest mean raw (log1p-normalized)
# expression is the cluster the tutorial names for it (IL7R -> CD4 T cells,
# CD14 -> CD14+ Monocytes, MS4A1 -> B cells, CD8A -> CD8 T cells,
# GNLY/NKG7 -> NK cells, FCGR3A/MS4A7 -> FCGR3A+ Monocytes,
# FCER1A -> Dendritic cells, PPBP -> Megakaryocytes). No reordering needed.
RENAME = {
    "CD4 T cells": "CD4 T",
    "CD14+ Monocytes": "CD14 Monocytes",
    "B cells": "B",
    "CD8 T cells": "CD8 T",
    "NK cells": "NK",
    "FCGR3A+ Monocytes": "FCGR3A Monocytes",
    "Dendritic cells": "Dendritic",
    "Megakaryocytes": "Megakaryocytes",
}

sc.settings.datasetdir = str(RAW_DIR)
adata = sc.datasets.pbmc3k_processed()

cluster_order = [RENAME[c] for c in adata.obs["louvain"].cat.categories]
cluster = adata.obs["louvain"].map(RENAME).astype(
    pd.CategoricalDtype(categories=cluster_order, ordered=True)
)

# Marker-gene expression: use .raw (log1p-normalized counts over all 13,714
# genes), not .X. .X holds z-scored, clipped values restricted to the 1,838
# highly-variable genes selected for PCA/clustering and is missing 5 of the
# 12 marker genes (IL7R, CD14, LYZ, CD8A, MS4A7 are not HVGs here). .raw is
# also what scanpy's own dotplot/marker-gene plotting functions read by
# default when an AnnData carries a .raw.
raw = adata.raw.to_adata()
X = raw[:, MARKERS].X
if sp.issparse(X):
    X = X.toarray()
marker_df = pd.DataFrame(np.asarray(X), columns=MARKERS, index=adata.obs_names)

cells = pd.DataFrame(
    {
        "cell_id": adata.obs_names,
        "UMAP_1": adata.obsm["X_umap"][:, 0],
        "UMAP_2": adata.obsm["X_umap"][:, 1],
        "cluster": cluster.values,
        "n_genes": adata.obs["n_genes"].values,
        "total_counts": adata.obs["n_counts"].values,
        # obs['percent_mito'] is a fraction in [0, 1]; report as a percent.
        "pct_counts_mt": adata.obs["percent_mito"].values * 100.0,
    }
)
cells = pd.concat([cells.reset_index(drop=True), marker_df.reset_index(drop=True)], axis=1)
cells.to_csv(DERIVED_DIR / "cells.csv", index=False)

# marker dotplot: fraction of cells expressing (raw value > 0) and mean
# expression (mean raw log1p-normalized value) per cluster x gene, plus a
# per-gene min-max scale across clusters matching scanpy's
# sc.pl.dotplot(..., standard_scale='var') behavior.
marker_df["cluster"] = cluster.values
long_rows = []
frac = marker_df.groupby("cluster", observed=True)[MARKERS].apply(lambda g: (g > 0).mean())
mean_expr = marker_df.groupby("cluster", observed=True)[MARKERS].mean()
frac = frac.loc[cluster_order]
mean_expr = mean_expr.loc[cluster_order]
gene_min = mean_expr.min(axis=0)
gene_max = mean_expr.max(axis=0)
scaled = (mean_expr - gene_min) / (gene_max - gene_min)

for gene in MARKERS:
    for clust in cluster_order:
        long_rows.append(
            {
                "cluster": clust,
                "gene": gene,
                "fraction_expressing": frac.loc[clust, gene],
                "mean_expression": mean_expr.loc[clust, gene],
                "mean_expression_scaled": scaled.loc[clust, gene],
            }
        )
dotplot = pd.DataFrame(long_rows)
dotplot.to_csv(DERIVED_DIR / "marker_dotplot.csv", index=False)

print("cells.csv rows:", len(cells))
print("marker_dotplot.csv rows:", len(dotplot))
