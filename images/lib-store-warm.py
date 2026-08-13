#!/usr/bin/env python3
"""The workload that prepares the caches of the package farm.

numba compiles at the first call, and it keys each cache entry on the type
signature of that call. Thus this script calls the entry points that a first
analysis reaches. An import prepares no entry, and one call of one signature
prepares one entry.

The provisioner runs this script with the farm at `/mnt/libs/current`. The
effectiveness check of the build runs the same bytes again inside a sandbox.
Each entry of a real call must load in that second run.

Two kernels of the sparse route are the exception. `_normalize_csr` of scanpy
and `sparse_mean_var_minor_axis` of fast_array_utils write on each run, and no
run loads them. The signature of each one holds a numba type that
fast_array_utils makes with a `type()` call at import. Python cannot pickle a
class that a call makes, thus the index of the cache never matches that entry
again. A sandbox compiles the two kernels itself, and no workload prevents it.

numba has no entry point of its own in an analysis. Each package below compiles
through it, thus the workload exercises numba through them.

The workload reads no file, and it writes none. The store carries no dataset,
and a sandbox has no network, thus the script makes its own matrix.
"""

import io

import anndata as ad
import matplotlib
import numpy as np
import scipy.sparse as sp

# A container has no display, thus an analysis renders through Agg. Name the
# backend before the first import of pyplot.
matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402
import scanpy as sc  # noqa: E402
import seaborn as sns  # noqa: E402

# The matrix stays small, because the type signature of a kernel does not hold
# the size of an array. The metrics step below reads up to the 500th gene of
# each cell, thus the matrix carries more genes than that.
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
    # experiment gives, and that `read_10x_mtx` and an `.h5ad` file both hold.
    # numba keys an entry on this type. Thus a float64 matrix prepares an entry
    # that no analysis loads.
    adata = ad.AnnData(sp.csr_matrix(counts))
    adata.obs_names = [f"cell{i}" for i in range(N_CELLS)]
    # The metrics step reads the mitochondrial genes under the `MT-` prefix,
    # which is the idiom of each analysis of human data.
    adata.var_names = [f"MT-{i}" if i < 10 else f"GENE{i}" for i in range(N_GENES)]
    adata.var["mt"] = adata.var_names.str.startswith("MT-")
    # Two conditions, four samples, and three cell types. The marker step, the
    # distance step, and the two models below read these columns.
    adata.obs["group"] = pd.Categorical(
        ["treated" if i % 2 else "control" for i in range(N_CELLS)]
    )
    adata.obs["sample"] = pd.Categorical([f"s{i % 4}" for i in range(N_CELLS)])
    adata.obs["cell_type"] = pd.Categorical([f"ct{i % 3}" for i in range(N_CELLS)])
    # scvi-tools and cell2location both read raw counts, and the steps below
    # replace `X`. Thus the counts stay in their own layer.
    adata.layers["counts"] = adata.X.copy()
    return adata


def warm_scanpy(adata: ad.AnnData) -> ad.AnnData:
    """Run the scanpy pipeline that a first single-cell analysis runs."""
    # The first step of an analysis. `skills/single-cell` gates cells on
    # `n_genes_by_counts`, `total_counts`, and `pct_counts_mt`, and this call
    # makes each of the three. It compiles the segment-proportion kernel of the
    # sparse matrix, which is the kernel behind `pct_counts_in_top_50_genes`.
    sc.pp.calculate_qc_metrics(adata, qc_vars=["mt"], log1p=False, inplace=True)

    # The gene selection that runs before the dimensions drop.
    # `skills/single-cell` prescribes the `seurat_v3` flavor for raw counts,
    # which is the state of the layer that this call reads. That flavor
    # compiles a kernel of its own.
    sc.pp.highly_variable_genes(
        adata, flavor="seurat_v3", n_top_genes=N_HVG, layer="counts"
    )

    # The normalization that `skills/single-cell` prescribes for standard
    # scRNA-seq data, and the log transform that follows it.
    sc.pp.normalize_total(adata, target_sum=1e4)
    sc.pp.log1p(adata)
    adata = adata[:, adata.var["highly_variable"]].copy()

    # The scale step, and the clip kernel that it compiles. The matrix stays
    # sparse up to here, and scanpy densifies inside the step as float64. That
    # route decides the type of this entry and of the marker entry below, thus
    # the workload must take it. A dense matrix at this point prepares a
    # float32 entry, and no analysis loads that one.
    sc.pp.scale(adata, max_value=10)

    # The representation that the neighbor step reads. `sc.pp.neighbors`
    # defaults to `X_pca`, thus this call makes the input of the step below.
    sc.pp.pca(adata, n_comps=N_PCS)

    # The largest part of the prepared cache. pynndescent compiles about 25
    # kernels here, and each one caches. umap compiles its distance kernel at
    # this import, and that entry caches too.
    #
    # `sc.pp.neighbors` selects this transformer itself for a dataset of 8192
    # cells or more, which a real analysis is. The name is explicit, because
    # the workload keeps a small matrix, and the size of a matrix does not
    # change the type signature of a kernel.
    sc.pp.neighbors(adata, n_neighbors=N_NEIGHBORS, transformer="pynndescent")

    # The marker step, which `skills/single-cell` names for a comparison inside
    # one condition. Wilcoxon is the default method, and it compiles the rank
    # kernel on a dense block of the matrix.
    sc.tl.rank_genes_groups(adata, groupby="group", method="wilcoxon")
    print(f"[warm] scanpy: {adata.shape[0]} cells, {adata.shape[1]} genes")
    return adata


