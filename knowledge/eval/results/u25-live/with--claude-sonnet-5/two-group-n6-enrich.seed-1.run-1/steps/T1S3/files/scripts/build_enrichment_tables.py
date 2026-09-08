"""Consolidate the Hallmark and Reactome fgsea outputs (T2S1) into report-
facing tables: one enrichment result table per collection (kept separate,
never merged), a shared run-metadata sidecar stating database version, rank
metric, universe, and size window, and the leading-edge gene tables for
padj<0.05 sets. No enrichment computation is repeated here.
"""

import logging
from pathlib import Path

import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

T2S1_DIR = Path(
    "/eval-u25-live-with-two-group-n6-enrich-s1-1/runs/6b692565-63c3-4c64-8953-bea66a07c077/T2S1"
)
OUT = Path("output")
PADJ_THRESHOLD = 0.05


def load_collection_results(name: str) -> pd.DataFrame:
    """Load one collection's full fgsea result table (all tested pathways)."""
    path = T2S1_DIR / "output" / f"fgsea_{name}_results.csv"
    df = pd.read_csv(path)
    logger.info("Loaded %d %s pathways tested (all sizes 15-500)", len(df), name)
    return df


def load_run_parameters() -> pd.DataFrame:
    return pd.read_csv(T2S1_DIR / "output" / "run_parameters_summary.csv")


def load_id_mapping() -> pd.DataFrame:
    return pd.read_csv(T2S1_DIR / "output" / "id_mapping_report.csv")


def build_report_table(df: pd.DataFrame, padj_threshold: float) -> pd.DataFrame:
    """Reorder/trim columns for the report table; keep all tested pathways,
    flag significance, sort by padj ascending (fgsea's native ranking)."""
    out = df.copy()
    out["significant_padj0.05"] = out["padj"].lt(padj_threshold)
    out = out.sort_values("padj").reset_index(drop=True)
    cols = [
        "pathway",
        "size",
        "ES",
        "NES",
        "pval",
        "padj",
        "significant_padj0.05",
        "log2err",
        "leadingEdge",
        "gene_set_collection",
        "release",
    ]
    return out[cols]


def build_run_metadata(run_params: pd.DataFrame, id_mapping: pd.DataFrame) -> pd.DataFrame:
    """One consolidated metadata table: rank metric, universe, size window,
    database versions, significance threshold, per-collection set counts."""
    rp = dict(zip(run_params["field"], run_params["value"]))
    im = dict(zip(id_mapping["mapping_status"], id_mapping["N"]))
    rows = [
        ("rank_metric", rp["rank_metric"]),
        ("universe_n_genes_ranked_total", rp["n_tested_genes_ranked"]),
        (
            "universe_n_genes_with_resolvable_HGNC_symbol",
            int(im["direct_symbol"]) + int(im["alias_resolved"]),
        ),
        ("universe_n_genes_unmapped_retained_in_rank", rp["n_unmapped_genes"]),
        ("universe_unmapped_share", rp["unmapped_share"]),
        ("size_window_min", rp["min_size"]),
        ("size_window_max", rp["max_size"]),
        ("significance_threshold", f"BH padj < {PADJ_THRESHOLD}"),
        ("fgsea_method", "fgseaMultilevel, eps=0, seed=42, nproc=2"),
        ("hallmark_database", "MSigDB Hallmark human, release 2026.1 (h.all.v2026.1.Hs.symbols.gmt)"),
        ("hallmark_n_sets_shipped", 50),
        ("hallmark_n_sets_in_size_window", rp["hallmark_n_sets_in_size_window"]),
        ("hallmark_n_significant_padj0.05", rp["hallmark_n_significant_padj0.05"]),
        (
            "reactome_database",
            (
                "Reactome Pathways, 'current' release as staged in the reference store "
                "(quarterly rolling snapshot, no immutable version tag; restricted to "
                "Homo sapiens via ReactomePathways.txt)"
            ),
        ),
        ("reactome_n_sets_shipped_all_species", rp["reactome_n_sets_shipped_all_species"]),
        ("reactome_n_sets_human", rp["reactome_n_sets_human"]),
        ("reactome_n_sets_in_size_window", rp["reactome_n_sets_in_size_window"]),
        ("reactome_n_significant_padj0.05", rp["reactome_n_significant_padj0.05"]),
        ("annotation_release_org.Hs.eg.db", "3.23.1 (alias resolution, unambiguous aliases only)"),
    ]
    return pd.DataFrame(rows, columns=["field", "value"])


def main() -> None:
    OUT.mkdir(exist_ok=True)

    hallmark = load_collection_results("hallmark")
    reactome = load_collection_results("reactome")
    run_params = load_run_parameters()
    id_mapping = load_id_mapping()

    hallmark_report = build_report_table(hallmark, PADJ_THRESHOLD)
    reactome_report = build_report_table(reactome, PADJ_THRESHOLD)
    hallmark_report.to_csv(OUT / "hallmark_enrichment_table.csv", index=False)
    reactome_report.to_csv(OUT / "reactome_enrichment_table.csv", index=False)
    logger.info(
        "Hallmark: %d sets tested, %d significant. Reactome: %d sets tested, %d significant.",
        len(hallmark_report),
        int(hallmark_report["significant_padj0.05"].sum()),
        len(reactome_report),
        int(reactome_report["significant_padj0.05"].sum()),
    )

    metadata = build_run_metadata(run_params, id_mapping)
    metadata.to_csv(OUT / "enrichment_run_metadata.csv", index=False)

    # Leading-edge gene tables for significant sets: copy through unchanged
    # (long format: pathway, gene), one row per gene per significant pathway.
    for name in ("hallmark", "reactome"):
        src = T2S1_DIR / "output" / f"fgsea_{name}_leading_edge_padj0.05.csv"
        le = pd.read_csv(src)
        le.to_csv(OUT / f"{name}_leading_edge_genes_significant.csv", index=False)
        logger.info(
            "%s leading-edge table: %d gene rows across %d significant pathways",
            name,
            len(le),
            le["pathway"].nunique(),
        )

    # Collapsed (non-redundant) representative pathway sets, for the report's
    # "6 representative Hallmark / 17 representative Reactome" headline.
    for name in ("hallmark", "reactome"):
        src = T2S1_DIR / "output" / f"fgsea_{name}_significant_collapsed_summary.csv"
        collapsed = pd.read_csv(src)
        collapsed.to_csv(OUT / f"{name}_collapsed_representative_sets.csv", index=False)

    overlap = pd.read_csv(T2S1_DIR / "output" / "hallmark_vs_reactome_overlap_summary.csv")
    overlap.to_csv(OUT / "hallmark_vs_reactome_overlap_summary.csv", index=False)


if __name__ == "__main__":
    main()
