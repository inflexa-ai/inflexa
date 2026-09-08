"""Prepare ranked gene lists for fgsea preranked GSEA.

Builds two versions of the DESeq2 treated-vs-control results table required by
the tpl-fgsea-preranked template (columns: gene, stat, pvalue, adjusted_pvalue,
log2_fold_change):

1. `ranked_genes_symbol.csv` — gene identifier is the HGNC symbol where T1S6
   mapped the input ID to a real symbol via org.Hs.eg.db, otherwise the
   original placeholder ID (GENE#####) is kept as-is (it will not match any
   pathway gene set, which is the correct behaviour for a synthetic ID).
   Used for MSigDB Hallmark and Reactome (both symbol-keyed GMTs).
2. `ranked_genes_entrez.csv` — gene identifier is the Entrez Gene ID for
   mapped genes (placeholder IDs kept as-is). Used for WikiPathways, whose
   staged GMT is keyed by Entrez Gene ID (verified by direct inspection),
   not HGNC symbol as its catalog description states.

"Genes tested in T1S2" is taken as the 9,402 genes that survived DESeq2's
independent filtering (non-NA adjusted_pvalue / na_reason), matching the
n_genes_tested figure T1S2 itself reports -- not the 9,782 genes that merely
passed the pre-filter. All 9,402 have a defined Wald `stat`.
"""

import logging

import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

T1S2_RESULTS = (
    "/eval-u25-live-3-with-two-group-n6-enrich-s1-1/runs/"
    "ccf89a64-e0e3-459a-bf3a-a1a6ceade281/T1S2/output/de_treated_vs_control_results.csv"
)
T1S6_MAPPING = (
    "/eval-u25-live-3-with-two-group-n6-enrich-s1-1/runs/"
    "ccf89a64-e0e3-459a-bf3a-a1a6ceade281/T1S6/output/annotation_mapping.csv"
)

OUT_SYMBOL = "output/ranked_genes_symbol.csv"
OUT_ENTREZ = "output/ranked_genes_entrez.csv"
OUT_JOIN_QC = "output/gene_mapping_join_qc.json"


def load_tested_genes(path: str) -> pd.DataFrame:
    """Load T1S2 DE results and restrict to the 9,402 genes DESeq2 tested."""
    df = pd.read_csv(path)
    n_total = len(df)
    tested = df[df["na_reason"].isna()].copy()
    logger.info("Loaded %d DE rows; %d survived independent filtering (tested)", n_total, len(tested))
    return tested


def join_mapping(tested: pd.DataFrame, mapping_path: str) -> pd.DataFrame:
    """Join T1S6's gene-identifier mapping onto the tested DE genes."""
    mapping = pd.read_csv(mapping_path)
    merged = tested.merge(mapping, left_on="gene", right_on="input_id", how="left", validate="one_to_one")
    n_missing_join = merged["input_id"].isna().sum()
    if n_missing_join:
        raise ValueError(f"{n_missing_join} T1S2 genes had no row in the T1S6 mapping table")
    return merged


def build_symbol_ranked_list(merged: pd.DataFrame) -> pd.DataFrame:
    gene_id = merged["symbol"].where(merged["mapped"], merged["gene"])
    out = pd.DataFrame(
        {
            "gene": gene_id,
            "stat": merged["stat"],
            "pvalue": merged["pvalue"],
            "adjusted_pvalue": merged["adjusted_pvalue"],
            "log2_fold_change": merged["log2_fold_change"],
        }
    )
    n_dup = out["gene"].duplicated().sum()
    if n_dup:
        raise ValueError(f"{n_dup} duplicate gene identifiers in symbol-keyed ranked list")
    return out.sort_values("stat", ascending=False).reset_index(drop=True)


def build_entrez_ranked_list(merged: pd.DataFrame) -> pd.DataFrame:
    entrez_str = merged["entrez_id"].apply(lambda v: str(int(v)) if pd.notna(v) else None)
    gene_id = entrez_str.where(merged["mapped"], merged["gene"])
    out = pd.DataFrame(
        {
            "gene": gene_id,
            "stat": merged["stat"],
            "pvalue": merged["pvalue"],
            "adjusted_pvalue": merged["adjusted_pvalue"],
            "log2_fold_change": merged["log2_fold_change"],
        }
    )
    n_dup = out["gene"].duplicated().sum()
    if n_dup:
        raise ValueError(f"{n_dup} duplicate gene identifiers in entrez-keyed ranked list")
    return out.sort_values("stat", ascending=False).reset_index(drop=True)


def main() -> None:
    tested = load_tested_genes(T1S2_RESULTS)
    merged = join_mapping(tested, T1S6_MAPPING)

    n_mapped = int(merged["mapped"].sum())
    n_unmapped = len(merged) - n_mapped
    logger.info(
        "Of %d tested genes, %d (%.2f%%) map to a real symbol/Entrez ID; %d are synthetic placeholders",
        len(merged), n_mapped, 100 * n_mapped / len(merged), n_unmapped,
    )

    symbol_df = build_symbol_ranked_list(merged)
    entrez_df = build_entrez_ranked_list(merged)

    symbol_df.to_csv(OUT_SYMBOL, index=False)
    entrez_df.to_csv(OUT_ENTREZ, index=False)

    qc = {
        "n_tested_genes_T1S2": len(tested),
        "n_mapped_to_real_identifier": n_mapped,
        "n_unmapped_placeholder": n_unmapped,
        "mapped_share": n_mapped / len(merged),
        "n_duplicate_symbol_ids": int(symbol_df["gene"].duplicated().sum()),
        "n_duplicate_entrez_ids": int(entrez_df["gene"].duplicated().sum()),
        "notes": (
            "gene column in symbol-keyed list is the T1S6-mapped HGNC symbol for "
            "mapped genes, else the original GENE##### placeholder ID (guaranteed "
            "not to match any real pathway gene set). entrez-keyed list is the "
            "same but with the T1S6-mapped Entrez Gene ID as string, for use "
            "against the Entrez-keyed WikiPathways GMT."
        ),
    }
    import json

    with open(OUT_JOIN_QC, "w") as fh:
        json.dump(qc, fh, indent=2)
    logger.info("Wrote %s (%d genes), %s (%d genes), %s", OUT_SYMBOL, len(symbol_df), OUT_ENTREZ, len(entrez_df), OUT_JOIN_QC)


if __name__ == "__main__":
    main()
