# /// script
# dependencies = ["pandas"]
# [tool.uv]
# exclude-newer = "2026-09-25T00:00:00Z"
# ///
"""Build derived/cancer_mut/upset_membership.csv from the maftools tcga_laml
example MAF (TCGA LAML, Ley et al. NEJM 2013).

Usage: uv run upset_cancer_mut.py <gallery-data work dir>

Reads raw/cancer_mut/tcga_laml.maf.gz (the same raw input tcga_laml.py
reads). Ranks genes by the number of distinct samples carrying at least one
non-silent mutation (maftools' own default non-synonymous
Variant_Classification set: Frame_Shift_Del, Frame_Shift_Ins, In_Frame_Del,
In_Frame_Ins, Missense_Mutation, Nonsense_Mutation, Nonstop_Mutation,
Splice_Site, Translation_Start_Site -- Silent, RNA, Intron, IGR, and
3'/5'Flank/UTR are not counted), independently of oncoprint.csv's top-20
ranking in tcga_laml.py, which ranks on all Variant_Classification values
including Silent. Deterministic: no random sampling; a gene-rank tie breaks
alphabetically by Hugo_Symbol, matching tcga_laml.py's own tie-break rule.
"""

import pathlib
import sys

import pandas as pd

BASE = pathlib.Path(sys.argv[1])
RAW = BASE / "raw" / "cancer_mut"
DERIVED = BASE / "derived" / "cancer_mut"
DERIVED.mkdir(parents=True, exist_ok=True)

MAF_PATH = RAW / "tcga_laml.maf.gz"
TOP_N_GENES = 6

# maftools' default "nonSyn" Variant_Classification set (used by oncoplot,
# mafSummary, and mutation-burden-by-default across the package).
NON_SILENT_CLASSES = {
    "Frame_Shift_Del",
    "Frame_Shift_Ins",
    "In_Frame_Del",
    "In_Frame_Ins",
    "Missense_Mutation",
    "Nonsense_Mutation",
    "Nonstop_Mutation",
    "Splice_Site",
    "Translation_Start_Site",
}


def main() -> None:
    import gzip

    with gzip.open(MAF_PATH, "rt") as fh:
        maf = pd.read_csv(fh, sep="\t", dtype=str)

    cohort_size = maf["Tumor_Sample_Barcode"].nunique()

    non_silent = maf[maf["Variant_Classification"].isin(NON_SILENT_CLASSES)]

    gene_sample_sets = non_silent.groupby("Hugo_Symbol")["Tumor_Sample_Barcode"].agg(set)
    ranked_genes = sorted(gene_sample_sets.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    top_genes = [g for g, _ in ranked_genes[:TOP_N_GENES]]

    rows = []
    for gene, samples in ranked_genes[:TOP_N_GENES]:
        for sample in sorted(samples):
            rows.append({"sample": sample, "gene": gene})
    # Row order: gene rank (most-mutated first), then sample barcode.
    gene_rank = {g: i for i, g in enumerate(top_genes)}
    membership = (
        pd.DataFrame(rows, columns=["sample", "gene"])
        .assign(_gene_rank=lambda d: d["gene"].map(gene_rank))
        .sort_values(["_gene_rank", "sample"])
        .drop(columns="_gene_rank")
        .reset_index(drop=True)
    )

    out_path = DERIVED / "upset_membership.csv"
    membership.to_csv(out_path, index=False)

    members_in_top6 = membership["sample"].nunique()
    print(f"cohort_size (all samples in the MAF): {cohort_size}")
    print(f"top_{TOP_N_GENES}_genes_by_nonsilent_mutated_samples: {top_genes}")
    for gene, samples in ranked_genes[:TOP_N_GENES]:
        print(f"  {gene}: {len(samples)} samples")
    print(f"upset_membership.csv: {len(membership)} rows, {members_in_top6} distinct samples with >=1 membership")
    print(f"bytes: {out_path.stat().st_size}")


if __name__ == "__main__":
    main()
