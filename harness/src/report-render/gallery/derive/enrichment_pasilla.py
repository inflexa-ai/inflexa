# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "pandas",
#   "numpy",
#   "scipy",
#   "gseapy",
# ]
# ///
"""GO Biological Process enrichment for the pasilla DE results.

Input: derived/bulk_rnaseq/de_results.csv (written by bulk_rnaseq_pasilla.py).
Gene sets: GO_Biological_Process_2018, Drosophila melanogaster, fetched with
gseapy.get_library(name="GO_Biological_Process_2018", organism="Fly"), which
pulls from the FlyEnrichr gene-set-library API
(https://maayanlab.cloud/FlyEnrichr/geneSetLibrary). GO_Biological_Process_2018
is the newest GO BP library FlyEnrichr hosts (its human Enrichr mirror has a
newer 2023 edition, but that one is human-only).

Two tests are run on the same gene universe:
  1. gseapy.prerank (GSEA) on the DESeq2 Wald `stat` column.
  2. A hypergeometric over-representation test (scipy.stats.hypergeom),
     computed by hand, on the padj<0.05 gene set vs. the same background.

Fixed seed (0) makes the GSEA permutation p-values reproducible run to run.
"""

import numpy as np
import pandas as pd
from scipy.stats import hypergeom

import gseapy

np.random.seed(0)

DE_RESULTS_PATH = "gallery-data/derived/bulk_rnaseq/de_results.csv"
OUT_DIR = "gallery-data/derived/enrichment"

GENE_SET_LIBRARY = "GO_Biological_Process_2018"
ORGANISM = "Fly"
GSEA_MIN_SIZE = 15
GSEA_MAX_SIZE = 500
GSEA_PERM_NUM = 1000  # gseapy's own default permutation count
ORA_MIN_OVERLAP_WITH_BACKGROUND = 3  # minimum term-vs-background overlap to test
PADJ_SIG_THRESHOLD = 0.05


def build_ranking(de):
    """gene_symbol -> DESeq2 Wald `stat`, one row per gene.

    Genes with no FlyBase->symbol mapping (empty gene_symbol -> NaN on
    read_csv) are dropped: a GO gene set is indexed by symbol, so an
    unmapped gene cannot be scored against it. Where more than one FBgn ID
    maps to the same symbol (215 rows / ~89 symbols; see
    bulk_rnaseq_pasilla.py), keep the row with the larger |stat| -- the
    more decisive signal for that symbol -- and drop the rest.
    """
    mapped = de.dropna(subset=["gene_symbol"]).copy()
    mapped["abs_stat"] = mapped["stat"].abs()
    mapped = mapped.sort_values("abs_stat", ascending=False).drop_duplicates(
        "gene_symbol", keep="first"
    )
    return mapped.set_index("gene_symbol")["stat"].sort_values(ascending=False), mapped


def run_gsea(rnk, gene_sets):
    pre = gseapy.prerank(
        rnk=rnk,
        gene_sets=gene_sets,
        min_size=GSEA_MIN_SIZE,
        max_size=GSEA_MAX_SIZE,
        permutation_num=GSEA_PERM_NUM,
        seed=0,
        threads=8,
        no_plot=True,
        outdir=None,
    )
    return pre


def build_gsea_results(pre):
    rows = []
    for _, row in pre.res2d.iterrows():
        term = row["Term"]
        rec = pre.results[term]
        lead_genes = row["Lead_genes"]
        lead_list = [g for g in lead_genes.split(";") if g]
        rows.append(
            {
                "term": term,
                "NES": row["NES"],
                "ES": row["ES"],
                "pvalue": row["NOM p-val"],
                "fdr": row["FDR q-val"],
                "set_size": len([g for g in str(rec["matched_genes"]).split(";") if g]),
                "leading_edge_size": len(lead_list),
                "leading_edge_genes": lead_genes,
            }
        )
    return pd.DataFrame(rows)


