"""Package the primary DESeq2 result into an AnnData container for
cross-agent consumption, per the domain convention (samples in .obs, genes
in .var, values in .X, raw counts in .layers["counts"]).

Reads the CSVs written by scripts/00_provenance_and_sample_sheet.R and
scripts/deseq2_primary.R -- does not recompute anything.
"""

import logging
from pathlib import Path

import anndata as ad
import numpy as np
import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

RAW_COUNTS_PATH = Path(
    "/eval-u25-live-with-two-group-n6-enrich-s1-1/data/inputs/local/counts.csv"
)
SAMPLE_SHEET_PATH = Path("output/sample_sheet_deseq2.csv")
NORM_COUNTS_PATH = Path("output/normalized_counts_primary.csv")
VST_PATH = Path("output/vst_counts_primary.csv")
DE_RESULTS_PATH = Path("output/de_results_treated_vs_control_primary.csv")
SIZE_FACTORS_PATH = Path("output/size_factors_primary.csv")
OUTPUT_H5AD = Path("output/deseq2_primary.h5ad")

ALPHA = 0.05


def load_primary_sample_ids(sample_sheet_path: Path) -> list[str]:
    """Sample ids kept in the primary contrast (excluded_primary == False)."""
    sheet = pd.read_csv(sample_sheet_path)
    primary = sheet.loc[~sheet["excluded_primary"], "sample"].tolist()
    logger.info("Primary sample set: %d samples", len(primary))
    return primary


def build_adata(
    raw_counts_path: Path,
    sample_sheet_path: Path,
    norm_counts_path: Path,
    vst_path: Path,
    de_results_path: Path,
    size_factors_path: Path,
) -> ad.AnnData:
    """Assemble the AnnData object: X = normalized counts, layers = raw/VST,
    var = DE results, obs = sample metadata."""
    primary_samples = load_primary_sample_ids(sample_sheet_path)

    norm_counts = pd.read_csv(norm_counts_path, index_col="gene")
    vst = pd.read_csv(vst_path, index_col="gene")
    de_results = pd.read_csv(de_results_path, index_col="gene")
    genes = norm_counts.index.tolist()

    raw_counts_full = pd.read_csv(raw_counts_path, index_col=0)
    raw_counts = raw_counts_full.loc[genes, primary_samples]

    sheet = pd.read_csv(sample_sheet_path, index_col="sample")
    obs = sheet.loc[primary_samples, ["condition", "library_size"]].copy()
    size_factors = pd.read_csv(size_factors_path, index_col="sample")
    obs["size_factor"] = size_factors.loc[primary_samples, "size_factor"]

    var = de_results.loc[genes].copy()
    var["significant_padj_0_05"] = var["adjusted_pvalue"] < ALPHA

    adata = ad.AnnData(
        X=norm_counts[primary_samples].T.values.astype(np.float64),
        obs=obs,
        var=var,
        layers={
            "counts": raw_counts[primary_samples].T.values.astype(np.float64),
            "vst": vst[primary_samples].T.values.astype(np.float64),
        },
    )
    adata.obs_names = primary_samples
    adata.var_names = genes
    adata.uns["deseq2_contrast"] = "condition_treated_vs_control"
    adata.uns["deseq2_reference_level"] = "control"
    adata.uns["deseq2_test"] = "Wald"
    adata.uns["deseq2_lfc_shrinkage"] = "apeglm"
    adata.uns["alpha"] = ALPHA
    adata.uns["excluded_sample"] = "sample_01 (T1S1 QC decision; see output/sample_sheet_deseq2.csv)"
    adata.uns["n_significant"] = int(var["significant_padj_0_05"].sum())
    return adata


def main() -> None:
    adata = build_adata(
        RAW_COUNTS_PATH,
        SAMPLE_SHEET_PATH,
        NORM_COUNTS_PATH,
        VST_PATH,
        DE_RESULTS_PATH,
        SIZE_FACTORS_PATH,
    )
    logger.info("AnnData assembled: %d samples x %d genes", adata.n_obs, adata.n_vars)
    adata.write_h5ad(OUTPUT_H5AD)
    logger.info("Wrote %s", OUTPUT_H5AD)


if __name__ == "__main__":
    main()
