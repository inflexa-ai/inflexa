"""Per-pathway gene-set coverage given the dataset's synthetic-placeholder load.

For every pathway in each of the three collections, reports:
  - nominal_size: total member count in the GMT as published
  - tested_overlap_size: members present among the 9,402 T1S2-tested genes
    (this is exactly fgsea's `size` column, since placeholder IDs cannot
    coincide with a real HGNC symbol or Entrez ID)
  - coverage_fraction: tested_overlap_size / nominal_size

fgsea's minSize/maxSize window is applied to tested_overlap_size, not
nominal_size, so a pathway can be dropped from testing even though its
nominal size is within [15, 500] if too many of its members are simply
absent from this dataset (12,000 genes total, ~63% synthetic placeholders,
and the array only covers ~9,400 of those in the tested set).
"""

import logging

import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

COLLECTIONS = {
    "hallmark": {
        "gmt": "/mnt/refs/managed/msigdb-hallmark-human/2026.1/h.all.v2026.1.Hs.symbols.gmt",
        "fgsea_results": "output/hallmark_results.csv",
        "ranked_genes": "output/ranked_genes_symbol.csv",
    },
    "reactome": {
        "gmt": "output/refdata/ReactomePathways.gmt",
        "fgsea_results": "output/reactome_results.csv",
        "ranked_genes": "output/ranked_genes_symbol.csv",
    },
    "wikipathways": {
        "gmt": "output/refdata/wikipathways_clean.gmt",
        "fgsea_results": "output/wikipathways_results.csv",
        "ranked_genes": "output/ranked_genes_entrez.csv",
    },
}


def parse_gmt_sizes(gmt_path: str) -> pd.DataFrame:
    """Return a DataFrame of pathway -> nominal member count from a GMT file."""
    rows = []
    with open(gmt_path, encoding="utf-8") as fh:
        for line in fh:
            fields = line.rstrip("\n").split("\t")
            if len(fields) < 3:
                continue
            name = fields[0]
            members = [g for g in fields[2:] if g]
            rows.append({"pathway": name, "nominal_size": len(members)})
    return pd.DataFrame(rows)


def build_coverage_table(collection: str, cfg: dict, ranked_genes: set) -> pd.DataFrame:
    nominal = parse_gmt_sizes(cfg["gmt"])
    fgsea_res = pd.read_csv(cfg["fgsea_results"])
    merged = nominal.merge(
        fgsea_res[["pathway", "size", "pvalue", "padj", "NES"]],
        on="pathway",
        how="left",
    )
    merged = merged.rename(columns={"size": "tested_overlap_size"})
    merged["tested_overlap_size"] = merged["tested_overlap_size"].fillna(0).astype(int)
    merged["coverage_fraction"] = merged["tested_overlap_size"] / merged["nominal_size"]
    merged["entered_fgsea_size_window"] = merged["pathway"].isin(fgsea_res["pathway"])
    merged["collection"] = collection
    merged = merged.sort_values("coverage_fraction", ascending=False).reset_index(drop=True)
    return merged


def main() -> None:
    for collection, cfg in COLLECTIONS.items():
        ranked = pd.read_csv(cfg["ranked_genes"])
        ranked_genes = set(ranked["gene"].astype(str))
        table = build_coverage_table(collection, cfg, ranked_genes)
        out_path = f"output/pathway_coverage_{collection}.csv"
        table.to_csv(out_path, index=False)
        logger.info(
            "%s: %d pathways in GMT, median coverage %.1f%%, %d entered the %d-%d fgsea size window",
            collection,
            len(table),
            100 * table["coverage_fraction"].median(),
            table["entered_fgsea_size_window"].sum(),
            15,
            500,
        )


if __name__ == "__main__":
    main()
