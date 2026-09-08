"""Consolidate the DESeq2 primary-contrast gene table for the final report.

Reads the T1S2 per-gene DESeq2 results (every tested gene, unshrunken and
apeglm-shrunken log2FC, lfcSE, pvalue, padj already computed upstream — no DE
computation is repeated here), renames columns to the report's required
effect_columns, adds a significance flag, and re-ranks rows by the
shrunken log2FoldChange for display, per the rank_genes_by constraint
(DESeq2 vignette: "log fold change shrinkage for visualization and
ranking").
"""

import logging
from pathlib import Path

import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

T1S2_DIR = Path(
    "/eval-u25-live-with-two-group-n6-enrich-s1-1/runs/6b692565-63c3-4c64-8953-bea66a07c077/T1S2"
)
DE_RESULTS_PATH = T1S2_DIR / "output" / "de_results_treated_vs_control_primary.csv"
ALPHA = 0.05
OUTPUT_PATH = Path("output/consolidated_gene_table_ranked_by_shrunken_lfc.csv")


def load_de_results(path: Path) -> pd.DataFrame:
    """Load the upstream DESeq2 primary-contrast per-gene results table."""
    df = pd.read_csv(path)
    required = {
        "gene",
        "base_mean",
        "log2_fold_change",
        "lfc_se",
        "stat",
        "pvalue",
        "adjusted_pvalue",
        "log2_fold_change_shrunken",
        "lfc_se_shrunken",
    }
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"DE results table missing expected columns: {missing}")
    logger.info("Loaded %d tested genes from %s", len(df), path)
    return df


def build_consolidated_table(df: pd.DataFrame, alpha: float) -> pd.DataFrame:
    """Rename to report-facing column names, flag significance, rank by
    shrunken log2FoldChange (descending: most up in treated -> most down)."""
    out = df.rename(
        columns={
            "gene": "gene",
            "base_mean": "base_mean",
            "log2_fold_change": "log2FoldChange",
            "lfc_se": "lfcSE",
            "stat": "wald_stat",
            "pvalue": "pvalue",
            "adjusted_pvalue": "padj",
            "log2_fold_change_shrunken": "shrunken_log2FoldChange",
            "lfc_se_shrunken": "shrunken_lfcSE",
        }
    ).copy()
    out["significant_padj0.05"] = out["padj"].lt(alpha).fillna(False)
    out = out.sort_values(
        "shrunken_log2FoldChange", ascending=False, na_position="last"
    ).reset_index(drop=True)
    out.insert(0, "rank_by_shrunken_log2FC", out.index + 1)
    column_order = [
        "rank_by_shrunken_log2FC",
        "gene",
        "base_mean",
        "log2FoldChange",
        "lfcSE",
        "shrunken_log2FoldChange",
        "shrunken_lfcSE",
        "wald_stat",
        "pvalue",
        "padj",
        "significant_padj0.05",
    ]
    return out[column_order]


def summarize(table: pd.DataFrame, alpha: float) -> dict:
    """Headline counts for the report text."""
    n_tested = len(table)
    n_sig = int(table["significant_padj0.05"].sum())
    n_up = int(((table["significant_padj0.05"]) & (table["shrunken_log2FoldChange"] > 0)).sum())
    n_down = int(((table["significant_padj0.05"]) & (table["shrunken_log2FoldChange"] < 0)).sum())
    n_padj_na = int(table["padj"].isna().sum())
    return {
        "n_genes_tested": n_tested,
        "n_significant_padj0.05": n_sig,
        "n_up_in_treated": n_up,
        "n_down_in_treated": n_down,
        "n_padj_na": n_padj_na,
    }


def main() -> None:
    Path("output").mkdir(exist_ok=True)
    df = load_de_results(DE_RESULTS_PATH)
    table = build_consolidated_table(df, ALPHA)
    table.to_csv(OUTPUT_PATH, index=False)
    logger.info("Wrote consolidated gene table (%d rows) to %s", len(table), OUTPUT_PATH)

    stats = summarize(table, ALPHA)
    stats_df = pd.DataFrame([stats])
    stats_df.to_csv("output/gene_table_summary_stats.csv", index=False)
    logger.info("Summary stats: %s", stats)


if __name__ == "__main__":
    main()
