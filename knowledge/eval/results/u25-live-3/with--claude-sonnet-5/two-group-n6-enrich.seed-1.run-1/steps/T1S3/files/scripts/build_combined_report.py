"""
Combined DE + pathway enrichment report builder.

Reads the persisted, already-computed outputs of:
  - T1S1 (sample QC / shallow-sample verdict)
  - T1S2 (DESeq2 Wald + apeglm differential expression, treated vs control)
  - T1S6 (gene identifier annotation / mapping coverage)
  - T2S1 (fgsea preranked GSEA: Hallmark, Reactome, WikiPathways)

and assembles:
  - output/gene_table_full.csv           (all tested genes, ranked by shrunken log2FC)
  - output/gene_table_significant.csv    (padj < 0.05 subset of the above)
  - output/enrichment_significant_sets.csv   (every significant gene set, all 3 collections,
                                               leading-edge genes per set)
  - output/reproducibility_record.json   (sessionInfo/versions/seeds/collection versions)
  - figures/*                            (key figures copied in from upstream steps)
  - output/combined_report.md            (the decision-ready narrative report)

Nothing here re-runs any statistical test. This step performs no new inference;
it reads persisted upstream artifacts and re-formats/re-states them.
"""

import json
import logging
import shutil
from pathlib import Path

import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# %% Parameters
RUN_ROOT = Path(
    "/eval-u25-live-3-with-two-group-n6-enrich-s1-1/runs/ccf89a64-e0e3-459a-bf3a-a1a6ceade281"
)
T1S1 = RUN_ROOT / "T1S1" / "output"
T1S1_FIG = RUN_ROOT / "T1S1" / "figures"
T1S2 = RUN_ROOT / "T1S2" / "output"
T1S2_FIG = RUN_ROOT / "T1S2" / "figures"
T1S6 = RUN_ROOT / "T1S6" / "output"
T1S6_FIG = RUN_ROOT / "T1S6" / "figures"
T2S1 = RUN_ROOT / "T2S1" / "output"
T2S1_FIG = RUN_ROOT / "T2S1" / "figures"

OUT_DIR = Path("output")
FIG_DIR = Path("figures")
ALPHA = 0.05


def load_json(path: Path) -> dict:
    """Load a JSON file, failing loudly if it is missing."""
    if not path.exists():
        raise FileNotFoundError(f"Required upstream artifact missing: {path}")
    with open(path) as fh:
        return json.load(fh)


