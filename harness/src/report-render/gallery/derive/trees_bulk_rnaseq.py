# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "pandas",
#   "numpy",
#   "scipy",
# ]
# [tool.uv]
# exclude-newer = "2026-09-25T00:00:00Z"
# ///
"""Build the E1 tree edge-list tables for the gallery heatmap dendrograms.

Usage: uv run trees_bulk_rnaseq.py <gallery-data work dir>

Reads derived/bulk_rnaseq/heatmap_top_genes.csv and
derived/bulk_rnaseq/sample_distances.csv (both written by
bulk_rnaseq_pasilla.py) and re-derives the hierarchical-clustering linkage
that produced their gene_order/sample_order/row_order/col_order columns, so
this script must run after bulk_rnaseq_pasilla.py.

No new raw input and no randomness: the two source CSVs already hold every
number this script needs (the z-scores of heatmap_top_genes.csv, the full
pairwise distance matrix of sample_distances.csv), so linkage() runs again on
that same data with the same method and metric that bulk_rnaseq_pasilla.py
used, instead of a second run of pydeseq2. scipy's linkage() has no internal
random sampling, so re-running this script reproduces the same edges.

Writes derived/bulk_rnaseq/tree_top_genes_rows.csv (the top-40-DE-gene tree,
average linkage / Euclidean, matches heatmap_top_genes.csv gene_order),
derived/bulk_rnaseq/tree_top_genes_cols.csv (the 7-sample tree on the same 40
genes, average linkage / Euclidean, matches heatmap_top_genes.csv
sample_order), and derived/bulk_rnaseq/tree_samples.csv (the 7-sample tree on
the full VST matrix, complete linkage / Euclidean, matches
sample_distances.csv row_order and col_order -- one tree serves both axes of
that heatmap). Each is a parent,child,height edge list: a leaf is a child
that is never a parent and it is named exactly as its axis category (a
gene_symbol or a sample name); an internal node is named node_1, node_2, ...
in linkage order; height is the merge height of the parent. This script
verifies, for each tree, that a depth-first walk (children visited in table
order) reproduces the exact gene_order/sample_order/row_order/col_order
column of its source CSV, and it raises if a tree does not.
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.cluster.hierarchy import linkage, leaves_list
from scipy.spatial.distance import pdist, squareform

WORK_DIR = Path(sys.argv[1])
BULK_DIR = WORK_DIR / "derived/bulk_rnaseq"


def linkage_to_edges(link: np.ndarray, leaf_names: list[str]) -> tuple[pd.DataFrame, str]:
    """Turn a scipy linkage matrix into a parent,child,height edge list.

    scipy numbers the n original observations 0..n-1 and each new merge i
    (0-indexed) creates cluster n+i from Z[i,0] and Z[i,1] at height Z[i,2].
    node_{i+1} names that merge, in linkage order, so node_1 is the first
    merge. The two edges of a merge are written child1 (Z[i,0]) then child2
    (Z[i,1]): a depth-first walk that visits a node's edges in table order
    then matches scipy's own leaves_list order for this same linkage matrix,
    which is what heatmap_top_genes.csv / sample_distances.csv used to write
    their order columns.
    """
    n = len(leaf_names)

    def node_name(cluster_idx: int) -> str:
        return leaf_names[cluster_idx] if cluster_idx < n else f"node_{cluster_idx - n + 1}"

    rows = []
    for i in range(link.shape[0]):
        c1, c2, height = int(link[i, 0]), int(link[i, 1]), float(link[i, 2])
        parent = f"node_{i + 1}"
        rows.append({"parent": parent, "child": node_name(c1), "height": height})
        rows.append({"parent": parent, "child": node_name(c2), "height": height})
    root = f"node_{link.shape[0]}"
    return pd.DataFrame(rows, columns=["parent", "child", "height"]), root


def dfs_leaf_order(edges: pd.DataFrame, root: str, leaf_names: list[str]) -> list[str]:
    children: dict[str, list[str]] = {}
    for parent, child in zip(edges["parent"], edges["child"]):
        children.setdefault(parent, []).append(child)
    leaf_set = set(leaf_names)
    order: list[str] = []

    def visit(node: str) -> None:
        if node in leaf_set:
            order.append(node)
            return
        for c in children[node]:
            visit(c)

    visit(root)
    return order


def verify_or_raise(name: str, recomputed_order: list[str], expected_order: list[str]) -> None:
    if recomputed_order != expected_order:
        raise RuntimeError(
            f"{name}: depth-first leaf order does not match the source CSV's order column.\n"
            f"  recomputed: {recomputed_order}\n"
            f"  expected:   {expected_order}"
        )
    print(f"{name}: depth-first leaf order matches the source order column ({len(expected_order)} leaves). OK.")


def main() -> None:
    heatmap = pd.read_csv(BULK_DIR / "heatmap_top_genes.csv")
    sample_dist = pd.read_csv(BULK_DIR / "sample_distances.csv")

    # ---- tree_top_genes_rows.csv: genes of heatmap_top_genes.csv, average linkage ----
    genes = heatmap.drop_duplicates("gene_symbol").sort_values("gene_order")["gene_symbol"].tolist()
    samples_hm = heatmap.drop_duplicates("sample").sort_values("sample_order")["sample"].tolist()
    z = heatmap.pivot(index="gene_symbol", columns="sample", values="zscore").loc[genes, samples_hm]

    gene_link = linkage(pdist(z.to_numpy(), metric="euclidean"), method="average")
    gene_edges, gene_root = linkage_to_edges(gene_link, list(z.index))
    verify_or_raise(
        "tree_top_genes_rows",
        dfs_leaf_order(gene_edges, gene_root, list(z.index)),
        [genes[i] for i in leaves_list(gene_link)],
    )
    gene_edges.to_csv(BULK_DIR / "tree_top_genes_rows.csv", index=False)

    # ---- tree_top_genes_cols.csv: the same 40 genes' 7 samples, average linkage ----
    sample_link = linkage(pdist(z.T.to_numpy(), metric="euclidean"), method="average")
    sample_edges, sample_root = linkage_to_edges(sample_link, list(z.columns))
    verify_or_raise(
        "tree_top_genes_cols",
        dfs_leaf_order(sample_edges, sample_root, list(z.columns)),
        [samples_hm[i] for i in leaves_list(sample_link)],
    )
    sample_edges.to_csv(BULK_DIR / "tree_top_genes_cols.csv", index=False)

    # ---- tree_samples.csv: sample_distances.csv, complete linkage on the full VST distance matrix ----
    samples_sd = (
        sample_dist.sort_values("row_order").drop_duplicates("sample_a")["sample_a"].tolist()
    )
    idx = {s: i for i, s in enumerate(samples_sd)}
    n = len(samples_sd)
    dmat = np.zeros((n, n))
    for a, b, dist in zip(sample_dist["sample_a"], sample_dist["sample_b"], sample_dist["distance"]):
        dmat[idx[a], idx[b]] = dist
    condensed = squareform(dmat, checks=False)
    dist_link = linkage(condensed, method="complete")
    dist_edges, dist_root = linkage_to_edges(dist_link, samples_sd)
    verify_or_raise(
        "tree_samples",
        dfs_leaf_order(dist_edges, dist_root, samples_sd),
        [samples_sd[i] for i in leaves_list(dist_link)],
    )
    dist_edges.to_csv(BULK_DIR / "tree_samples.csv", index=False)

    print(f"tree_top_genes_rows: {len(gene_edges)} edges ({len(genes)} leaves)")
    print(f"tree_top_genes_cols: {len(sample_edges)} edges ({len(samples_hm)} leaves)")
    print(f"tree_samples: {len(dist_edges)} edges ({len(samples_sd)} leaves)")


if __name__ == "__main__":
    main()
