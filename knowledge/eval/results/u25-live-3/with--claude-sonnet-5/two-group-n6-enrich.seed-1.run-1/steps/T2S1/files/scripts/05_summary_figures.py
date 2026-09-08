"""Cross-collection summary figures: primary dot plot, bar plot, and a
Hallmark leading-edge cnetplot, required by the enrichment-agent output
contract in addition to the per-collection figures the fgsea template
already produced (figures/{hallmark,reactome,wikipathways}_*).
"""

import logging

import matplotlib.pyplot as plt
import networkx as nx
import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

plt.style.use("seaborn-v0_8-whitegrid")

N_TOP = 20
COLLECTION_COLORS = {
    "msigdb_hallmark_human_2026.1": "#440154",
    "reactome_pathways_current": "#21918c",
    "wikipathways_human_2026.07.10": "#fde725",
}
COLLECTION_LABELS = {
    "msigdb_hallmark_human_2026.1": "Hallmark",
    "reactome_pathways_current": "Reactome",
    "wikipathways_human_2026.07.10": "WikiPathways",
}


def load_top_significant(path: str, n_top: int) -> pd.DataFrame:
    df = pd.read_csv(path)
    df = df.sort_values(["padj", "pvalue"]).head(n_top).copy()
    df["label"] = df["collection"].map(COLLECTION_LABELS) + ": " + df["pathway"].str.slice(0, 55)
    return df


def dot_plot(df: pd.DataFrame, out_prefix: str) -> None:
    df = df.sort_values("NES")
    fig, ax = plt.subplots(figsize=(9, max(5, 0.32 * len(df) + 1.5)))
    sizes = 20 + 3 * df["size"]
    scatter = ax.scatter(df["NES"], df["label"], s=sizes, c=-df["padj"].apply(lambda x: max(x, 1e-300)).apply(
        lambda x: __import__("math").log10(x)
    ), cmap="viridis_r", edgecolor="black", linewidth=0.4)
    ax.axvline(0, color="grey", linestyle="--", linewidth=1)
    ax.set_xlabel("Normalized enrichment score (NES)")
    ax.set_ylabel(None)
    ax.set_title(f"Top {len(df)} enriched gene sets across all 3 collections\n(rank metric: DESeq2 Wald statistic)")
    cbar = fig.colorbar(scatter, ax=ax)
    cbar.set_label("-log10(BH-adjusted p-value)")
    ax.tick_params(axis="y", labelsize=7)
    fig.tight_layout()
    fig.savefig(f"{out_prefix}.png", dpi=300)
    fig.savefig(f"{out_prefix}.pdf")
    plt.close(fig)
    logger.info("Wrote %s.{png,pdf}", out_prefix)


def bar_plot(df: pd.DataFrame, out_prefix: str) -> None:
    df = df.sort_values("NES")
    fig, ax = plt.subplots(figsize=(9, max(5, 0.32 * len(df) + 1.5)))
    colors = df["collection"].map(COLLECTION_COLORS)
    ax.barh(df["label"], df["NES"], color=colors, edgecolor="black", linewidth=0.4)
    ax.axvline(0, color="grey", linestyle="--", linewidth=1)
    ax.set_xlabel("Normalized enrichment score (NES)")
    ax.set_title(f"Top {len(df)} enriched gene sets by adjusted p-value\n(rank metric: DESeq2 Wald statistic)")
    handles = [plt.Rectangle((0, 0), 1, 1, color=c) for c in COLLECTION_COLORS.values()]
    ax.legend(handles, COLLECTION_LABELS.values(), loc="lower right", fontsize=8, title="Collection")
    ax.tick_params(axis="y", labelsize=7)
    fig.tight_layout()
    fig.savefig(f"{out_prefix}.png", dpi=300)
    fig.savefig(f"{out_prefix}.pdf")
    plt.close(fig)
    logger.info("Wrote %s.{png,pdf}", out_prefix)


def cnetplot_hallmark(collapsed_path: str, out_prefix: str, n_pathways: int = 8, n_genes_per_pathway: int = 8) -> None:
    df = pd.read_csv(collapsed_path).sort_values("padj").head(n_pathways)
    graph = nx.Graph()
    for _, row in df.iterrows():
        pathway = row["pathway"].replace("HALLMARK_", "")
        genes = row["leading_edge"].split(";")[:n_genes_per_pathway]
        graph.add_node(pathway, kind="pathway", nes=row["NES"])
        for gene in genes:
            graph.add_node(gene, kind="gene")
            graph.add_edge(pathway, gene)

    pathway_nodes = [n for n, d in graph.nodes(data=True) if d["kind"] == "pathway"]
    gene_nodes = [n for n, d in graph.nodes(data=True) if d["kind"] == "gene"]
    pos = nx.spring_layout(graph, seed=20260904, k=0.6)

    fig, ax = plt.subplots(figsize=(11, 9))
    nes_values = [graph.nodes[n]["nes"] for n in pathway_nodes]
    node_colors = ["#F98E09" if v > 0 else "#3B528B" for v in nes_values]
    nx.draw_networkx_edges(graph, pos, ax=ax, alpha=0.3, width=0.8)
    nx.draw_networkx_nodes(graph, pos, nodelist=gene_nodes, node_size=90, node_color="lightgrey", ax=ax)
    nx.draw_networkx_nodes(
        graph, pos, nodelist=pathway_nodes, node_size=800, node_color=node_colors, edgecolors="black", ax=ax
    )
    nx.draw_networkx_labels(graph, pos, labels={n: n for n in gene_nodes}, font_size=6, ax=ax)
    nx.draw_networkx_labels(graph, pos, labels={n: n for n in pathway_nodes}, font_size=7, font_weight="bold", ax=ax)
    ax.set_title(
        f"Leading-edge network: top {n_pathways} Hallmark pathways "
        f"(orange = positive NES / up in treated, blue = negative NES / down in treated)\n"
        f"up to {n_genes_per_pathway} leading-edge genes per pathway shown"
    )
    ax.axis("off")
    fig.tight_layout()
    fig.savefig(f"{out_prefix}.png", dpi=300)
    fig.savefig(f"{out_prefix}.pdf")
    plt.close(fig)
    logger.info("Wrote %s.{png,pdf}", out_prefix)


def main() -> None:
    top = load_top_significant("output/significant_pathways_all_collections.csv", N_TOP)
    dot_plot(top, "figures/enrichment_dotplot")
    bar_plot(top, "figures/enrichment_barplot")
    cnetplot_hallmark("output/hallmark_collapsed.csv", "figures/enrichment_network")


if __name__ == "__main__":
    main()
