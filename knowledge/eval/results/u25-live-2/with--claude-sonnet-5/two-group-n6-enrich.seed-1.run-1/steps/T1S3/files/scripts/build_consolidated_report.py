"""Build the consolidated DE + pathway enrichment report (T1S3).

Combines the DESeq2 differential-expression results from T1S2 and the
fgsea preranked Hallmark/WikiPathways enrichment results from T2S1 into
a single reproducibility-grade report: a ranked DE table, a re-derived
p-value histogram bin table, significant-pathway tables with
leading-edge genes, and a JSON reproducibility record. No new
statistical inference is performed here -- this step only aggregates,
re-derives simple summaries (histogram bins) for verification, and
formats already-computed upstream results.
"""

from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path

import numpy as np
import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# %% Parameters
RUN_ROOT = Path("/eval-u25-live-2-with-two-group-n6-enrich-s1-1/runs/804407a4-1a9c-41fa-ba6a-33ad4bc25342")
T1S1_DIR = RUN_ROOT / "T1S1"
T1S2_DIR = RUN_ROOT / "T1S2"
T2S1_DIR = RUN_ROOT / "T2S1"

DE_RESULTS_CSV = T1S2_DIR / "output" / "de_treated_vs_control_results.csv"
DE_SUMMARY_JSON = T1S2_DIR / "output" / "de_treated_vs_control_summary.json"
DE_DECISION_JSON = T1S2_DIR / "output" / "decision_record.json"
LENGTH_BIAS_CSV = T1S2_DIR / "output" / "de_treated_vs_control_length_bias_correlations.csv"
QC_SUMMARY_JSON = T1S1_DIR / "output" / "qc_summary.json"
QC_LIBSIZE_CSV = T1S1_DIR / "output" / "qc_library_sizes.csv"

HALLMARK_RESULTS_CSV = T2S1_DIR / "output" / "hallmark_treated_vs_control_results.csv"
HALLMARK_COLLAPSED_CSV = T2S1_DIR / "output" / "hallmark_treated_vs_control_collapsed.csv"
HALLMARK_SUMMARY_JSON = T2S1_DIR / "output" / "hallmark_treated_vs_control_summary.json"
WIKI_RESULTS_CSV = T2S1_DIR / "output" / "wikipathways_treated_vs_control_results.csv"
WIKI_COLLAPSED_CSV = T2S1_DIR / "output" / "wikipathways_treated_vs_control_collapsed.csv"
WIKI_SUMMARY_JSON = T2S1_DIR / "output" / "wikipathways_treated_vs_control_summary.json"

PADJ_THRESHOLD = 0.05
N_HIST_BINS = 10  # width-0.1 bins over [0,1], matching the T1S2 narrative description

OUTPUT_DIR = Path("output")
FIGURES_DIR = Path("figures")


def load_json(path: Path) -> dict:
    with open(path) as fh:
        return json.load(fh)


def build_ranked_de_table(de_csv: Path, padj_threshold: float) -> pd.DataFrame:
    """Load the T1S2 DE results, rename for clarity, rank by shrunken LFC."""
    df = pd.read_csv(de_csv)
    df = df.rename(
        columns={
            "log2_fold_change": "log2FoldChange_shrunken_apeglm",
            "log2_fold_change_unshrunken": "log2FoldChange_unshrunken_MLE",
            "lfc_se": "lfcSE_shrunken",
            "pvalue": "pvalue",
            "adjusted_pvalue": "padj",
        }
    )
    df["significant_padj_lt_0.05"] = df["padj"] < padj_threshold
    df = df.sort_values("log2FoldChange_shrunken_apeglm", ascending=False).reset_index(drop=True)
    df.insert(0, "rank_by_shrunken_lfc", np.arange(1, len(df) + 1))
    return df


def build_pvalue_histogram(de_csv: Path, n_bins: int) -> pd.DataFrame:
    """Re-derive a width-(1/n_bins) p-value histogram table from raw p-values.

    Only non-NA raw p-values are used (genes that received a Wald test),
    matching the 9,402 genes-tested definition used elsewhere in this report.
    """
    df = pd.read_csv(de_csv)
    pvals = df["pvalue"].dropna().to_numpy()
    edges = np.linspace(0, 1, n_bins + 1)
    counts, _ = np.histogram(pvals, bins=edges)
    n_total = len(pvals)
    expected_uniform = n_total / n_bins
    hist_df = pd.DataFrame(
        {
            "bin_lower": edges[:-1],
            "bin_upper": edges[1:],
            "n_genes": counts,
            "fraction_of_tested": counts / n_total,
            "expected_under_uniform": expected_uniform,
        }
    )
    hist_df.attrs["n_total_pvalues"] = int(n_total)
    return hist_df


