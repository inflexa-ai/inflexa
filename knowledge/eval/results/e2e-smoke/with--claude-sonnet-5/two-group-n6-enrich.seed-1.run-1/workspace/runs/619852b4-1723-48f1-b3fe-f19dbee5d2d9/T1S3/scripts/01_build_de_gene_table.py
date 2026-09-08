"""
01_build_de_gene_table.py

Build the consolidated DE gene table for the integrated report: takes the
DESeq2 results table produced by T1S2 (already correct — this step does not
re-run DESeq2), re-sorts it by apeglm-shrunken log2FoldChange, and writes both
the full tested-gene table and the padj<0.05 significant subset.

Input:
  T1S2/output/deseq2_results.csv
    columns: gene, base_mean, log2_fold_change (apeglm-shrunken),
             log2_fold_change_unshrunken, lfc_se, stat, pvalue,
             adjusted_pvalue, na_reason

Output:
  output/de_gene_table_full.csv        - all genes that entered the filtered
                                          matrix (9782 rows), ranked by
                                          shrunken log2FoldChange descending
  output/de_gene_table_significant.csv - padj < 0.05 subset (875 rows), same
                                          ranking
  output/de_gene_table_summary.json    - counts/thresholds for the report
"""

import json
import logging
from pathlib import Path

import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# %% Parameters
T1S2_RESULTS = Path(
    "/eval-e2e-smoke-with-two-group-n6-enrich-s1-1/runs/619852b4-1723-48f1-b3fe-f19dbee5d2d9/"
    "T1S2/output/deseq2_results.csv"
)
PADJ_THRESHOLD = 0.05
OUTPUT_DIR = Path("output")


def load_deseq2_results(path: Path) -> pd.DataFrame:
    """Load the DESeq2 results table exactly as produced upstream."""
    df = pd.read_csv(path)
    required = {
        "gene",
        "base_mean",
        "log2_fold_change",
        "log2_fold_change_unshrunken",
        "lfc_se",
        "stat",
        "pvalue",
        "adjusted_pvalue",
        "na_reason",
    }
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"deseq2_results.csv is missing expected columns: {missing}")
    logger.info("Loaded %d rows from %s", len(df), path)
    return df


def rename_for_report(df: pd.DataFrame) -> pd.DataFrame:
    """Rename columns to explicit, human-readable names for the report table."""
    out = df.rename(
        columns={
            "log2_fold_change": "log2_fold_change_shrunken_apeglm",
            "log2_fold_change_unshrunken": "log2_fold_change_unshrunken",
            "lfc_se": "lfc_se_shrunken",
            "adjusted_pvalue": "padj_BH",
        }
    )
    return out


def build_tables(df: pd.DataFrame, padj_threshold: float) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Rank by shrunken log2FoldChange (descending) and split significant subset."""
    ranked = df.sort_values("log2_fold_change_shrunken_apeglm", ascending=False).reset_index(drop=True)
    ranked.insert(0, "rank_by_shrunken_lfc", range(1, len(ranked) + 1))
    sig = ranked[ranked["padj_BH"] < padj_threshold].copy()
    sig = sig.reset_index(drop=True)
    sig["rank_by_shrunken_lfc"] = range(1, len(sig) + 1)
    logger.info(
        "Ranked %d tested genes; %d significant at padj < %.2f",
        len(ranked),
        len(sig),
        padj_threshold,
    )
    return ranked, sig


def write_summary(full: pd.DataFrame, sig: pd.DataFrame, padj_threshold: float, out_path: Path) -> None:
    n_tested = full["padj_BH"].notna().sum()
    summary = {
        "n_genes_in_filtered_matrix": int(len(full)),
        "n_genes_with_padj_reported": int(n_tested),
        "padj_threshold": padj_threshold,
        "n_de_genes": int(len(sig)),
        "n_de_up": int((sig["log2_fold_change_shrunken_apeglm"] > 0).sum()),
        "n_de_down": int((sig["log2_fold_change_shrunken_apeglm"] < 0).sum()),
        "ranking_column": "log2_fold_change_shrunken_apeglm",
        "ranking_order": "descending",
        "top5_up_by_shrunken_lfc": sig.nlargest(5, "log2_fold_change_shrunken_apeglm")["gene"].tolist(),
        "top5_down_by_shrunken_lfc": sig.nsmallest(5, "log2_fold_change_shrunken_apeglm")["gene"].tolist(),
    }
    out_path.write_text(json.dumps(summary, indent=2))
    logger.info("Wrote summary to %s", out_path)


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    raw = load_deseq2_results(T1S2_RESULTS)
    renamed = rename_for_report(raw)
    full, sig = build_tables(renamed, PADJ_THRESHOLD)
    full.to_csv(OUTPUT_DIR / "de_gene_table_full.csv", index=False)
    sig.to_csv(OUTPUT_DIR / "de_gene_table_significant.csv", index=False)
    write_summary(full, sig, PADJ_THRESHOLD, OUTPUT_DIR / "de_gene_table_summary.json")
    logger.info("Done.")


if __name__ == "__main__":
    main()
