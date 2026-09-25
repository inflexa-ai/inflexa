# /// script
# dependencies = ["pertpy", "scanpy", "anndata", "pandas", "numpy", "h5py", "filelock", "statsmodels<0.15"]
# ///
"""
Build derived/singlecell/composition.csv and
derived/singlecell/cells_by_condition_umap.csv from pertpy's kang_2018()
loader: Kang et al. 2018 (Nat Biotechnol 36:89-94), 8 lupus-donor PBMC
samples, each split into an unstimulated control and an IFN-beta-stimulated
half (GSE96583). pertpy serves a pre-processed AnnData (Seurat SCTransform
pipeline outputs plus a PCA/UMAP embedding) from a scverse-hosted S3 bucket.

sc.settings.datasetdir is pointed at raw/singlecell/ so a fresh run
downloads (or re-reads, if already present) kang_2018.h5ad in place, never
outside this scratch directory.
"""

import pathlib

import numpy as np
import pandas as pd
import pertpy as pt
import scanpy as sc

BASE = pathlib.Path("gallery-data")
RAW_DIR = BASE / "raw" / "singlecell"
DERIVED_DIR = BASE / "derived" / "singlecell"
RAW_DIR.mkdir(parents=True, exist_ok=True)
DERIVED_DIR.mkdir(parents=True, exist_ok=True)

MAX_CELLS = 20_000
SEED = 0

sc.settings.datasetdir = RAW_DIR
adata = pt.data.kang_2018()

condition = adata.obs["label"].map({"ctrl": "control", "stim": "stimulated"})
sample = adata.obs["replicate"].astype(str)
cell_type = adata.obs["cell_type"].astype(str)

# --- composition.csv ---
# "sample" here is the donor at one condition (each of the 8 donors
# contributes two physical 10x libraries, one per condition; see
# obs['replicate'] x obs['label'] cross-tab, 16 groups total). proportion is
# n_cells / total cells for that donor-condition pair, summing to 1 within
# each (sample, condition) group. Some donor-condition pairs are missing 1
# of the 8 cell types (0 of 24,673 cells of that type were recovered for
# that library) -- those combinations are simply absent from the table
# rather than filled with a fabricated 0 row.
grp = pd.DataFrame({"sample": sample, "condition": condition, "cell_type": cell_type})
counts = grp.groupby(["sample", "condition", "cell_type"], observed=True).size()
counts.name = "n_cells"
counts = counts.reset_index()
totals = counts.groupby(["sample", "condition"], observed=True)["n_cells"].transform("sum")
counts["proportion"] = counts["n_cells"] / totals
counts = counts.sort_values(["sample", "condition", "cell_type"]).reset_index(drop=True)
counts.to_csv(DERIVED_DIR / "composition.csv", index=False)

# --- cells_by_condition_umap.csv ---
# adata.X holds raw integer UMI counts (no .raw / lognorm layer is shipped
# with this AnnData). ISG15 expression is computed by library-size
# normalization to 10,000 counts/cell then log1p (scanpy
# normalize_total + log1p, standard preprocessing), applied on a copy so the
# rest of adata (used for composition.csv, above) is untouched.
n_total = adata.n_obs
rng = np.random.default_rng(SEED)
if n_total > MAX_CELLS:
    keep_idx = np.sort(rng.choice(n_total, size=MAX_CELLS, replace=False))
else:
    keep_idx = np.arange(n_total)

norm = adata.copy()
sc.pp.normalize_total(norm, target_sum=1e4)
sc.pp.log1p(norm)
isg15 = norm[:, "ISG15"].X
import scipy.sparse as sp
if sp.issparse(isg15):
    isg15 = isg15.toarray().ravel()
else:
    isg15 = np.asarray(isg15).ravel()

umap = adata.obsm["X_umap"]
umap_df = pd.DataFrame(
    {
        "cell_id": adata.obs_names.to_numpy()[keep_idx],
        "UMAP_1": umap[keep_idx, 0],
        "UMAP_2": umap[keep_idx, 1],
        "cell_type": cell_type.to_numpy()[keep_idx],
        "condition": condition.to_numpy()[keep_idx],
        "ISG15": isg15[keep_idx],
    }
)
umap_df.to_csv(DERIVED_DIR / "cells_by_condition_umap.csv", index=False)

print("total cells:", n_total, "kept:", len(keep_idx), "seed:", SEED)
print("composition.csv rows:", len(counts))
print("cells_by_condition_umap.csv rows:", len(umap_df))
