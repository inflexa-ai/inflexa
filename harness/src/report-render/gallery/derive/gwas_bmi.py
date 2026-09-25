# /// script
# requires-python = ">=3.11"
# dependencies = ["pandas>=2.0", "numpy>=1.24", "scipy>=1.11"]
# [tool.uv]
# exclude-newer = "2026-09-25T00:00:00Z"
# ///
"""
Build GWAS chart-gallery tables from the Locke et al. 2015 BMI GIANT
consortium GWAS (GWAS Catalog GCST002783, harmonised summary statistics).

Usage: uv run gwas_bmi.py <gallery-data work dir>

Reads raw/gwas/25673413-GCST002783-EFO_0004340.h.tsv.gz (streamed in chunks)
and writes derived/gwas/manhattan.csv, derived/gwas/qq.csv,
derived/gwas/lead_snps.csv. Prints a JSON summary of row counts, byte sizes,
and derived statistics (thinning counts, genomic inflation lambda, clump
counts) to stdout for the manifest fragment.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

SEED = 20150212  # publication date of Locke et al. 2015 (Nature), fixed for reproducibility
THIN_P_THRESHOLD = 1e-3
# qq.csv carries 4 numeric columns (expected/observed -log10(p) plus a 95%
# Beta order-statistic confidence band); a 2% bulk sample landed at
# 1,993,992 bytes, 6 KB under the 2 MB cap and too close to trust across
# reruns or minor float-formatting differences, so the rate is reduced to
# give real headroom.
QQ_BULK_FRACTION = 0.015
# manhattan.csv has 100x the row count of qq.csv (one row per SNP with 7 columns
# vs. one row per SNP with 2 columns), so a 2% bulk sample breaches the 2 MB cap.
# Calibrated so kept_small + sampled_bulk lands near, but under, the 2 MB limit.
MANHATTAN_BULK_FRACTION = 0.0055
GENOME_WIDE_SIGNIFICANCE = 5e-8
CLUMP_WINDOW_BP = 1_000_000
CHROM_ORDER = [str(i) for i in range(1, 23)] + ["X"]

BASE = Path(sys.argv[1])
RAW_FILE = BASE / "raw" / "gwas" / "25673413-GCST002783-EFO_0004340.h.tsv.gz"
OUT_DIR = BASE / "derived" / "gwas"
OUT_DIR.mkdir(parents=True, exist_ok=True)

USE_COLS = ["hm_rsid", "hm_chrom", "hm_pos", "hm_beta", "hm_odds_ratio", "standard_error", "p_value"]


def load_full() -> pd.DataFrame:
    """Stream the gzipped TSV in chunks and concatenate only the columns needed."""
    chunks = []
    for chunk in pd.read_csv(
        RAW_FILE,
        sep="\t",
        usecols=USE_COLS,
        chunksize=250_000,
        dtype={"hm_chrom": str},
        na_values="NA",
        compression="gzip",
    ):
        chunks.append(chunk)
    df = pd.concat(chunks, ignore_index=True)
    del chunks
    return df


def thin(
    df: pd.DataFrame, pval_col: str, bulk_fraction: float, rng: np.random.Generator
) -> tuple[pd.DataFrame, int, int]:
    """Keep all rows with p < THIN_P_THRESHOLD, plus a seeded bulk_fraction sample of the rest."""
    small_p_mask = df[pval_col] < THIN_P_THRESHOLD
    kept_small = df[small_p_mask]
    bulk = df[~small_p_mask]
    sample_idx = rng.random(len(bulk)) < bulk_fraction
    kept_bulk = bulk[sample_idx]
    out = pd.concat([kept_small, kept_bulk], ignore_index=True)
    return out, len(kept_small), len(kept_bulk)


def main() -> None:
    summary: dict = {}
    rng = np.random.default_rng(SEED)

    df = load_full()
    total_rows = len(df)
    summary["total_rows_in_file"] = total_rows

    # ---------------------------------------------------------------
    # QQ plot: uses ALL rows with a usable p-value, no chrom/beta filter.
    # ---------------------------------------------------------------
    pvals_all = df["p_value"].dropna().to_numpy(dtype=float)
    pvals_all = pvals_all[(pvals_all > 0) & (pvals_all <= 1)]
    n_p_dropped = total_rows - len(pvals_all)
    n_p = len(pvals_all)

    # genomic inflation factor lambda, computed on the FULL untinned p-value set
    chisq_all = stats.chi2.isf(pvals_all, df=1)
    lambda_gc = float(np.median(chisq_all) / stats.chi2.ppf(0.5, df=1))
    summary["n_pvalues_used_for_qq_and_lambda"] = n_p
    summary["n_pvalues_dropped_na_or_out_of_range"] = int(n_p_dropped)
    summary["lambda_gc"] = lambda_gc
    # The inflation factor rides a one-row table, thus a figure binds it as a cell of a real artifact.
    qq_summary_path = OUT_DIR / "qq_summary.csv"
    pd.DataFrame({"lambda_gc": [lambda_gc], "n_pvalues": [n_p]}).to_csv(qq_summary_path, index=False, float_format="%.6g")
    summary["qq_summary"] = {"rows_written": 1, "bytes": qq_summary_path.stat().st_size}

    pvals_sorted = np.sort(pvals_all)
    ranks = np.arange(1, n_p + 1)
    expected_neg_log10_p = -np.log10(ranks / (n_p + 1))
    observed_neg_log10_p = -np.log10(pvals_sorted)

    # 95% confidence band of the expected -log10(p) under the null: the i-th
    # order statistic of n uniform(0,1) draws follows Beta(i, n-i+1). The
    # p-value quantiles flip sign under -log10, so the 0.975 p-value quantile
    # gives the lower -log10 bound and the 0.025 quantile gives the upper one.
    beta_b = n_p - ranks + 1
    ci_lower = -np.log10(stats.beta.ppf(0.975, ranks, beta_b))
    ci_upper = -np.log10(stats.beta.ppf(0.025, ranks, beta_b))

    qq_full = pd.DataFrame(
        {
            # rounded to 4 decimal places: -log10(p) needs nowhere near float64's
            # 17 significant digits for a chart, and the source p-values already
            # carry far less precision than that. 4 decimals (not 6) because the
            # qq table gained two more numeric columns (ci_lower, ci_upper) and
            # needed the extra headroom to stay under the 2 MB cap at the same
            # 2% bulk sample rate as before.
            "expected_neg_log10_p": np.round(expected_neg_log10_p, 4),
            "observed_neg_log10_p": np.round(observed_neg_log10_p, 4),
            "ci_lower": np.round(ci_lower, 4),
            "ci_upper": np.round(ci_upper, 4),
            "_pvalue": pvals_sorted,  # used only to apply the thinning rule, dropped before write
        }
    )
    qq_thinned, qq_kept_small, qq_kept_bulk_sampled = thin(qq_full, "_pvalue", QQ_BULK_FRACTION, rng)
    qq_dropped_bulk = len(qq_full) - qq_kept_small - qq_kept_bulk_sampled
    qq_out = qq_thinned.drop(columns=["_pvalue"]).sort_values("expected_neg_log10_p").reset_index(drop=True)
    qq_path = OUT_DIR / "qq.csv"
    qq_out.to_csv(qq_path, index=False)
    summary["qq"] = {
        "rows_written": len(qq_out),
        "bytes": qq_path.stat().st_size,
        "kept_full_p_lt_1e-3": qq_kept_small,
        "bulk_total_p_ge_1e-3": len(qq_full) - qq_kept_small,
        "bulk_sampled_p_ge_1e-3": qq_kept_bulk_sampled,
        "bulk_dropped_p_ge_1e-3": qq_dropped_bulk,
    }

    # ---------------------------------------------------------------
    # Rows usable for beta-requiring tables (manhattan, lead_snps):
    # valid chromosome (1-22 or X) and a harmonised beta.
    # ---------------------------------------------------------------
    valid_chrom_mask = df["hm_chrom"].isin(CHROM_ORDER)
    n_dropped_bad_chrom = int((~valid_chrom_mask).sum())  # NA chrom, MT, or other non-1-22/X values

    beta_df = df[valid_chrom_mask].copy()
    has_beta = beta_df["hm_beta"].notna()
    has_or_only = has_beta.eq(False) & beta_df["hm_odds_ratio"].notna()
    n_or_fallback = int(has_or_only.sum())
    if n_or_fallback:
        # This dataset reports betas directly; fall back to ln(OR) only if a row needs it.
        beta_df.loc[has_or_only, "hm_beta"] = np.log(beta_df.loc[has_or_only, "hm_odds_ratio"])
        has_beta = has_beta | has_or_only

    n_dropped_no_beta = int((~has_beta).sum())
    beta_df = beta_df[has_beta].copy()
    beta_df = beta_df.rename(
        columns={
            "hm_rsid": "snp",
            "hm_chrom": "chrom",
            "hm_pos": "pos",
            "hm_beta": "beta",
            "standard_error": "se",
            "p_value": "pvalue",
        }
    )[["chrom", "pos", "snp", "pvalue", "beta", "se"]]
    beta_df["pos"] = beta_df["pos"].astype(np.int64)

    summary["rows_dropped_invalid_chrom"] = n_dropped_bad_chrom
    summary["rows_dropped_no_usable_beta_or_or"] = n_dropped_no_beta
    summary["rows_or_to_beta_fallback"] = n_or_fallback
    summary["rows_usable_for_beta_tables"] = len(beta_df)

    # ---------------------------------------------------------------
    # Cumulative genome position: chromosomes 1..22 then X, offset by the
    # max pos of all prior chromosomes (in that order).
    # ---------------------------------------------------------------
    max_pos_per_chrom = beta_df.groupby("chrom")["pos"].max()
    chroms_present = [c for c in CHROM_ORDER if c in max_pos_per_chrom.index]
    offsets = {}
    running = 0
    for c in chroms_present:
        offsets[c] = running
        running += int(max_pos_per_chrom[c])
    beta_df["cum_pos"] = beta_df["pos"] + beta_df["chrom"].map(offsets)
    summary["chroms_present"] = chroms_present

    # ---------------------------------------------------------------
    # Manhattan: thin the beta-usable rows.
    # ---------------------------------------------------------------
    man_thinned, man_kept_small, man_kept_bulk_sampled = thin(
        beta_df, "pvalue", MANHATTAN_BULK_FRACTION, rng
    )
    man_dropped_bulk = len(beta_df) - man_kept_small - man_kept_bulk_sampled
    man_out = man_thinned[["chrom", "pos", "snp", "pvalue", "beta", "se", "cum_pos"]].sort_values(
        ["cum_pos"]
    ).reset_index(drop=True)
    man_path = OUT_DIR / "manhattan.csv"
    # %.6g avoids pandas' default float formatter surfacing float64 round-trip
    # noise (e.g. 2.287e-40 rendered as 2.2869999999999998e-40); the source
    # file never carries more than 4-6 significant figures for these columns.
    man_out.to_csv(man_path, index=False, float_format="%.6g")
    summary["manhattan"] = {
        "rows_written": len(man_out),
        "bytes": man_path.stat().st_size,
        "kept_full_p_lt_1e-3": man_kept_small,
        "bulk_total_p_ge_1e-3": len(beta_df) - man_kept_small,
        "bulk_sampled_p_ge_1e-3": man_kept_bulk_sampled,
        "bulk_dropped_p_ge_1e-3": man_dropped_bulk,
    }

    # ---------------------------------------------------------------
    # Lead SNPs: p < 5e-8, clumped within 1 Mb on the same chromosome,
    # one lead (smallest-p) variant kept per locus. No gene annotation
    # column exists in the source file, so nearest_gene is left empty.
    # ---------------------------------------------------------------
    sig = beta_df[beta_df["pvalue"] < GENOME_WIDE_SIGNIFICANCE].copy()
    sig["chrom_order"] = sig["chrom"].map({c: i for i, c in enumerate(CHROM_ORDER)})
    sig = sig.sort_values(["chrom_order", "pos"]).reset_index(drop=True)

    locus_ids = []
    current_locus = -1
    current_chrom = None
    locus_max_pos = -1
    for _, row in sig.iterrows():
        if row["chrom"] != current_chrom or row["pos"] - locus_max_pos > CLUMP_WINDOW_BP:
            current_locus += 1
            current_chrom = row["chrom"]
            locus_max_pos = row["pos"]
        else:
            locus_max_pos = max(locus_max_pos, row["pos"])
        locus_ids.append(current_locus)
    sig["locus_id"] = locus_ids

    n_loci = sig["locus_id"].nunique()
    lead_idx = sig.groupby("locus_id")["pvalue"].idxmin()
    lead = sig.loc[lead_idx].sort_values(["chrom_order", "pos"]).copy()
    lead["nearest_gene"] = ""  # source file has no gene annotation column
    lead_out = lead[["chrom", "pos", "snp", "pvalue", "beta", "nearest_gene"]].reset_index(drop=True)
    lead_path = OUT_DIR / "lead_snps.csv"
    lead_out.to_csv(lead_path, index=False, float_format="%.6g")
    summary["lead_snps"] = {
        "rows_written": len(lead_out),
        "bytes": lead_path.stat().st_size,
        "n_variants_p_lt_5e-8": len(sig),
        "n_loci_after_clumping": int(n_loci),
    }

    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
