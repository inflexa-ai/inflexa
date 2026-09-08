"""
02_build_pathway_tables.py

Assemble the Hallmark and Reactome fgsea preranked GSEA results (from T2S1)
into two report-ready tables, each carrying the metadata acceptance criteria
requires alongside the statistics: database + version, ranking metric,
gene universe size, and the min/max set-size window used to select tested
sets. Also writes a combined significant-only table across both collections.

Inputs (T2S1/output/):
  hallmark_results.csv, hallmark_collapsed.csv, hallmark_summary.json
  reactome_results.csv, reactome_collapsed.csv, reactome_summary.json

Outputs:
  output/pathway_table_hallmark.csv   - full 50-set Hallmark table, padj-sorted,
                                         with is_representative flag + metadata cols
  output/pathway_table_reactome.csv   - full 787-set Reactome table (tested sets
                                         only, i.e. those inside min/max size
                                         window), padj-sorted, same treatment
  output/pathway_table_combined_significant.csv - padj<0.05 rows from both,
                                         stacked, for the report body
  output/pathway_table_summary.json  - counts/metadata echoed for the report
"""

import json
import logging
from pathlib import Path

import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# %% Parameters
T2S1_OUT = Path(
    "/eval-e2e-smoke-with-two-group-n6-enrich-s1-1/runs/619852b4-1723-48f1-b3fe-f19dbee5d2d9/T2S1/output"
)
PADJ_THRESHOLD = 0.05
OUTPUT_DIR = Path("output")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def load_collection(
    collection: str,
    results_csv: Path,
    collapsed_csv: Path,
    summary_json: Path,
) -> tuple[pd.DataFrame, dict]:
    """Load one collection's full results, flag representative sets, attach metadata."""
    results = pd.read_csv(results_csv)
    collapsed = pd.read_csv(collapsed_csv)
    summary = load_json(summary_json)

    representative_names = set(collapsed["pathway"])
    results = results.sort_values("padj").reset_index(drop=True)
    results.insert(0, "collection", collection)
    results["is_representative"] = results["pathway"].isin(representative_names)

    if collection == "Hallmark":
        database = "MSigDB Hallmark human, h.all.v2026.1.Hs.symbols.gmt (release 2026.1)"
    else:
        database = "Reactome ReactomePathways.gmt, release 'current' (host-provisioned snapshot, human-filtered)"

    results["database"] = database
    results["ranking_metric"] = summary["rank_metric"]
    results["gene_universe_size"] = summary["n_genes_ranked"]
    results["genes_in_tested_sets"] = summary["n_genes_in_sets"]
    results["min_set_size"] = summary["min_size"]
    results["max_set_size"] = summary["max_size"]
    results["n_sets_input"] = summary["n_sets_input"]
    results["n_sets_tested"] = summary["n_sets_tested"]

    logger.info(
        "%s: %d sets tested, %d significant (padj<%.2f), %d representative",
        collection,
        len(results),
        int((results["padj"] < PADJ_THRESHOLD).sum()),
        PADJ_THRESHOLD,
        results["is_representative"].sum(),
    )
    return results, summary


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    hallmark, hallmark_summary = load_collection(
        "Hallmark",
        T2S1_OUT / "hallmark_results.csv",
        T2S1_OUT / "hallmark_collapsed.csv",
        T2S1_OUT / "hallmark_summary.json",
    )
    reactome, reactome_summary = load_collection(
        "Reactome",
        T2S1_OUT / "reactome_results.csv",
        T2S1_OUT / "reactome_collapsed.csv",
        T2S1_OUT / "reactome_summary.json",
    )

    hallmark.to_csv(OUTPUT_DIR / "pathway_table_hallmark.csv", index=False)
    reactome.to_csv(OUTPUT_DIR / "pathway_table_reactome.csv", index=False)

    combined_sig = pd.concat(
        [hallmark[hallmark["padj"] < PADJ_THRESHOLD], reactome[reactome["padj"] < PADJ_THRESHOLD]],
        ignore_index=True,
    ).sort_values(["collection", "padj"])
    combined_sig.to_csv(OUTPUT_DIR / "pathway_table_combined_significant.csv", index=False)

    summary = {
        "padj_threshold": PADJ_THRESHOLD,
        "hallmark": {
            "database": "MSigDB Hallmark human, 2026.1",
            "ranking_metric": hallmark_summary["rank_metric"],
            "gene_universe_size": hallmark_summary["n_genes_ranked"],
            "min_size": hallmark_summary["min_size"],
            "max_size": hallmark_summary["max_size"],
            "n_sets_input": hallmark_summary["n_sets_input"],
            "n_sets_tested": hallmark_summary["n_sets_tested"],
            "n_significant": hallmark_summary["n_significant"],
            "n_up": hallmark_summary["n_up"],
            "n_down": hallmark_summary["n_down"],
            "n_representative": hallmark_summary["n_main_pathways"],
        },
        "reactome": {
            "database": "Reactome pathways, release 'current' (host-provisioned snapshot)",
            "ranking_metric": reactome_summary["rank_metric"],
            "gene_universe_size": reactome_summary["n_genes_ranked"],
            "min_size": reactome_summary["min_size"],
            "max_size": reactome_summary["max_size"],
            "n_sets_input": reactome_summary["n_sets_input"],
            "n_sets_tested": reactome_summary["n_sets_tested"],
            "n_significant": reactome_summary["n_significant"],
            "n_up": reactome_summary["n_up"],
            "n_down": reactome_summary["n_down"],
            "n_representative": reactome_summary["n_main_pathways"],
        },
    }
    (OUTPUT_DIR / "pathway_table_summary.json").write_text(json.dumps(summary, indent=2))
    logger.info("Done.")


if __name__ == "__main__":
    main()
