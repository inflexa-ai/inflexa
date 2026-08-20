#!/usr/bin/env python3
"""The warm workload of scvi-tools.

scvi-tools holds no numba, thus this call prepares no cache entry. The call is
here because it proves that the entry point runs: an import succeeds while
`SCVI(adata)` fails against a dependency that resolved to another version. A
catalog with a broken entry point must fail the build, not an analysis. One
epoch is enough, because the fit is not what this proves.
"""

import anndata as ad
import numpy as np
import pandas as pd
import scipy.sparse as sp

N_CELLS = 600
N_GENES = 600


def make_counts() -> ad.AnnData:
    rng = np.random.default_rng(0)
    counts = rng.poisson(0.4, size=(N_CELLS, N_GENES)).astype(np.float32)
    adata = ad.AnnData(sp.csr_matrix(counts))
    adata.obs_names = [f"cell{i}" for i in range(N_CELLS)]
    adata.var_names = [f"GENE{i}" for i in range(N_GENES)]
    adata.obs["sample"] = pd.Categorical([f"s{i % 4}" for i in range(N_CELLS)])
    adata.layers["counts"] = adata.X.copy()
    return adata


def main() -> None:
    import scvi

    scvi.settings.seed = 0
    adata = make_counts()
    scvi.model.SCVI.setup_anndata(adata, layer="counts", batch_key="sample")
    model = scvi.model.SCVI(adata, n_latent=10)
    model.train(max_epochs=1, accelerator="cpu", enable_progress_bar=False)
    latent = model.get_latent_representation()
    print(f"[warm] scvi: latent {latent.shape[0]}x{latent.shape[1]}")


if __name__ == "__main__":
    main()
