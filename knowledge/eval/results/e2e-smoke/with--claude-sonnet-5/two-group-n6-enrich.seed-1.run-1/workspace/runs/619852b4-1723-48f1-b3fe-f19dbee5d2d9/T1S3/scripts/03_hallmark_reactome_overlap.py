"""
03_hallmark_reactome_overlap.py

Quantify agreement/disagreement between the Hallmark and Reactome preranked
GSEA hits (both from T2S1, same ranking metric = DESeq2 Wald `stat`, same
gene universe). For every pair of significant (padj<0.05) representative
pathways across the two collections, compute:
  - Jaccard overlap of their leading-edge gene sets
  - whether their NES signs agree (same direction of enrichment)

This directly measures cross-collection concordance rather than asserting it
qualitatively, and surfaces the strongest cross-collection pathway pairs.

Inputs:
  T2S1/output/hallmark_collapsed.csv, reactome_collapsed.csv (representative,
  significant sets only, with leading_edge as ';'-joined gene symbols)

Outputs:
  output/hallmark_reactome_overlap_pairs.csv - all representative-pathway
      pairs with Jaccard index, shared gene count, NES-sign agreement
  output/hallmark_reactome_overlap_summary.json - aggregate concordance stats
  figures/hallmark_reactome_overlap_heatmap.png / .pdf
"""

import json
import logging
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# %% Parameters
T2S1_OUT = Path(
    "/eval-e2e-smoke-with-two-group-n6-enrich-s1-1/runs/619852b4-1723-48f1-b3fe-f19dbee5d2d9/T2S1/output"
)
OUTPUT_DIR = Path("output")
FIGURE_DIR = Path("figures")
JACCARD_LABEL_THRESHOLD = 0.15  # annotate cells at/above this overlap in the heatmap


def load_leading_edge_sets(path: Path) -> pd.DataFrame:
    """Load a collapsed (representative, significant) fgsea table and split leading_edge."""
    df = pd.read_csv(path)
    df["leading_edge_genes"] = df["leading_edge"].apply(
        lambda s: set(s.split(";")) if isinstance(s, str) and s else set()
    )
    return df


def jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def compute_pairwise_overlap(hallmark: pd.DataFrame, reactome: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for _, h in hallmark.iterrows():
        for _, r in reactome.iterrows():
            shared = h["leading_edge_genes"] & r["leading_edge_genes"]
            j = jaccard(h["leading_edge_genes"], r["leading_edge_genes"])
            rows.append(
                {
                    "hallmark_pathway": h["pathway"],
                    "hallmark_NES": h["NES"],
                    "reactome_pathway": r["pathway"],
                    "reactome_NES": r["NES"],
                    "nes_sign_agree": bool(np.sign(h["NES"]) == np.sign(r["NES"])),
                    "n_shared_leading_edge_genes": len(shared),
                    "jaccard_index": j,
                    "shared_genes": ";".join(sorted(shared)),
                }
            )
    return pd.DataFrame(rows).sort_values("jaccard_index", ascending=False).reset_index(drop=True)


def plot_heatmap(pairs: pd.DataFrame, hallmark: pd.DataFrame, reactome: pd.DataFrame, out_prefix: Path) -> None:
    """Heatmap of Jaccard overlap, Hallmark (rows) x Reactome (cols), NES-sorted."""
    hallmark_order = hallmark.sort_values("NES", ascending=False)["pathway"].tolist()
    reactome_order = reactome.sort_values("NES", ascending=False)["pathway"].tolist()
    mat = pairs.pivot(index="hallmark_pathway", columns="reactome_pathway", values="jaccard_index")
    mat = mat.reindex(index=hallmark_order, columns=reactome_order)

    short_h = [p.replace("HALLMARK_", "").replace("_", " ")[:35] for p in mat.index]
    short_r = [p[:30] for p in mat.columns]

    fig, ax = plt.subplots(figsize=(max(10, 0.45 * len(short_r)), max(6, 0.35 * len(short_h))))
    sns.heatmap(
        mat.values,
        xticklabels=short_r,
        yticklabels=short_h,
        cmap="viridis",
        vmin=0,
        vmax=max(0.05, np.nanmax(mat.values)),
        cbar_kws={"label": "Jaccard index (leading-edge gene overlap)"},
        ax=ax,
        linewidths=0.3,
        linecolor="white",
    )
    ax.set_title(
        "Leading-edge gene overlap: Hallmark vs Reactome\n"
        "(representative, padj<0.05 sets; both ranked on DESeq2 Wald stat)",
        fontsize=11,
    )
    ax.set_xlabel("Reactome pathway (representative, significant)")
    ax.set_ylabel("Hallmark pathway (representative, significant)")
    plt.setp(ax.get_xticklabels(), rotation=45, ha="right", fontsize=7)
    plt.setp(ax.get_yticklabels(), fontsize=7)
    fig.tight_layout()
    fig.savefig(out_prefix.with_suffix(".png"), dpi=300)
    fig.savefig(out_prefix.with_suffix(".pdf"))
    plt.close(fig)
    logger.info("Wrote heatmap to %s(.png/.pdf)", out_prefix)


def summarize(pairs: pd.DataFrame, hallmark: pd.DataFrame, reactome: pd.DataFrame) -> dict:
    strong = pairs[pairs["jaccard_index"] >= JACCARD_LABEL_THRESHOLD]
    any_overlap = pairs[pairs["n_shared_leading_edge_genes"] > 0]
    agree_direction = any_overlap["nes_sign_agree"].mean() if len(any_overlap) else float("nan")

    hallmark_genes_union = set().union(*hallmark["leading_edge_genes"]) if len(hallmark) else set()
    reactome_genes_union = set().union(*reactome["leading_edge_genes"]) if len(reactome) else set()
    union_jaccard = jaccard(hallmark_genes_union, reactome_genes_union)

    summary = {
        "n_hallmark_representative_significant": int(len(hallmark)),
        "n_reactome_representative_significant": int(len(reactome)),
        "n_pathway_pairs_compared": int(len(pairs)),
        "n_pairs_with_any_shared_leading_edge_gene": int(len(any_overlap)),
        "fraction_overlapping_pairs_with_concordant_nes_sign": (
            None if np.isnan(agree_direction) else round(float(agree_direction), 4)
        ),
        "jaccard_threshold_for_strong_pair": JACCARD_LABEL_THRESHOLD,
        "n_strong_pairs_ge_threshold": int(len(strong)),
        "top_10_pairs_by_jaccard": pairs.head(10)[
            ["hallmark_pathway", "reactome_pathway", "jaccard_index", "n_shared_leading_edge_genes", "nes_sign_agree"]
        ].to_dict(orient="records"),
        "hallmark_leading_edge_gene_union_size": len(hallmark_genes_union),
        "reactome_leading_edge_gene_union_size": len(reactome_genes_union),
        "leading_edge_gene_union_jaccard_hallmark_vs_reactome": round(union_jaccard, 4),
        "n_leading_edge_genes_shared_across_collections": len(hallmark_genes_union & reactome_genes_union),
    }
    return summary


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    FIGURE_DIR.mkdir(parents=True, exist_ok=True)

    hallmark = load_leading_edge_sets(T2S1_OUT / "hallmark_collapsed.csv")
    reactome = load_leading_edge_sets(T2S1_OUT / "reactome_collapsed.csv")
    logger.info(
        "Comparing %d representative Hallmark sets vs %d representative Reactome sets",
        len(hallmark),
        len(reactome),
    )

    pairs = compute_pairwise_overlap(hallmark, reactome)
    pairs.to_csv(OUTPUT_DIR / "hallmark_reactome_overlap_pairs.csv", index=False)

    summary = summarize(pairs, hallmark, reactome)
    (OUTPUT_DIR / "hallmark_reactome_overlap_summary.json").write_text(json.dumps(summary, indent=2))

    plot_heatmap(pairs, hallmark, reactome, FIGURE_DIR / "hallmark_reactome_overlap_heatmap")
    logger.info("Done.")


if __name__ == "__main__":
    main()