def build_gene_table() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Join DESeq2 results with the T1S6 mapping status and rank by shrunken log2FC."""
    de = pd.read_csv(T1S2 / "de_treated_vs_control_results.csv")
    de = de.rename(
        columns={
            "log2_fold_change": "log2_fold_change_shrunken_apeglm",
            "log2_fold_change_unshrunken": "log2_fold_change_unshrunken_mle",
            "lfc_se": "lfcSE_shrunken",
        }
    )
    mapping = pd.read_csv(T1S6 / "annotation_mapping.csv")
    mapping = mapping[["input_id", "mapped", "entrez_id", "ensembl_id"]].rename(
        columns={"input_id": "gene"}
    )
    de = de.merge(mapping, on="gene", how="left")
    de["is_synthetic_placeholder_id"] = de["gene"].str.match(r"^GENE\d{5}$").fillna(False)
    de["significant_padj_lt_0.05"] = de["adjusted_pvalue"] < ALPHA
    de = de.sort_values("log2_fold_change_shrunken_apeglm", ascending=False, na_position="last")
    de = de.reset_index(drop=True)
    de.insert(0, "rank_by_shrunken_log2fc", range(1, len(de) + 1))
    sig = de.loc[de["significant_padj_lt_0.05"]].copy()
    return de, sig


def build_enrichment_significant_sets() -> pd.DataFrame:
    """Concatenate every significant (padj<0.05) gene set from all 3 collections with leading edges."""
    frames = []
    for collection, fname in [
        ("Hallmark", "hallmark_results.csv"),
        ("Reactome", "reactome_results.csv"),
        ("WikiPathways", "wikipathways_results.csv"),
    ]:
        df = pd.read_csv(T2S1 / fname)
        df = df[df["padj"] < ALPHA].copy()
        df.insert(0, "collection", collection)
        frames.append(df)
    combined = pd.concat(frames, ignore_index=True, sort=False)
    # attach nominal size / coverage where available
    cov_frames = []
    for collection, fname in [
        ("Hallmark", "pathway_coverage_hallmark.csv"),
        ("Reactome", "pathway_coverage_reactome.csv"),
        ("WikiPathways", "pathway_coverage_wikipathways.csv"),
    ]:
        cov = pd.read_csv(T2S1 / fname)
        if "collection" not in cov.columns:
            cov.insert(0, "collection", collection)
        else:
            cov["collection"] = collection
        cov_frames.append(cov[["collection", "pathway", "nominal_size", "tested_overlap_size", "coverage_fraction"]])
    coverage = pd.concat(cov_frames, ignore_index=True)
    combined = combined.merge(coverage, on=["collection", "pathway"], how="left")
    combined = combined.sort_values(["collection", "padj"]).reset_index(drop=True)
    return combined


def copy_figures() -> list[str]:
    """Copy the key required figures from upstream steps into this step's figures/ dir."""
    FIG_DIR.mkdir(parents=True, exist_ok=True)
    to_copy = {
        "de_ma_plot.png": T1S2_FIG / "de_treated_vs_control_ma.png",
        "de_ma_plot.pdf": T1S2_FIG / "de_treated_vs_control_ma.pdf",
        "de_dispersion_plot.png": T1S2_FIG / "de_treated_vs_control_dispersion.png",
        "de_dispersion_plot.pdf": T1S2_FIG / "de_treated_vs_control_dispersion.pdf",
        "de_pvalue_histogram.png": T1S2_FIG / "de_treated_vs_control_pvalue_histogram.png",
        "de_pvalue_histogram.pdf": T1S2_FIG / "de_treated_vs_control_pvalue_histogram.pdf",
        "de_pca.png": T1S2_FIG / "de_treated_vs_control_pca.png",
        "de_pca.pdf": T1S2_FIG / "de_treated_vs_control_pca.pdf",
        "de_volcano.png": T1S2_FIG / "de_treated_vs_control_volcano.png",
        "de_volcano.pdf": T1S2_FIG / "de_treated_vs_control_volcano.pdf",
        "de_sample_distances.png": T1S2_FIG / "de_treated_vs_control_sample_distances.png",
        "qc_library_sizes.png": T1S1_FIG / "qc_library_sizes.png",
        "qc_pca.png": T1S1_FIG / "qc_pca.png",
        "qc_sample_distances.png": T1S1_FIG / "qc_sample_distances.png",
        "annotation_mapping_status.png": T1S6_FIG / "annotation_mapping_status.png",
        "annotation_input_patterns.png": T1S6_FIG / "annotation_input_patterns.png",
        "hallmark_dot_plot.png": T2S1_FIG / "hallmark_dot_plot.png",
        "hallmark_nes_bar_plot.png": T2S1_FIG / "hallmark_nes_bar_plot.png",
        "reactome_dot_plot.png": T2S1_FIG / "reactome_dot_plot.png",
        "reactome_nes_bar_plot.png": T2S1_FIG / "reactome_nes_bar_plot.png",
        "wikipathways_dot_plot.png": T2S1_FIG / "wikipathways_dot_plot.png",
        "wikipathways_nes_bar_plot.png": T2S1_FIG / "wikipathways_nes_bar_plot.png",
        "enrichment_network.png": T2S1_FIG / "enrichment_network.png",
    }
    copied = []
    for dest_name, src in to_copy.items():
        if src.exists():
            dest = FIG_DIR / dest_name
            shutil.copy(src, dest)
            copied.append(dest_name)
        else:
            logger.warning("Source figure missing, skipped: %s", src)
    return copied


