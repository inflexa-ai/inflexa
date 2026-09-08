"""QC follow-up on the DESeq2 treated-vs-control results.

Produces, from the DESeq2 template's outputs:
1. A numeric tabulation of the p-value histogram (bin counts), so the shape
   used to sanity-check BH adjustment is a persisted number, not just an image.
2. A gene-length-bias diagnostic: does |shrunken log2FC| or significance
   correlate with gene length? Median-of-ratios normalization does not use
   gene length, so a strong correlation would flag a confound worth reporting
   (not a standard DESeq2 requirement, done here because a length table was
   provided).
3. A breakdown of the significant gene set into named gene symbols vs.
   synthetic placeholder IDs (GENE#####), given the dataset caveat that ~63%
   of the 12,000 gene identifiers are non-biological placeholders.

Inputs:
    output/de_treated_vs_control_results.csv  (this step)
    data/inputs/local/gene_lengths.csv        (analysis-root input)

Outputs:
    output/pvalue_histogram_bins.csv
    output/gene_length_bias_qc.csv
    output/gene_id_composition.csv
    output/de_qc_report.json
"""

import json
import logging
import re
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

RESULTS_PATH = Path("output/de_treated_vs_control_results.csv")
LENGTHS_PATH = Path(
    "/eval-u25-live-3-with-two-group-n6-enrich-s1-1/data/inputs/local/gene_lengths.csv"
)
ALPHA = 0.05
PLACEHOLDER_PATTERN = re.compile(r"^GENE\d{5}$")
OUTPUT_DIR = Path("output")


def load_results(path: Path) -> pd.DataFrame:
    """Load the DESeq2 results table produced by the template script."""
    df = pd.read_csv(path)
    logger.info("Loaded %d tested/filtered rows from %s", len(df), path)
    return df


def tabulate_pvalue_histogram(df: pd.DataFrame) -> pd.DataFrame:
    """Bin counts of the raw Wald p-values (Cook's-outlier NAs excluded).

    A near-uniform histogram with a peak near 0 supports trusting BH padj;
    a peak near 1, a flat-plus-spike-elsewhere shape, or a bathtub shape
    signals a violated assumption (e.g. mis-specified dispersion) that would
    make BH adjustment unreliable.
    """
    pvals = df["pvalue"].dropna().to_numpy()
    bins = np.arange(0, 1.0001, 0.05)
    counts, edges = np.histogram(pvals, bins=bins)
    table = pd.DataFrame({"bin_low": edges[:-1], "bin_high": edges[1:], "n_genes": counts})
    # Uniformity check on the presumed-null tail (p > 0.5), where most genes
    # should sit if the alternative-hypothesis mass is concentrated near 0.
    tail = pvals[pvals > 0.5]
    if len(tail) > 1:
        ks_stat, ks_p = stats.kstest(tail, "uniform", args=(0.5, 0.5))
    else:
        ks_stat, ks_p = np.nan, np.nan
    table.attrs["n_pvalues"] = len(pvals)
    table.attrs["ks_stat_tail_uniform"] = float(ks_stat) if not np.isnan(ks_stat) else None
    table.attrs["ks_p_tail_uniform"] = float(ks_p) if not np.isnan(ks_p) else None
    logger.info(
        "p-value histogram: %d non-NA p-values; bin[0,0.05)=%d genes (%.1f%%); "
        "KS test of the p>0.5 tail against Uniform: stat=%.3f p=%.3f",
        len(pvals), counts[0], 100 * counts[0] / len(pvals),
        table.attrs["ks_stat_tail_uniform"] or float("nan"),
        table.attrs["ks_p_tail_uniform"] or float("nan"),
    )
    return table


def gene_length_bias_qc(df: pd.DataFrame, lengths_path: Path) -> tuple[pd.DataFrame, dict]:
    """Correlate |shrunken log2FC| and -log10(padj) against gene length.

    Not part of the DESeq2 count model (median-of-ratios normalization does
    not use length); this is a QC diagnostic only, run because a length
    table was supplied.
    """
    lengths = pd.read_csv(lengths_path)
    merged = df.merge(lengths, on="gene", how="inner")
    logger.info(
        "Gene-length QC: matched %d of %d results rows to the length table (%d genes unmatched, "
        "likely synthetic placeholder IDs with no length record)",
        len(merged), len(df), len(df) - len(merged),
    )
    merged["abs_log2fc"] = merged["log2_fold_change"].abs()
    merged["neg_log10_padj"] = -np.log10(merged["adjusted_pvalue"].clip(lower=1e-300))
    merged["significant"] = merged["adjusted_pvalue"] < ALPHA

    valid_fc = merged.dropna(subset=["abs_log2fc", "length"])
    rho_fc, p_fc = stats.spearmanr(valid_fc["length"], valid_fc["abs_log2fc"])
    valid_p = merged.dropna(subset=["neg_log10_padj", "length"])
    rho_p, p_p = stats.spearmanr(valid_p["length"], valid_p["neg_log10_padj"])

    sig_len = merged.loc[merged["significant"], "length"].dropna()
    nonsig_len = merged.loc[~merged["significant"], "length"].dropna()
    mw_stat, mw_p = stats.mannwhitneyu(sig_len, nonsig_len, alternative="two-sided")

    summary = {
        "n_genes_matched_to_length_table": len(merged),
        "n_genes_unmatched": int(len(df) - len(merged)),
        "spearman_length_vs_abs_shrunken_log2fc": {"rho": float(rho_fc), "p": float(p_fc)},
        "spearman_length_vs_neg_log10_padj": {"rho": float(rho_p), "p": float(p_p)},
        "median_length_significant_genes": float(sig_len.median()) if len(sig_len) else None,
        "median_length_nonsignificant_genes": float(nonsig_len.median()) if len(nonsig_len) else None,
        "mannwhitney_significant_vs_nonsignificant_length": {"stat": float(mw_stat), "p": float(mw_p)},
    }
    logger.info(
        "Gene-length bias: Spearman rho(length, |shrunken log2FC|)=%.3f (p=%.3g); "
        "median length sig=%.0f bp vs non-sig=%.0f bp (Mann-Whitney p=%.3g)",
        rho_fc, p_fc, summary["median_length_significant_genes"] or float("nan"),
        summary["median_length_nonsignificant_genes"] or float("nan"), mw_p,
    )
    return merged[["gene", "length", "base_mean", "log2_fold_change", "adjusted_pvalue", "significant"]], summary