def warm_plots(adata: ad.AnnData) -> None:
    """Render the figure that an analysis reports its markers with."""
    markers = sc.get.rank_genes_groups_df(adata, group="treated").head(10)["names"]
    frame = pd.DataFrame(
        adata[:20, list(markers)].X,
        columns=list(markers),
        index=adata.obs_names[:20],
    )
    # `sns.heatmap` is the seaborn entry point of this product. Seven reference
    # documents under `skills/` draw their matrix with it.
    fig, ax = plt.subplots(figsize=(4, 3))
    sns.heatmap(frame, cmap="RdBu_r", center=0, ax=ax)
    ax.set_title("marker expression")
    # The font cache arrives with the first import of pyplot, and not with this
    # save. The save is here because each analysis writes a figure, and it
    # proves the render path of Agg. The bytes go to a buffer in memory,
    # because the workload writes no file.
    buffer = io.BytesIO()
    fig.savefig(buffer, format="png", dpi=100, bbox_inches="tight")
    plt.close(fig)
    print(f"[warm] figure: {len(buffer.getvalue())} bytes")


def warm_pertpy(adata: ad.AnnData) -> None:
    """Measure the distance between the two conditions."""
    import pertpy as pt

    # `Distance.pairwise` with the default metric, which is `edistance`. It
    # compiles the three euclidean kernels of pertpy, and each one caches. The
    # default representation is `X_pca`, thus the step above gives the type.
    frame = pt.tl.Distance().pairwise(adata, groupby="group", show_progressbar=False)
    print(f"[warm] pertpy: distance {float(frame.iloc[0, 1]):.4f}")


def warm_scvi(adata: ad.AnnData) -> None:
    """Fit the model that an analysis integrates its batches with."""
    import scvi

    # scvi-tools holds no numba, thus this call prepares no cache entry. The
    # import of the package is what prepares its bytecode, and the `modules`
    # list of the manifest holds that import.
    #
    # The call is here because it proves that the entry point runs. An import
    # succeeds while `SCVI(adata)` fails against a dependency that resolved to
    # another version. A catalog with a broken entry point must fail the build,
    # and not an analysis. One fit of one epoch buys that proof, thus it is
    # cheap.
    #
    # One epoch is enough, because the fit is not what this proves.
    scvi.settings.seed = 0
    scvi.model.SCVI.setup_anndata(adata, layer="counts", batch_key="sample")
    model = scvi.model.SCVI(adata, n_latent=10)
    model.train(max_epochs=1, accelerator="cpu", enable_progress_bar=False)
    latent = model.get_latent_representation()
    print(f"[warm] scvi: latent {latent.shape[0]}x{latent.shape[1]}")


def warm_cell2location(adata: ad.AnnData) -> None:
    """Fit the reference signatures of a spatial deconvolution."""
    from cell2location.models import RegressionModel

    # The first of the two stages that `skills/spatial-omics` describes: the
    # regression model that learns the signature of each cell type. The second
    # stage reads the result of this one, thus an analysis reaches this call
    # first.
    #
    # cell2location holds no numba either, thus this call prepares no cache
    # entry. It proves the entry point, the same as the call above, and it is
    # the pair that breaks first: cell2location builds on scvi-tools, and the
    # resolver picks the version of scvi-tools from the other requirements.
    RegressionModel.setup_anndata(adata, batch_key="sample", labels_key="cell_type")
    model = RegressionModel(adata)
    model.train(max_epochs=1, batch_size=256, train_size=1, lr=0.002)
    print("[warm] cell2location: reference model fitted")


def main() -> None:
    counts = make_counts()
    processed = warm_scanpy(counts.copy())
    warm_plots(processed)
    warm_pertpy(processed)
    # The two models below read raw counts, thus each one gets its own copy of
    # the matrix that the pipeline above did not touch.
    warm_scvi(counts.copy())
    warm_cell2location(counts.copy())


if __name__ == "__main__":
    main()
