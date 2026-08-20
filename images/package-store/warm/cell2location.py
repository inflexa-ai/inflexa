#!/usr/bin/env python3
"""The warm workload of cell2location.

cell2location holds no numba, thus this call prepares no cache entry. It
proves the entry point of the first of the two stages that the spatial-omics
skill describes: the regression model that learns the signature of each cell
type. The pair breaks first through scvi-tools, whose version the resolver
picks from the other requirements.
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
    adata.obs["cell_type"] = pd.Categorical([f"ct{i % 3}" for i in range(N_CELLS)])
    return adata


def main() -> None:
    from cell2location.models import RegressionModel

    adata = make_counts()
    RegressionModel.setup_anndata(adata, batch_key="sample", labels_key="cell_type")
    model = RegressionModel(adata)
    model.train(max_epochs=1, batch_size=256, train_size=1, lr=0.002)
    print("[warm] cell2location: reference model fitted")


if __name__ == "__main__":
    main()
