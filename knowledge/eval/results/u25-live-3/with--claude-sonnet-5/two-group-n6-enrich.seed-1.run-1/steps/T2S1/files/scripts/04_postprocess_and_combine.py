"""Post-process the three fgsea passes into report-ready artifacts.

1. Adds a symbol-translated leading-edge column to the WikiPathways tables
   (their ranked list, and hence their leadingEdge genes, are Entrez Gene
   IDs -- see decision_record_wikipathways.json).
2. Builds a single `output/enrichment_results.csv` combining all three
   collections' full fgsea tables (one row per tested gene set, all
   collections), for cross-cutting downstream consumption.
3. Builds `output/significant_pathways_all_collections.csv`, the union of
   collapsed (redundancy-reduced) significant sets across the three passes,
   each annotated with its gene-set-size coverage (nominal vs. tested-overlap).
"""

import logging

import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def build_entrez_to_symbol() -> dict:
    mapping = pd.read_csv(
        "/eval-u25-live-3-with-two-group-n6-enrich-s1-1/runs/"
        "ccf89a64-e0e3-459a-bf3a-a1a6ceade281/T1S6/output/annotation_mapping.csv"
    )
    mapped = mapping[mapping["mapped"]].copy()
    mapped["entrez_id"] = mapped["entrez_id"].astype(int).astype(str)
    return dict(zip(mapped["entrez_id"], mapped["symbol"]))


def translate_leading_edge(series: pd.Series, entrez_to_symbol: dict) -> pd.Series:
    def _translate(cell: str) -> str:
        if not isinstance(cell, str) or not cell:
            return cell
        genes = cell.split(";")
        return ";".join(entrez_to_symbol.get(g, g) for g in genes)

    return series.apply(_translate)


def add_symbol_column(path: str, entrez_to_symbol: dict) -> None:
    df = pd.read_csv(path)
    if "leading_edge" in df.columns:
        df["leading_edge_symbol"] = translate_leading_edge(df["leading_edge"], entrez_to_symbol)
    if "collapsed_sets" in df.columns:
        pass  # collapsed_sets holds pathway names, not gene IDs -- no translation needed
    df.to_csv(path, index=False)
    logger.info("Added leading_edge_symbol to %s (%d rows)", path, len(df))


def load_full_results(collection: str, path: str, coverage_path: str) -> pd.DataFrame:
    res = pd.read_csv(path)
    cov = pd.read_csv(coverage_path)[["pathway", "nominal_size", "coverage_fraction"]]
    merged = res.merge(cov, on="pathway", how="left")
    merged.insert(0, "collection", collection)
    return merged


def main() -> None:
    entrez_to_symbol = build_entrez_to_symbol()
    add_symbol_column("output/wikipathways_results.csv", entrez_to_symbol)
    add_symbol_column("output/wikipathways_collapsed.csv", entrez_to_symbol)

    combined = pd.concat(
        [
            load_full_results("msigdb_hallmark_human_2026.1", "output/hallmark_results.csv", "output/pathway_coverage_hallmark.csv"),
            load_full_results("reactome_pathways_current", "output/reactome_results.csv", "output/pathway_coverage_reactome.csv"),
            load_full_results("wikipathways_human_2026.07.10", "output/wikipathways_results.csv", "output/pathway_coverage_wikipathways.csv"),
        ],
        ignore_index=True,
    )
    combined = combined.rename(
        columns={
            "collection": "source",
            "pathway": "term",
            "pvalue": "p_value",
            "padj": "fdr",
            "size": "size",
            "leading_edge": "genes",
        }
    )
    combined = combined.sort_values(["source", "fdr", "p_value"]).reset_index(drop=True)
    combined.to_csv("output/enrichment_results.csv", index=False)
    logger.info("Wrote output/enrichment_results.csv (%d rows across 3 collections)", len(combined))

    collapsed_frames = []
    for collection, path, coverage_path in [
        ("msigdb_hallmark_human_2026.1", "output/hallmark_collapsed.csv", "output/pathway_coverage_hallmark.csv"),
        ("reactome_pathways_current", "output/reactome_collapsed.csv", "output/pathway_coverage_reactome.csv"),
        ("wikipathways_human_2026.07.10", "output/wikipathways_collapsed.csv", "output/pathway_coverage_wikipathways.csv"),
    ]:
        df = pd.read_csv(path)
        cov = pd.read_csv(coverage_path)[["pathway", "nominal_size", "coverage_fraction"]]
        df = df.merge(cov, on="pathway", how="left")
        df.insert(0, "collection", collection)
        collapsed_frames.append(df)
    all_collapsed = pd.concat(collapsed_frames, ignore_index=True)
    all_collapsed.to_csv("output/significant_pathways_all_collections.csv", index=False)
    logger.info(
        "Wrote output/significant_pathways_all_collections.csv (%d main pathways across 3 collections)",
        len(all_collapsed),
    )


if __name__ == "__main__":
    main()