def build_running_score(pre, gsea_df, top_n=3):
    top_terms = gsea_df.reindex(gsea_df["NES"].abs().sort_values(ascending=False).index).head(
        top_n
    )
    ranking = pre.ranking  # Series, gene_symbol -> stat, in ranked order
    ranked_metric = ranking.to_numpy()
    rows = []
    for term in top_terms["term"]:
        rec = pre.results[term]
        res_curve = np.asarray(rec["RES"])
        hit_idx = set(rec["hits"])
        for i, es_val in enumerate(res_curve):
            rows.append(
                {
                    "term": term,
                    "rank": i + 1,
                    # Rounded to 6 significant decimals: keeps the CSV under the
                    # 2 MB gallery-data cap without a visible effect on a plotted
                    # running-score curve (full double precision was ~2.49 MB for
                    # 3 terms x ~9790 ranks).
                    "running_es": round(float(es_val), 6),
                    "hit": 1 if i in hit_idx else 0,
                    "ranked_metric": round(float(ranked_metric[i]), 6),
                }
            )
    return pd.DataFrame(rows)


def bh_fdr(pvalues):
    p = np.asarray(pvalues, dtype=float)
    n = len(p)
    order = np.argsort(p)
    ranked = p[order]
    fdr = ranked * n / (np.arange(n) + 1)
    fdr = np.minimum.accumulate(fdr[::-1])[::-1]
    fdr = np.clip(fdr, 0, 1)
    out = np.empty(n)
    out[order] = fdr
    return out


def run_ora(background_symbols, sig_symbols, gene_sets):
    M = len(background_symbols)
    N = len(sig_symbols)
    background_set = set(background_symbols)
    sig_set = set(sig_symbols)

    tested = []
    for term, genes in gene_sets.items():
        term_in_bg = background_set & set(genes)
        n = len(term_in_bg)
        if n < ORA_MIN_OVERLAP_WITH_BACKGROUND:
            continue
        overlap_genes = term_in_bg & sig_set
        k = len(overlap_genes)
        pval = hypergeom.sf(k - 1, M, n, N)
        tested.append(
            {
                "term": term,
                "overlap": k,
                "set_size": n,
                "gene_ratio": k / N if N else np.nan,
                "background_ratio": n / M if M else np.nan,
                "pvalue": pval,
                "genes": ";".join(sorted(overlap_genes)),
            }
        )
    tested_df = pd.DataFrame(tested)
    tested_df["padj"] = bh_fdr(tested_df["pvalue"])
    reported = tested_df[tested_df["overlap"] >= 1].sort_values("pvalue").copy()
    reported = reported[
        ["term", "overlap", "set_size", "gene_ratio", "background_ratio", "pvalue", "padj", "genes"]
    ]
    return reported, len(tested_df)


def main():
    de = pd.read_csv(DE_RESULTS_PATH)
    rnk, mapped = build_ranking(de)

    gene_sets = gseapy.get_library(name=GENE_SET_LIBRARY, organism=ORGANISM)

    pre = run_gsea(rnk, gene_sets)
    gsea_df = build_gsea_results(pre)
    gsea_df.to_csv(f"{OUT_DIR}/gsea_results.csv", index=False)

    running_df = build_running_score(pre, gsea_df, top_n=3)
    running_df.to_csv(f"{OUT_DIR}/gsea_running_score.csv", index=False)

    # Background = the same one-row-per-symbol gene universe used for the GSEA
    # ranking (mapped, deduplicated FBgn->symbol; see build_ranking docstring).
    background_symbols = pd.Index(rnk.index).unique()
    sig_mask = de["gene_symbol"].notna() & de["padj"].notna() & (de["padj"] < PADJ_SIG_THRESHOLD)
    sig_symbols = pd.Index(de.loc[sig_mask, "gene_symbol"]).intersection(background_symbols).unique()

    ora_df, n_tested_terms = run_ora(background_symbols, sig_symbols, gene_sets)
    ora_df.to_csv(f"{OUT_DIR}/ora_results.csv", index=False)

    print(f"GSEA: {len(gsea_df)} terms tested, ranking length {len(rnk)}")
    print(f"ORA: background {len(background_symbols)}, significant {len(sig_symbols)}, "
          f"{n_tested_terms} terms tested (>= {ORA_MIN_OVERLAP_WITH_BACKGROUND} bg overlap), "
          f"{len(ora_df)} terms reported (overlap >= 1)")


if __name__ == "__main__":
    main()