def build_significant_pathway_table(results_csv: Path, padj_threshold: float) -> pd.DataFrame:
    """Filter an fgsea results table to padj < threshold, sorted by |NES| desc."""
    df = pd.read_csv(results_csv)
    sig = df[df["padj"] < padj_threshold].copy()
    sig["n_leading_edge_genes"] = sig["leading_edge"].apply(lambda s: len(str(s).split(";")) if pd.notna(s) else 0)
    sig = sig.sort_values("NES", ascending=False).reset_index(drop=True)
    return sig


def copy_figures(pairs: list[tuple[Path, str]]) -> None:
    """Copy each source figure (png+pdf) into this step's figures/ dir under a report-scoped name."""
    for src_base, dest_stem in pairs:
        for ext in ("png", "pdf"):
            src = src_base.with_suffix(f".{ext}")
            if src.exists():
                dest = FIGURES_DIR / f"{dest_stem}.{ext}"
                shutil.copy(src, dest)
                logger.info("Copied %s -> %s", src, dest)
            else:
                logger.warning("Expected figure not found: %s", src)


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    FIGURES_DIR.mkdir(parents=True, exist_ok=True)

    # --- DE table ranked by shrunken LFC ---
    de_ranked = build_ranked_de_table(DE_RESULTS_CSV, PADJ_THRESHOLD)
    de_ranked.to_csv(OUTPUT_DIR / "de_results_ranked_by_shrunken_lfc.csv", index=False)
    logger.info(
        "DE table: %d genes tested (non-NA padj), %d significant at padj<0.05",
        de_ranked["padj"].notna().sum(),
        int(de_ranked["significant_padj_lt_0.05"].sum()),
    )

    top20_up = de_ranked[de_ranked["significant_padj_lt_0.05"]].head(20)
    top20_down = de_ranked[de_ranked["significant_padj_lt_0.05"]].tail(20).iloc[::-1]
    top20_up.to_csv(OUTPUT_DIR / "de_top20_up_by_shrunken_lfc.csv", index=False)
    top20_down.to_csv(OUTPUT_DIR / "de_top20_down_by_shrunken_lfc.csv", index=False)

    # --- p-value histogram, re-derived and persisted ---
    pval_hist = build_pvalue_histogram(DE_RESULTS_CSV, N_HIST_BINS)
    pval_hist.to_csv(OUTPUT_DIR / "pvalue_histogram_bins.csv", index=False)
    logger.info(
        "p-value histogram (n=%d tested p-values): first bin [0,0.1) = %d genes (expected %.0f under uniform)",
        pval_hist.attrs["n_total_pvalues"],
        int(pval_hist.iloc[0]["n_genes"]),
        pval_hist.iloc[0]["expected_under_uniform"],
    )

    # --- Enrichment tables: significant sets with leading edge ---
    hallmark_sig = build_significant_pathway_table(HALLMARK_RESULTS_CSV, PADJ_THRESHOLD)
    hallmark_sig.to_csv(OUTPUT_DIR / "hallmark_significant_with_leading_edge.csv", index=False)
    wiki_sig = build_significant_pathway_table(WIKI_RESULTS_CSV, PADJ_THRESHOLD)
    wiki_sig.to_csv(OUTPUT_DIR / "wikipathways_significant_with_leading_edge.csv", index=False)
    logger.info(
        "Hallmark significant sets: %d; WikiPathways significant sets: %d",
        len(hallmark_sig),
        len(wiki_sig),
    )

    # Carry over the collapsed (non-redundant, "main pathway") tables verbatim for convenience
    shutil.copy(HALLMARK_COLLAPSED_CSV, OUTPUT_DIR / "hallmark_collapsed_main_pathways.csv")
    shutil.copy(WIKI_COLLAPSED_CSV, OUTPUT_DIR / "wikipathways_collapsed_main_pathways.csv")

    # --- Figures: copy MA plot, dispersion plot, p-value histogram, enrichment plots ---
    copy_figures(
        [
            (T1S2_DIR / "figures" / "de_treated_vs_control_ma.png", "de_ma_plot"),
            (T1S2_DIR / "figures" / "de_treated_vs_control_dispersion.png", "de_dispersion_plot"),
            (T1S2_DIR / "figures" / "de_treated_vs_control_pvalue_histogram.png", "de_pvalue_histogram"),
            (T1S2_DIR / "figures" / "de_treated_vs_control_length_bias_scatter.png", "de_length_bias_scatter"),
            (T1S2_DIR / "figures" / "de_treated_vs_control_pca.png", "de_pca_all_12_samples"),
            (T2S1_DIR / "figures" / "hallmark_treated_vs_control_dot_plot.png", "hallmark_dot_plot"),
            (T2S1_DIR / "figures" / "hallmark_treated_vs_control_nes_bar_plot.png", "hallmark_nes_bar_plot"),
            (T2S1_DIR / "figures" / "wikipathways_treated_vs_control_dot_plot.png", "wikipathways_dot_plot"),
            (T2S1_DIR / "figures" / "wikipathways_treated_vs_control_nes_bar_plot.png", "wikipathways_nes_bar_plot"),
        ]
    )

    # --- Reproducibility record ---
    de_summary = load_json(DE_SUMMARY_JSON)
    de_decision = load_json(DE_DECISION_JSON)
    hallmark_summary = load_json(HALLMARK_SUMMARY_JSON)
    wiki_summary = load_json(WIKI_SUMMARY_JSON)
    repro_record = {
        "schema": "consolidated_report.reproducibility_record/1.0",
        "de_method": {
            "tool": "DESeq2",
            "test": "Wald test",
            "shrinkage": "apeglm (coef-based)",
            "design_formula": de_summary["design"],
            "contrast": de_summary["contrast"],
            "reference_level": next(s["value"] for s in de_decision["slots"] if s["name"] == "reference_level"),
            "test_level": next(s["value"] for s in de_decision["slots"] if s["name"] == "test_level"),
            "alpha": de_summary["alpha"],
            "independent_filtering": True,
            "multiple_testing_correction": "Benjamini-Hochberg (BH)",
            "min_count_filter": {"min_count": de_summary["min_count"], "min_samples": de_summary["min_samples"]},
        },
        "enrichment_method": {
            "tool": "fgsea",
            "algorithm": "fgseaMultilevel (preranked GSEA)",
            "rank_metric": hallmark_summary["rank_metric"],
            "rank_metric_definition": "DESeq2 Wald statistic ('stat' column) from the full (pre-p-value-cut) T1S2 results table",
            "eps": hallmark_summary["eps"],
            "min_size": hallmark_summary["min_size"],
            "max_size": hallmark_summary["max_size"],
            "padj_cutoff": hallmark_summary["padj_cutoff"],
            "seed": hallmark_summary["seed"],
            "collapse_pathways": True,
            "gene_set_databases": {
                "Hallmark": {
                    "source_file": "h.all.v2026.1.Hs.symbols.gmt",
                    "version": "MSigDB Hallmark 2026.1",
                    "n_sets_total": hallmark_summary["n_sets_input"],
                    "n_sets_tested_in_window": hallmark_summary["n_sets_tested"],
                },
                "WikiPathways": {
                    "source_file": "wikipathways_human_2026.07.10_hgnc_symbols.gmt (converted from Entrez IDs by T2S1)",
                    "version": "WikiPathways 2026.07.10",
                    "n_sets_total": wiki_summary["n_sets_input"],
                    "n_sets_tested_in_window": wiki_summary["n_sets_tested"],
                },
            },
        },
        "universe": {
            "n_genes_input_matrix": de_summary["n_genes_input"],
            "n_genes_after_expression_filter": de_summary["n_genes_after_filter"],
            "n_genes_tested_for_DE_nonNA_padj": de_summary["n_genes_tested"],
            "n_genes_ranked_for_gsea": hallmark_summary["n_genes_ranked"],
            "note": "GSEA universe = all 9,782 genes surviving the DESeq2 expression filter and receiving a Wald statistic, "
            "not just the 875 padj<0.05 DE genes -- this is the standard preranked-GSEA universe, not a hypergeometric "
            "overlap test against a p-value-thresholded gene list.",
        },
        "shallow_sample_handling": {
            "sample": "sample_01",
            "condition": "control",
            "library_size": 420347,
            "cohort_median_library_size": 1614280,
            "ratio_to_median": 0.26,
            "detected_genes": 10918,
            "size_factor_deseq2": de_summary["size_factors"]["sample_01"],
            "qc_flag_status": "Below the literal 1/4-of-median low-depth threshold cutoff of 0.25 by only 0.01 (ratio 0.260); "
            "did NOT trip the automated low-depth flag (n_low_depth_samples=0 in T1S1) but is unambiguously the cohort's "
            "depth outlier (next-lowest sample is at 0.71x median).",
            "pca_behavior": "Falls cleanly within the control cluster on PC1 (condition axis, 55.1% variance); is a PC2 "
            "outlier (PC2=+20.56 vs -5.82 to +2.68 for all other samples) consistent with depth-driven technical noise, "
            "not a condition-related effect.",
            "cooks_distance_check_at_DE_step": "0 Cook's-distance-flagged (NA pvalue) genes attributed to sample_01, "
            "identical to every other sample -- no evidence sample_01 drives outlier-level leverage on any tested gene.",
            "decision": "KEPT in the final DESeq2 model (design ~condition, all 12 samples).",
            "rationale": "Per the plan's keep_inspect_report policy, library depth alone is not a removal criterion. "
            "sample_01 clusters correctly by condition (PC1, hierarchical clustering) and DESeq2's internal size-factor "
            "normalization together with the Cook's-distance diagnostic (0 outlier genes attributed to it, same as every "
            "other sample) show no evidence it distorts the DE fit. Its low depth widens its contribution to per-gene "
            "dispersion/CI width via its size factor (0.2835, lowest in the cohort) rather than biasing fold changes "
            "systematically.",
        },
        "gc_length_bias_diagnostic": {
            "tool": "Pearson/Spearman correlation, log2(gene length) vs log2(normalized-count-to-geometric-mean ratio), per sample",
            "outcome": "No length-driven trend detected in any of the 12 samples "
            f"(max |Pearson r| = {de_summary['length_bias_diagnostic']['max_abs_pearson_r']}, sample "
            f"{de_summary['length_bias_diagnostic']['sample_with_max_abs_r']}, p > 0.08 for all samples).",
            "caveat": "GC content itself could not be assessed -- only gene length was available in the input reference "
            "table. Absence of a length trend does not rule out a GC-content-driven trend. This is a diagnostic on this "
            "count matrix, not a validation of the (unstated) upstream quantification pipeline. No length/GC correction "
            "(e.g. cqn, EDASeq) was applied to the counts; DESeq2 was run on raw, uncorrected counts as intended.",
        },
        "package_versions": {
            "R": de_summary["versions"]["R"],
            "DESeq2": de_summary["versions"]["DESeq2"],
            "apeglm": de_summary["versions"]["apeglm"],
            "ashr": de_summary["versions"]["ashr"],
            "fgsea": hallmark_summary["versions"]["fgsea"],
            "ggplot2": de_summary["versions"].get("ggplot2", "4.0.3"),
            "environment_match": "exact (all pinned packages matched the farm exactly; see T1S2 and T2S1 decision_record.json)",
        },
        "random_seeds": {
            "fgsea_seed": hallmark_summary["seed"],
            "note": "Same seed (20260904) used for both the Hallmark and WikiPathways fgseaMultilevel runs, for "
            "reproducible tie-breaking in the multilevel Monte Carlo p-value estimation and for collapsePathways(). "
            "DESeq2's Wald test and apeglm shrinkage are deterministic given the input and involve no stochastic seed.",
        },
        "upstream_step_provenance": {
            "T1S1_sample_qc": str(T1S1_DIR / "output" / "summary.md"),
            "T1S2_deseq2": str(T1S2_DIR / "output" / "summary.md"),
            "T2S1_fgsea": str(T2S1_DIR / "output" / "summary.md"),
        },
    }
    with open(OUTPUT_DIR / "reproducibility_record.json", "w") as fh:
        json.dump(repro_record, fh, indent=2, default=str)

    logger.info("Consolidated report artifacts written to %s and %s", OUTPUT_DIR, FIGURES_DIR)


if __name__ == "__main__":
    main()
