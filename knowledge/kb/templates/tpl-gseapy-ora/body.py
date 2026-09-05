#!/usr/bin/env python3
# tpl-gseapy-ora — Over-representation analysis with an explicit universe.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: hypergeometric over-representation of a discrete gene list against
# gene sets with gseapy.enrich. The universe is the set of genes that the
# differential expression test tested (every row with a non-missing adjusted
# p-value), never the whole genome, and it is passed as the background.
# Benjamini-Hochberg adjustment over the tested sets, and every set with an
# overlap is reported (Reimand et al. 2019; Wijesooriya et al. 2022; Timmons
# et al. 2015). The GMT is read from a local path: no network call occurs.

import json
import os
import platform
import sys

import gseapy
import matplotlib
import numpy as np
import pandas as pd

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

# ── Parameters ────────────────────────────────────────────────────────────────
RESULTS_PATH = {{results_path}}  # [adaptable: results_path]
GMT_PATH = {{gmt_path}}  # [adaptable: gmt_path]
PADJ_CUTOFF = {{padj_cutoff}}  # [adaptable: padj_cutoff]
LFC_CUTOFF = {{lfc_cutoff}}  # [adaptable: lfc_cutoff]
DIRECTION = {{direction}}  # [adaptable: direction]
MIN_SIZE = {{min_size}}  # [adaptable: min_size]
MAX_SIZE = {{max_size}}  # [adaptable: max_size]
OUTPUT_PREFIX = {{output_prefix}}  # [adaptable: output_prefix]
P_ADJUST_METHOD = "BH"
SET_PADJ_CUTOFF = 0.05
N_TOP_SETS = 20
RESULT_COLUMNS = ["pathway", "size", "overlap", "fold_enrichment", "pvalue", "padj", "genes"]

os.makedirs("output", exist_ok=True)
os.makedirs("figures", exist_ok=True)


def message(*parts):
    print("".join(str(part) for part in parts), file=sys.stderr, flush=True)


def stop(*parts):
    message("Error: ", *parts)
    sys.exit(1)


def out(name):
    return os.path.join("output", f"{OUTPUT_PREFIX}_{name}")


def fig(name):
    return os.path.join("figures", f"{OUTPUT_PREFIX}_{name}")


def save_figure(figure, name):
    figure.savefig(fig(f"{name}.png"), dpi=300, bbox_inches="tight")
    figure.savefig(fig(f"{name}.pdf"), bbox_inches="tight")
    plt.close(figure)


# ── Inputs ────────────────────────────────────────────────────────────────────
if DIRECTION not in ("both", "up", "down"):
    stop("The direction must be one of both, up, down, not ", DIRECTION)
if MIN_SIZE > MAX_SIZE:
    stop("min_size (", MIN_SIZE, ") is larger than max_size (", MAX_SIZE, ")")
if not os.path.exists(RESULTS_PATH):
    stop("The results table does not exist: ", RESULTS_PATH)
if not os.path.exists(GMT_PATH):
    stop("The GMT file does not exist: ", GMT_PATH)

message("Reading the differential expression results from ", RESULTS_PATH)
results = pd.read_csv(RESULTS_PATH)
required_columns = ["gene", "log2_fold_change", "adjusted_pvalue"]
absent = [column for column in required_columns if column not in results.columns]
if absent:
    stop("The results table has no column ", ", ".join(absent))
if len(results) == 0:
    stop("The results table has no rows")
results["gene"] = results["gene"].astype("string")
results["log2_fold_change"] = pd.to_numeric(results["log2_fold_change"], errors="coerce")
results["adjusted_pvalue"] = pd.to_numeric(results["adjusted_pvalue"], errors="coerce")
if results["gene"].isna().any() or (results["gene"].str.strip() == "").any():
    stop("The results table has an empty gene identifier")

# The universe: every tested gene, that is every row with an adjusted p-value.
tested = results[results["adjusted_pvalue"].notna()].copy()
universe = sorted(set(tested["gene"]))
if len(universe) == 0:
    stop("No gene has an adjusted p-value, thus the universe is empty")
message("Universe: ", len(universe), " tested genes of ", results["gene"].nunique(), " rows in the table")

# The gene list: under the adjusted p-value cutoff, over the fold change cutoff, in the direction.
selected = (tested["adjusted_pvalue"] < PADJ_CUTOFF) & tested["log2_fold_change"].notna() & (tested["log2_fold_change"].abs() >= LFC_CUTOFF)
if DIRECTION == "up":
    selected = selected & (tested["log2_fold_change"] > 0)
