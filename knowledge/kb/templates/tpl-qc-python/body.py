#!/usr/bin/env python3
# tpl-qc-python — Sample structure QC on a bulk RNA-seq count matrix, in Python.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: the Python mirror of tpl-qc-eda. Median-of-ratios size factors scale
# the counts, then log2(CPM + 1) takes the place of the variance stabilizing
# transformation. PCA on the most variable genes with scikit-learn, a Euclidean
# sample distance heatmap with seaborn, and the library size and the number of
# detected genes per sample with a low depth flag against the median library
# size (Love et al. 2014; Love et al. 2015; Conesa et al. 2016).

import json
import os
import platform
import sys
from importlib import metadata as importlib_metadata

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import seaborn as sns  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402
from matplotlib.patches import Patch  # noqa: E402
from scipy.cluster.hierarchy import linkage  # noqa: E402
from scipy.spatial.distance import pdist, squareform  # noqa: E402
from sklearn.decomposition import PCA  # noqa: E402

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH      = {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH    = {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN = {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN = {{condition_column}}  # [adaptable: condition_column]
{{#if batch_column}}
BATCH_COLUMN     = {{batch_column}}  # [adaptable: batch_column]
{{/if}}
{{#unless batch_column}}
BATCH_COLUMN     = None  # [adaptable: batch_column] None: no batch column, one point shape in the PCA
{{/unless}}
N_TOP_GENES_PCA  = {{n_top_genes_pca}}  # [adaptable: n_top_genes_pca]
LOW_DEPTH_RATIO  = {{low_depth_ratio}}  # [adaptable: low_depth_ratio]
OUTPUT_PREFIX    = {{output_prefix}}  # [adaptable: output_prefix]

os.makedirs("output", exist_ok=True)
os.makedirs("figures", exist_ok=True)


def message(*parts):
    print("".join(str(part) for part in parts), file=sys.stderr, flush=True)


def out(name):
    return os.path.join("output", f"{OUTPUT_PREFIX}_{name}")


def fig(name):
    return os.path.join("figures", f"{OUTPUT_PREFIX}_{name}")


def save_figure(figure, name, width=6, height=5):
    figure.set_size_inches(width, height)
    figure.tight_layout()
    figure.savefig(fig(f"{name}.png"), dpi=300)
    figure.savefig(fig(f"{name}.pdf"))
    plt.close(figure)


# ── Inputs ────────────────────────────────────────────────────────────────────
message("Reading counts from ", COUNTS_PATH)
counts_df = pd.read_csv(COUNTS_PATH)
if counts_df.shape[1] < 2:
    sys.exit("The count matrix needs a gene id column and at least one sample column")
gene_ids = counts_df.iloc[:, 0].astype(str)
counts = counts_df.iloc[:, 1:].copy()
counts.index = gene_ids
counts.columns = [str(column) for column in counts.columns]
counts = counts.apply(pd.to_numeric, errors="coerce")
if counts.isna().any().any():
    sys.exit("The count matrix holds a missing value")
if (counts < 0).any().any() or ((counts - counts.round()).abs() > 1e-6).any().any():
    sys.exit("The count matrix must hold non-negative integers. This QC takes raw counts, not TPM or FPKM.")
counts = counts.round().astype(np.int64)
if counts.shape[1] < 3:
    sys.exit(f"The QC needs at least 3 samples for a PCA, the count matrix has {counts.shape[1]}")
if counts.columns.duplicated().any():
    sys.exit("The count matrix header holds a duplicated sample id")

message("Reading the sample table from ", METADATA_PATH)
sample_table = pd.read_csv(METADATA_PATH)
if SAMPLE_ID_COLUMN not in sample_table.columns:
    sys.exit(f"The sample table has no column {SAMPLE_ID_COLUMN}")
if CONDITION_COLUMN not in sample_table.columns:
    sys.exit(f"The sample table has no column {CONDITION_COLUMN}")
has_batch = BATCH_COLUMN is not None
if has_batch and BATCH_COLUMN not in sample_table.columns:
    sys.exit(f"The sample table has no column {BATCH_COLUMN}")
if sample_table[SAMPLE_ID_COLUMN].duplicated().any():
    sys.exit(f"The sample table holds a duplicated sample id in {SAMPLE_ID_COLUMN}")
sample_table.index = sample_table[SAMPLE_ID_COLUMN].astype(str)
missing = [sample for sample in counts.columns if sample not in sample_table.index]
if missing:
    sys.exit("Samples in the counts but not in the sample table: " + ", ".join(missing))
sample_table = sample_table.loc[list(counts.columns)]
if sample_table[CONDITION_COLUMN].isna().any():
    sys.exit(f"The column {CONDITION_COLUMN} holds a missing value")
condition = sample_table[CONDITION_COLUMN].astype(str)
condition_levels = sorted(set(condition))
if has_batch:
    if sample_table[BATCH_COLUMN].isna().any():
        sys.exit(f"The column {BATCH_COLUMN} holds a missing value")
    batch = sample_table[BATCH_COLUMN].astype(str)
    batch_levels = sorted(set(batch))
else:
    batch = None
    batch_levels = []
message("Samples: ", counts.shape[1], "; genes: ", counts.shape[0])
message("Condition levels: ", ", ".join(condition_levels))
if has_batch:
    message("Batch levels: ", ", ".join(batch_levels))

# ── Library sizes ─────────────────────────────────────────────────────────────
library_size = counts.sum(axis=0)
detected_genes = (counts > 0).sum(axis=0)
median_library_size = float(library_size.median())
if median_library_size <= 0:
    sys.exit("The median library size is 0, the count matrix is empty")
ratio_to_median = library_size / median_library_size
low_depth = ratio_to_median < 1 / LOW_DEPTH_RATIO
library_table = pd.DataFrame(
    {
        "sample": list(counts.columns),
        "library_size": library_size.to_numpy().astype(float),
        "detected_genes": detected_genes.to_numpy().astype(int),
        "ratio_to_median": ratio_to_median.to_numpy().astype(float),
        "low_depth": low_depth.to_numpy().astype(bool),
    }
)
library_table.to_csv(out("library_sizes.csv"), index=False)
low_depth_samples = [str(sample) for sample in library_table.loc[library_table["low_depth"], "sample"]]
message("Median library size: ", f"{median_library_size:,.0f}", "; low depth flag below 1/", LOW_DEPTH_RATIO, " of the median")
message("Library sizes: ", ", ".join(f"{row.sample}={row.library_size:,.0f} ({row.ratio_to_median:.2f}x)" for row in library_table.itertuples()))
message("Low depth samples: ", ", ".join(low_depth_samples) if low_depth_samples else "none")

# ── Size factors and log2(CPM + 1) ────────────────────────────────────────────
# Median-of-ratios size factors as in DESeq2: the geometric mean of each gene
# across the samples is the reference, on the genes with a count in every sample.
count_matrix = counts.to_numpy().astype(float)
expressed = (count_matrix > 0).all(axis=1)
if expressed.sum() < 1:
    sys.exit("No gene has a count in every sample, the size factors cannot be estimated")
log_reference = np.log(count_matrix[expressed]).mean(axis=1)
size_factors = np.exp(np.median(np.log(count_matrix[expressed]) - log_reference[:, None], axis=0))
message("Size factors: ", ", ".join(f"{sample}={value:.2f}" for sample, value in zip(counts.columns, size_factors)))
scaled = count_matrix / size_factors[None, :]
scaled_library_size = scaled.sum(axis=0)
log_cpm = np.log2(scaled / scaled_library_size.mean() * 1e6 + 1)
log_cpm_df = pd.DataFrame(log_cpm, index=counts.index, columns=counts.columns)
log_cpm_df.insert(0, "gene", log_cpm_df.index.astype(str))
log_cpm_df.to_csv(out("log_cpm.csv"), index=False)
message("log2(CPM + 1) after the size factor scaling on ", log_cpm.shape[0], " genes")

# ── PCA ───────────────────────────────────────────────────────────────────────
n_top = min(N_TOP_GENES_PCA, log_cpm.shape[0])
gene_variance = log_cpm.var(axis=1, ddof=1)
top_index = np.argsort(-gene_variance, kind="stable")[:n_top]
pca_input = log_cpm[top_index].T
pca = PCA(n_components=2, svd_solver="full")
scores = pca.fit_transform(pca_input)
percent_var = 100 * pca.explained_variance_ratio_
message("PCA on the top ", n_top, " variable genes: PC1 ", round(float(percent_var[0]), 1), "%, PC2 ", round(float(percent_var[1]), 1), "%")
pca_table = pd.DataFrame({"sample": list(counts.columns), "PC1": scores[:, 0], "PC2": scores[:, 1], "condition": condition.to_numpy()})
if has_batch:
    pca_table["batch"] = batch.to_numpy()
pca_table.to_csv(out("pca.csv"), index=False)

condition_colors = dict(zip(condition_levels, matplotlib.colormaps["viridis"](np.linspace(0, 0.8, len(condition_levels)))))
markers = ["o", "s", "^", "D", "v", "P", "X", "*"]
batch_markers = dict(zip(batch_levels, [markers[index % len(markers)] for index in range(len(batch_levels))]))
pca_figure, axis = plt.subplots()
for index, sample in enumerate(counts.columns):
    marker = batch_markers[batch.iloc[index]] if has_batch else "o"
    axis.scatter(scores[index, 0], scores[index, 1], s=40, color=condition_colors[condition.iloc[index]], marker=marker)
    axis.annotate(sample, (scores[index, 0], scores[index, 1]), fontsize=6, xytext=(0, 5), textcoords="offset points", ha="center")
handles = [Line2D([], [], linestyle="", marker="o", color=condition_colors[level], label=level) for level in condition_levels]
if has_batch:
    handles += [Line2D([], [], linestyle="", marker=batch_markers[level], color="grey", label=level) for level in batch_levels]
axis.legend(handles=handles, title="condition" + (" / batch" if has_batch else ""), fontsize=7)
axis.set_xlabel(f"PC1: {round(float(percent_var[0]))}% variance")
axis.set_ylabel(f"PC2: {round(float(percent_var[1]))}% variance")
axis.set_title(f"PCA of the samples, log2(CPM + 1), top {n_top} variable genes", fontsize=9)
save_figure(pca_figure, "pca")

# ── Sample distances ──────────────────────────────────────────────────────────
distances = pdist(log_cpm.T, metric="euclidean")
distance_matrix = pd.DataFrame(squareform(distances), index=counts.columns, columns=counts.columns)
sample_linkage = linkage(distances, method="complete")
annotation = pd.DataFrame({"condition": [condition_colors[level] for level in condition]}, index=counts.columns)
batch_colors = {}
if has_batch:
    batch_colors = dict(zip(batch_levels, matplotlib.colormaps["Set2"](np.linspace(0, 1, max(len(batch_levels), 2))[: len(batch_levels)])))
    annotation["batch"] = [batch_colors[level] for level in batch]
grid = sns.clustermap(
    distance_matrix,
    row_linkage=sample_linkage,
    col_linkage=sample_linkage,
    col_colors=annotation,
    cmap="mako_r",
    figsize=(6, 5),
    cbar_kws={"label": "distance"},
    xticklabels=True,
    yticklabels=True,
)
grid.ax_heatmap.tick_params(axis="both", labelsize=6)
patches = [Patch(color=condition_colors[level], label=level) for level in condition_levels]
if has_batch:
    patches += [Patch(color=batch_colors[level], label=level) for level in batch_levels]
grid.ax_col_dendrogram.legend(handles=patches, loc="upper left", fontsize=6, ncol=2, frameon=False)
grid.figure.suptitle("Euclidean sample distances (log2 CPM + 1)", fontsize=9)
grid.savefig(fig("sample_distances.png"), dpi=300)
grid.savefig(fig("sample_distances.pdf"))
plt.close(grid.figure)

# ── Library size figure ───────────────────────────────────────────────────────
bar_colors = ["#D55E00" if flag else "grey" for flag in library_table["low_depth"]]
positions = np.arange(library_table.shape[0])
library_figure, (axis_size, axis_genes) = plt.subplots(2, 1, sharex=True)
axis_size.bar(positions, library_table["library_size"], color=bar_colors)
axis_size.axhline(median_library_size / LOW_DEPTH_RATIO, linestyle="--", color="black", linewidth=0.8)
axis_size.set_ylabel("Library size (counts)", fontsize=8)
axis_genes.bar(positions, library_table["detected_genes"], color=bar_colors)
axis_genes.set_ylabel("Detected genes (count > 0)", fontsize=8)
axis_genes.set_xticks(positions)
axis_genes.set_xticklabels(library_table["sample"], rotation=60, ha="right", fontsize=7)
axis_size.set_title("Library size and detected genes per sample", fontsize=9)
library_figure.legend(
    handles=[Patch(color="grey", label="False"), Patch(color="#D55E00", label="True")],
    title=f"Below 1/{LOW_DEPTH_RATIO} of the median",
    loc="lower center",
    ncol=2,
    fontsize=7,
    title_fontsize=7,
    bbox_to_anchor=(0.5, -0.02),
)
save_figure(library_figure, "library_sizes", width=7, height=6)

# ── Summary ───────────────────────────────────────────────────────────────────
PACKAGES = ["pandas", "numpy", "scikit-learn", "scipy", "matplotlib", "seaborn"]


def package_version(name):
    try:
        return importlib_metadata.version(name)
    except importlib_metadata.PackageNotFoundError:
        return None


summary_record = {
    "template": "tpl-qc-python@1.0.0",
    "method": "Sample structure QC: log2(CPM + 1) after median-of-ratios scaling, PCA, sample distances, library sizes",
    "design": "~ 1",
    "inputs": {"counts": COUNTS_PATH, "metadata": METADATA_PATH},
    "condition_column": CONDITION_COLUMN,
    "batch_column": BATCH_COLUMN if has_batch else None,
    "n_samples": int(counts.shape[1]),
    "n_genes": int(counts.shape[0]),
    "group_sizes": {str(level): int(size) for level, size in condition.value_counts().sort_index().items()},
    "median_library_size": median_library_size,
    "low_depth_ratio": LOW_DEPTH_RATIO,
    "n_low_depth_samples": len(low_depth_samples),
    "low_depth_samples": low_depth_samples,
    "n_top_genes_pca": int(n_top),
    "percent_variance": {"PC1": round(float(percent_var[0]), 2), "PC2": round(float(percent_var[1]), 2)},
    "size_factors": {str(sample): round(float(value), 4) for sample, value in zip(counts.columns, size_factors)},
    "versions": {"python": platform.python_version(), **{name: package_version(name) for name in PACKAGES}},
}
with open(out("summary.json"), "w", encoding="utf-8") as handle:
    json.dump(summary_record, handle, indent=2)
with open(os.path.join("output", "session_info.txt"), "w", encoding="utf-8") as handle:
    handle.write(f"Python {platform.python_version()} on {platform.platform()}\n")
    for name in PACKAGES:
        handle.write(f"{name} {package_version(name) or 'not installed'}\n")
message("Done: ", out("summary.json"))