def build_reproducibility_record() -> dict:
    """Consolidate sessionInfo/versions/seeds/collection versions across all upstream steps."""
    de_summary = load_json(T1S2 / "de_treated_vs_control_summary.json")
    de_qc = load_json(T1S2 / "de_qc_report.json")
    annot_summary = load_json(T1S6 / "annotation_summary.json")
    hallmark_summary = load_json(T2S1 / "hallmark_summary.json")
    reactome_summary = load_json(T2S1 / "reactome_summary.json")
    wiki_summary = load_json(T2S1 / "wikipathways_summary.json")
    gene_join_qc = load_json(T2S1 / "gene_mapping_join_qc.json")

    record = {
        "report_step": "T1S3 (bulk-transcriptomics-agent, report synthesis)",
        "snapshot_digest": "sha256:40605ae40583456c222ca9f595c1a4c8c995b7a124a1f35c57cb03911412e5e8",
        "differential_expression": {
            "step": "T1S2",
            "method": de_summary["method"],
            "template": de_summary["template"],
            "design": de_summary["design"],
            "contrast": de_summary["contrast"],
            "alpha": de_summary["alpha"],
            "lfc_shrink": de_summary["lfc_shrink"],
            "min_count_filter": {"min_count": de_summary["min_count"], "min_samples": de_summary["min_samples"]},
            "n_genes_input": de_summary["n_genes_input"],
            "n_genes_after_prefilter": de_summary["n_genes_after_filter"],
            "n_genes_tested_after_independent_filtering": de_summary["n_genes_tested"],
            "n_significant_padj_lt_0.05": de_summary["n_significant"],
            "n_up": de_summary["n_up"],
            "n_down": de_summary["n_down"],
            "n_cooks_outlier_na": de_summary["n_cooks_outlier_na"],
            "n_independent_filter_na": de_summary["n_independent_filter_na"],
            "pvalue_histogram_ks_test_tail_uniform": de_qc["pvalue_histogram"],
            "versions": de_summary["versions"],
        },
        "annotation_mapping": {
            "step": "T1S6",
            "organism_package": annot_summary["organism_package"],
            "organism_package_version": annot_summary["organism_package_version"],
            "entrez_source_date": annot_summary["entrez_source_date"],
            "ensembl_source_date": annot_summary["ensembl_source_date"],
            "organism_assumption": annot_summary["organism"],
            "n_mapped": annot_summary["n_mapped"],
            "mapped_share": annot_summary["mapped_share"],
            "n_unmapped": annot_summary["n_unmapped"],
            "unmapped_share": annot_summary["unmapped_share"],
            "versions": annot_summary["versions"],
        },
        "enrichment": {
            "step": "T2S1",
            "rank_metric": hallmark_summary["rank_metric"],
            "gene_universe_join_qc": gene_join_qc,
            "seed": hallmark_summary["seed"],
            "size_window": {"min_size": hallmark_summary["min_size"], "max_size": hallmark_summary["max_size"]},
            "padj_cutoff": hallmark_summary["padj_cutoff"],
            "collections": {
                "hallmark": {
                    "database_file": hallmark_summary["database"],
                    "collection_version": "MSigDB Hallmark human 2026.1",
                    "n_sets_input": hallmark_summary["n_sets_input"],
                    "n_sets_tested_in_window": hallmark_summary["n_sets_tested"],
                    "n_significant": hallmark_summary["n_significant"],
                    "n_main_pathways_after_collapse": hallmark_summary["n_main_pathways"],
                },
                "reactome": {
                    "database_file": reactome_summary["database"],
                    "collection_version": "Reactome pathways, 'current' quarterly release (no fixed version string upstream)",
                    "n_sets_input": reactome_summary["n_sets_input"],
                    "n_sets_tested_in_window": reactome_summary["n_sets_tested"],
                    "n_significant": reactome_summary["n_significant"],
                    "n_main_pathways_after_collapse": reactome_summary["n_main_pathways"],
                },
                "wikipathways": {
                    "database_file": wiki_summary["database"],
                    "collection_version": "WikiPathways human 2026.07.10",
                    "n_sets_input": wiki_summary["n_sets_input"],
                    "n_sets_tested_in_window": wiki_summary["n_sets_tested"],
                    "n_significant": wiki_summary["n_significant"],
                    "n_main_pathways_after_collapse": wiki_summary["n_main_pathways"],
                },
            },
            "versions": hallmark_summary["versions"],
        },
    }
    return record


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    FIG_DIR.mkdir(parents=True, exist_ok=True)

    logger.info("Building consolidated gene table ranked by shrunken log2FC")
    gene_full, gene_sig = build_gene_table()
    gene_full.to_csv(OUT_DIR / "gene_table_full.csv", index=False)
    gene_sig.to_csv(OUT_DIR / "gene_table_significant.csv", index=False)
    logger.info("Wrote gene_table_full.csv (%d rows) and gene_table_significant.csv (%d rows)",
                len(gene_full), len(gene_sig))

    logger.info("Building consolidated significant-pathway table (all sets, all collections)")
    enr_sig = build_enrichment_significant_sets()
    enr_sig.to_csv(OUT_DIR / "enrichment_significant_sets.csv", index=False)
    logger.info("Wrote enrichment_significant_sets.csv (%d rows)", len(enr_sig))

    logger.info("Copying key figures")
    copied = copy_figures()
    logger.info("Copied %d figures: %s", len(copied), copied)

    logger.info("Building reproducibility record")
    record = build_reproducibility_record()
    with open(OUT_DIR / "reproducibility_record.json", "w") as fh:
        json.dump(record, fh, indent=2)
    logger.info("Wrote reproducibility_record.json")

    # Save small text summary tables used by the markdown report for exact reproducible numbers
    stats = {
        "n_genes_full_table": len(gene_full),
        "n_genes_significant": len(gene_sig),
        "n_significant_up": int((gene_sig["log2_fold_change_shrunken_apeglm"] > 0).sum()),
        "n_significant_down": int((gene_sig["log2_fold_change_shrunken_apeglm"] < 0).sum()),
        "n_significant_mapped": int(gene_sig["mapped"].fillna(False).astype(bool).sum()),
        "n_significant_placeholder": int(gene_sig["is_synthetic_placeholder_id"].sum()),
        "n_enrichment_significant_sets_all_collections": len(enr_sig),
    }
    with open(OUT_DIR / "report_derived_stats.json", "w") as fh:
        json.dump(stats, fh, indent=2)
    logger.info("Derived stats: %s", stats)


if __name__ == "__main__":
    main()