def gene_id_composition(df: pd.DataFrame) -> pd.DataFrame:
    """Break down tested and significant genes into named symbols vs. GENE##### placeholders."""
    df = df.copy()
    df["is_placeholder_id"] = df["gene"].apply(lambda g: bool(PLACEHOLDER_PATTERN.match(str(g))))
    df["tested"] = df["adjusted_pvalue"].notna()
    df["significant"] = df["adjusted_pvalue"] < ALPHA

    rows = []
    for label, mask in [
        ("all_prefiltered", pd.Series(True, index=df.index)),
        ("tested_after_independent_filtering", df["tested"]),
        ("significant_padj_lt_0.05", df["significant"]),
    ]:
        subset = df[mask]
        n_placeholder = int(subset["is_placeholder_id"].sum())
        n_total = len(subset)
        rows.append({
            "gene_set": label,
            "n_total": n_total,
            "n_named_symbol": n_total - n_placeholder,
            "n_placeholder_id": n_placeholder,
            "pct_placeholder": round(100 * n_placeholder / n_total, 1) if n_total else None,
        })
    table = pd.DataFrame(rows)
    logger.info("Gene ID composition:\n%s", table.to_string(index=False))

    # Is a named gene symbol over/under-represented among significant hits
    # relative to the tested background? 2x2: {named, placeholder} x {sig, not sig}.
    tested = df[df["tested"]]
    contingency = pd.crosstab(tested["is_placeholder_id"], tested["significant"])
    odds_ratio, fisher_p = stats.fisher_exact(contingency)
    logger.info(
        "Named-symbol vs. placeholder enrichment among significant genes (Fisher's exact): "
        "odds ratio=%.3f, p=%.3g (odds ratio < 1 means placeholder IDs are UNDER-represented "
        "among significant genes, i.e. named genes are enriched)",
        odds_ratio, fisher_p,
    )
    table.attrs["fisher_odds_ratio_placeholder_vs_named_in_significant"] = float(odds_ratio)
    table.attrs["fisher_p_placeholder_vs_named_in_significant"] = float(fisher_p)
    return table


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    df = load_results(RESULTS_PATH)

    pvalue_hist = tabulate_pvalue_histogram(df)
    pvalue_hist.to_csv(OUTPUT_DIR / "pvalue_histogram_bins.csv", index=False)

    length_qc_table, length_qc_summary = gene_length_bias_qc(df, LENGTHS_PATH)
    length_qc_table.to_csv(OUTPUT_DIR / "gene_length_bias_qc.csv", index=False)

    id_composition = gene_id_composition(df)
    id_composition.to_csv(OUTPUT_DIR / "gene_id_composition.csv", index=False)

    report = {
        "pvalue_histogram": {
            "n_pvalues": pvalue_hist.attrs["n_pvalues"],
            "ks_stat_tail_uniform_p_gt_0.5": pvalue_hist.attrs["ks_stat_tail_uniform"],
            "ks_p_tail_uniform_p_gt_0.5": pvalue_hist.attrs["ks_p_tail_uniform"],
            "bins": pvalue_hist.to_dict(orient="records"),
        },
        "gene_length_bias_qc": length_qc_summary,
        "gene_id_composition": id_composition.to_dict(orient="records"),
        "gene_id_enrichment_test": {
            "fisher_odds_ratio_placeholder_vs_named_in_significant": id_composition.attrs.get(
                "fisher_odds_ratio_placeholder_vs_named_in_significant"
            ),
            "fisher_p_placeholder_vs_named_in_significant": id_composition.attrs.get(
                "fisher_p_placeholder_vs_named_in_significant"
            ),
        },
    }
    with open(OUTPUT_DIR / "de_qc_report.json", "w") as fh:
        json.dump(report, fh, indent=2)
    logger.info("Wrote QC report to %s", OUTPUT_DIR / "de_qc_report.json")


if __name__ == "__main__":
    main()
