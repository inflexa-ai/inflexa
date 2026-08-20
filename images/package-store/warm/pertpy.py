#!/usr/bin/env python3
"""The warm workload of pertpy.

`Distance.pairwise` with the default metric (`edistance`) compiles the three
euclidean kernels of pertpy, and each one caches. The default representation
is `X_pca`, thus the fixture makes it first — the type of the entry follows
that route. The fixture duplicates across the warm scripts on purpose.
"""

import anndata as ad
import numpy as np
import pandas as pd
import scipy.sparse as sp
import scanpy as sc

N_CELLS = 600
N_GENES = 600
N_PCS = 20


def make_processed() -> ad.AnnData:
    rng = np.random.default_rng(0)
    counts = rng.poisson(0.4, size=(N_CELLS, N_GENES)).astype(np.float32)
    adata = ad.AnnData(sp.csr_matrix(counts))
    adata.obs_names = [f"cell{i}" for i in range(N_CELLS)]
    adata.var_names = [f"GENE{i}" for i in range(N_GENES)]
    adata.obs["group"] = pd.Categorical(["treated" if i % 2 else "control" for i in range(N_CELLS)])
    sc.pp.normalize_total(adata, target_sum=1e4)
    sc.pp.log1p(adata)
    sc.pp.scale(adata, max_value=10)
    sc.pp.pca(adata, n_comps=N_PCS)
    return adata


def main() -> None:
    import pertpy as pt

    adata = make_processed()
    frame = pt.tl.Distance().pairwise(adata, groupby="group", show_progressbar=False)
    print(f"[warm] pertpy: distance {float(frame.iloc[0, 1]):.4f}")


if __name__ == "__main__":
    main()