if DIRECTION == "down":
    selected = selected & (tested["log2_fold_change"] < 0)
gene_list = sorted(set(tested.loc[selected, "gene"]))
message("Gene list: ", len(gene_list), " genes at padj < ", PADJ_CUTOFF, ", |log2 fold change| >= ", LFC_CUTOFF, ", direction ", DIRECTION)

message("Reading the gene sets from ", GMT_PATH)
gene_sets = {str(term): [str(gene) for gene in genes] for term, genes in gseapy.read_gmt(GMT_PATH).items()}
if len(gene_sets) == 0:
    stop("The GMT file holds no gene set")
n_sets_in_gmt = len(gene_sets)
universe_set = set(universe)
gene_list_set = set(gene_list)
gmt_genes = set(gene for genes in gene_sets.values() for gene in genes)
annotated_universe = universe_set & gmt_genes
annotated_list = gene_list_set & gmt_genes
message("Gene sets: ", n_sets_in_gmt, "; universe genes in a set: ", len(annotated_universe), "; gene list genes in a set: ", len(annotated_list))
if len(annotated_universe) == 0:
    stop("No universe gene is in a gene set. Make sure that the results table and the GMT use the same identifier space.")
if len(annotated_universe) < 0.1 * len(universe):
    message("Warning: fewer than 10% of the universe is in a gene set; the identifier spaces can differ")

# The size filter on the universe, as clusterProfiler::enricher applies minGSSize and maxGSSize.
set_size = {term: len(set(genes) & universe_set) for term, genes in gene_sets.items()}
sized_sets = {term: genes for term, genes in gene_sets.items() if MIN_SIZE <= set_size[term] <= MAX_SIZE}
overlapping_sets = {term: genes for term, genes in sized_sets.items() if len(set(genes) & gene_list_set) > 0}

# ── Test ──────────────────────────────────────────────────────────────────────
empty_results = pd.DataFrame({column: pd.Series(dtype="float64" if column in ("fold_enrichment", "pvalue", "padj") else "object") for column in RESULT_COLUMNS})

if len(annotated_list) == 0:
    message("The gene list has no gene in a gene set; no set is tested")
    results_table = empty_results
elif len(sized_sets) == 0:
    message("No gene set passes the size filter [", MIN_SIZE, ", ", MAX_SIZE, "] on the universe; no set is tested")
    results_table = empty_results
elif len(overlapping_sets) == 0:
    message("No gene set that passes the size filter overlaps the gene list; no set is tested")
    results_table = empty_results
else:
    # The background is the universe of tested genes. gseapy intersects both the gene list and each set with it.
    enrichment = gseapy.enrich(
        gene_list=gene_list,
        gene_sets=sized_sets,
        background=universe,
        outdir=None,
        no_plot=True,
        verbose=False,
    )
    enrichment_df = enrichment.res2d
    overlap_parts = enrichment_df["Overlap"].astype(str).str.split("/", expand=True)
    overlap = overlap_parts[0].astype(int).to_numpy()
    size = overlap_parts[1].astype(int).to_numpy()
    n_list_in_universe = len(gene_list_set & universe_set)
    fold_enrichment = (overlap / n_list_in_universe) / (size / len(universe))
    results_table = pd.DataFrame(
        {
            "pathway": enrichment_df["Term"].astype(str).to_numpy(),
            "size": size,
            "overlap": overlap,
            "fold_enrichment": fold_enrichment,
            "pvalue": enrichment_df["P-value"].astype(float).to_numpy(),
            "padj": enrichment_df["Adjusted P-value"].astype(float).to_numpy(),
            "genes": enrichment_df["Genes"].astype(str).to_numpy(),
        }
    )
    results_table = results_table.sort_values(["pvalue", "padj"], kind="mergesort").reset_index(drop=True)

n_sets_tested = len(results_table)
n_significant = int((results_table["padj"] < SET_PADJ_CUTOFF).sum())
message("Tested ", n_sets_tested, " gene sets; ", n_significant, " at padj < ", SET_PADJ_CUTOFF)
results_table.to_csv(out("results.csv"), index=False)

# ── Figures ───────────────────────────────────────────────────────────────────
top_sets = results_table.sort_values(["padj", "pvalue"], kind="mergesort").head(N_TOP_SETS).copy()
plot_title = f"ORA, {DIRECTION} genes, padj < {PADJ_CUTOFF}: top {len(top_sets)} sets by padj"
figure_height = max(4.0, 0.3 * len(top_sets) + 1.5)

