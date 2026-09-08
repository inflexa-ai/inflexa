#!/usr/bin/env python3
"""Compute the full 0.05-wide p-value histogram bin table from the DESeq2
results table, as supporting evidence for the shape call made in the R
script's console log and output/deseq2_summary.json. Read-only diagnostic,
no re-analysis.
"""
import logging

import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

RESULTS_PATH = "output/deseq2_results.csv"
OUTPUT_PATH = "output/deseq2_pvalue_histogram_bins.csv"
BIN_WIDTH = 0.05


def main() -> None:
    df = pd.read_csv(RESULTS_PATH)
    pvals = df["pvalue"].dropna()
    logger.info("Genes with a non-NA raw p-value: %d", len(pvals))
    bins = pd.cut(pvals, bins=[round(i * BIN_WIDTH, 2) for i in range(21)], include_lowest=True)
    counts = bins.value_counts().sort_index()
    uniform_expected = len(pvals) / 20
    out = counts.rename("n_genes").reset_index().rename(columns={"index": "pvalue_bin"})
    out["uniform_expected"] = round(uniform_expected, 1)
    out.to_csv(OUTPUT_PATH, index=False)
    logger.info("Wrote %s", OUTPUT_PATH)
    logger.info("%s", out.to_string(index=False))


if __name__ == "__main__":
    main()
