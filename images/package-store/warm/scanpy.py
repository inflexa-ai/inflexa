#!/usr/bin/env python3
"""The warm workload of scanpy.

numba compiles at the first call, and it keys each cache entry on the type
signature of that call. Thus this script calls the entry points that a first
single-cell analysis reaches. An import prepares no entry.

The preparation run of the provisioner runs this script with the catalog farm
at /mnt/libs/farm. The cache check of the build runs the same bytes again
inside the sandbox image, and each entry of a real call must load there.

Two kernels of the sparse route write on each run, and no run loads them:
`_normalize_csr` of scanpy and `sparse_mean_var_minor_axis` of
fast_array_utils each key on a numba type that a `type()` call makes at
import. The recorded entries leave them out, and a sandbox compiles the two
itself.

The workload reads no file, and it writes none. The fixture duplicates across
the warm scripts on purpose: each script is one standalone workload that the
manifest names.
"""

import anndata as ad
import numpy as np
import pandas as pd
import scipy.sparse as sp
import scanpy as sc

N_CELLS = 600
N_GENES = 600
N_HVG = 200
N_PCS = 20
N_NEIGHBORS = 15


def make_counts() -> ad.AnnData:
    """Make the counts matrix that the workload runs on."""
    rng = np.random.default_rng(0)
    counts = rng.poisson(0.4, size=(N_CELLS, N_GENES)).astype(np.float32)
    # A compressed sparse row matrix of float32: the shape that a droplet
    # experiment gives. numba keys an entry on this type, thus a float64
    # matrix prepares an entry that no analysis loads.
    adata = ad.AnnData(sp.csr_matrix(counts))
    adata.obs_names = [f"cell{i}" for i in range(N_CELLS)]
    adata.var_names = [f"MT-{i}" if i < 10 else f"GENE{i}" for i in range(N_GENES)]
    adata.var["mt"] = adata.var_names.str.startswith("MT-")
    adata.obs["group"] = pd.Categorical(["treated" if i % 2 else "control" for i in range(N_CELLS)])
    adata.layers["counts"] = adata.X.copy()
    return adata


def main() -> None:
    adata = make_counts()
    # The QC step compiles the segment-proportion kernel of the sparse matrix.
    sc.pp.calculate_qc_metrics(adata, qc_vars=["mt"], log1p=False, inplace=True)
    # The seurat_v3 flavor compiles a kernel of its own, against raw counts.
    sc.pp.highly_variable_genes(adata, flavor="seurat_v3", n_top_genes=N_HVG, layer="counts")
    sc.pp.normalize_total(adata, target_sum=1e4)
    sc.pp.log1p(adata)
    adata = adata[:, adata.var["highly_variable"]].copy()
    # The scale step densifies as float64 inside, and that route decides the
    # type of this entry and of the marker entry below.
    sc.pp.scale(adata, max_value=10)
    sc.pp.pca(adata, n_comps=N_PCS)
    # The largest part of the prepared cache: pynndescent compiles about 25
    # kernels here, and umap compiles its distance kernel at this import. The
    # transformer is explicit, because the workload keeps a small matrix and
    # the size of a matrix does not change the type signature of a kernel.
    sc.pp.neighbors(adata, n_neighbors=N_NEIGHBORS, transformer="pynndescent")
    # Wilcoxon compiles the rank kernel on a dense block of the matrix.
    sc.tl.rank_genes_groups(adata, groupby="group", method="wilcoxon")
    print(f"[warm] scanpy: {adata.shape[0]} cells, {adata.shape[1]} genes")


if __name__ == "__main__":
    main()