if len(top_sets) == 0:
    for name in ("dotplot", "barplot"):
        blank, axis = plt.subplots(figsize=(8, 4))
        axis.text(0.5, 0.5, "No gene set was tested", ha="center", va="center", transform=axis.transAxes)
        axis.set_axis_off()
        axis.set_title(plot_title)
        save_figure(blank, name)
else:
    # The most significant set at the top of the axis.
    top_sets = top_sets.iloc[::-1]
    positions = np.arange(len(top_sets))
    neg_log10_padj = -np.log10(np.maximum(top_sets["padj"].to_numpy(dtype=float), np.finfo(float).tiny))
    overlap_values = top_sets["overlap"].to_numpy(dtype=float)
    size_scale = 20 + 180 * (overlap_values - overlap_values.min()) / max(overlap_values.max() - overlap_values.min(), 1.0)

    dot_plot, axis = plt.subplots(figsize=(8, figure_height))
    scatter = axis.scatter(top_sets["fold_enrichment"], positions, s=size_scale, c=top_sets["padj"], cmap="viridis_r")
    axis.set_yticks(positions)
    axis.set_yticklabels(top_sets["pathway"])
    axis.set_xlabel("Fold enrichment")
    axis.set_title(plot_title)
    dot_plot.colorbar(scatter, ax=axis, label="padj")
    for size_value in sorted(set([overlap_values.min(), overlap_values.max()])):
        marker_size = 20 + 180 * (size_value - overlap_values.min()) / max(overlap_values.max() - overlap_values.min(), 1.0)
        axis.scatter([], [], s=marker_size, c="grey", label=f"{int(size_value)}")
    axis.legend(title="Overlap", loc="lower right", frameon=False)
    axis.spines[["top", "right"]].set_visible(False)
    save_figure(dot_plot, "dotplot")

    bar_plot, axis = plt.subplots(figsize=(8, figure_height))
    colormap = plt.get_cmap("viridis")
    normalizer = matplotlib.colors.Normalize(vmin=overlap_values.min(), vmax=overlap_values.max())
    axis.barh(positions, neg_log10_padj, color=colormap(normalizer(overlap_values)))
    axis.axvline(-np.log10(SET_PADJ_CUTOFF), linestyle="--", color="black")
    axis.set_yticks(positions)
    axis.set_yticklabels(top_sets["pathway"])
    axis.set_xlabel("-log10 adjusted p-value")
    axis.set_title(plot_title)
    bar_plot.colorbar(matplotlib.cm.ScalarMappable(norm=normalizer, cmap=colormap), ax=axis, label="Overlap")
    axis.spines[["top", "right"]].set_visible(False)
    save_figure(bar_plot, "barplot")

# ── Summary ───────────────────────────────────────────────────────────────────
versions = {
    "python": platform.python_version(),
    "gseapy": gseapy.__version__,
    "pandas": pd.__version__,
    "numpy": np.__version__,
    "matplotlib": matplotlib.__version__,
}
summary_record = {
    "template": "tpl-gseapy-ora@1.0.0",
    "method": "gseapy enrich, hypergeometric over-representation",
    "inputs": {"results_path": RESULTS_PATH, "gmt_path": GMT_PATH},
    "universe": "tested_genes",
    "direction": DIRECTION,
    "n_input_genes": len(gene_list),
    "n_input_genes_annotated": len(annotated_list),
    "n_universe": len(universe),
    "n_universe_annotated": len(annotated_universe),
    "n_sets_in_gmt": n_sets_in_gmt,
    "n_sets_tested": n_sets_tested,
    "n_significant": n_significant,
    "padj_cutoff": PADJ_CUTOFF,
    "lfc_cutoff": LFC_CUTOFF,
    "min_size": MIN_SIZE,
    "max_size": MAX_SIZE,
    "p_adjust_method": P_ADJUST_METHOD,
    "set_padj_cutoff": SET_PADJ_CUTOFF,
    "versions": versions,
}
with open(out("summary.json"), "w", encoding="utf-8") as handle:
    json.dump(summary_record, handle, indent=2)
with open(os.path.join("output", "session_info.txt"), "w", encoding="utf-8") as handle:
    handle.write(f"Python {sys.version}\n")
    handle.write(f"Platform {platform.platform()}\n")
    for name, version in versions.items():
        if name != "python":
            handle.write(f"{name} {version}\n")
message("Done: ", out("results.csv"))
