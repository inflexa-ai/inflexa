"""Quantify the shape of the raw p-value histogram from the primary DESeq2
contrast and write a short interpretation. The figure itself
(figures/pvalue_histogram_primary.{png,pdf}) was already produced in T1S2
and is copied into this report's figures/ directory by
scripts/assemble_report_figures.sh; this script only computes the bin
counts used to state the interpretation quantitatively.
"""

import logging
from pathlib import Path

import numpy as np
import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

DE_RESULTS_PATH = Path(
    "/eval-u25-live-with-two-group-n6-enrich-s1-1/runs/6b692565-63c3-4c64-8953-bea66a07c077"
    "/T1S2/output/de_results_treated_vs_control_primary.csv"
)
N_BINS = 20  # matches the 0.05-wide bins used in the T1S2 figure


def compute_histogram(pvalues: pd.Series, n_bins: int) -> pd.DataFrame:
    """Bin counts of the raw (non-NA) p-values, 0-1 in n_bins equal bins."""
    p = pvalues.dropna().to_numpy()
    counts, edges = np.histogram(p, bins=n_bins, range=(0.0, 1.0))
    return pd.DataFrame(
        {
            "bin_low": edges[:-1],
            "bin_high": edges[1:],
            "n_genes": counts,
        }
    )


def interpret(hist: pd.DataFrame, n_total: int) -> dict:
    """Compare the near-zero bin to the flat tail to characterize the shape."""
    first_bin = int(hist.iloc[0]["n_genes"])
    tail_bins = hist.iloc[int(len(hist) * 0.4):]  # bins from p=0.4 to p=1.0
    tail_mean = tail_bins["n_genes"].mean()
    tail_sd = tail_bins["n_genes"].std()
    last_bin = int(hist.iloc[-1]["n_genes"])
    enrichment_ratio = first_bin / tail_mean if tail_mean > 0 else np.nan
    return {
        "n_genes_with_pvalue": n_total,
        "first_bin_[0,0.05)_count": first_bin,
        "last_bin_[0.95,1.0]_count": last_bin,
        "tail_mean_count_p_gte_0.4": round(float(tail_mean), 1),
        "tail_sd_count_p_gte_0.4": round(float(tail_sd), 1),
        "enrichment_ratio_first_bin_vs_tail_mean": round(float(enrichment_ratio), 2),
    }


def main() -> None:
    Path("output").mkdir(exist_ok=True)
    df = pd.read_csv(DE_RESULTS_PATH)
    hist = compute_histogram(df["pvalue"], N_BINS)
    hist.to_csv("output/pvalue_histogram_bin_counts.csv", index=False)

    stats = interpret(hist, int(df["pvalue"].notna().sum()))
    pd.DataFrame([stats]).to_csv("output/pvalue_histogram_interpretation_stats.csv", index=False)
    logger.info("P-value histogram interpretation stats: %s", stats)


if __name__ == "__main__":
    main()
