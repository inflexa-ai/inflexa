#!/usr/bin/env python3
# tpl-decoupler-scores — decoupler ulm per-sample pathway scores with a t-test on the scores.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: a filter of the low count genes with the decoupler filter_by_expr,
# adapted from filterByExpr of edgeR (Chen et al. 2025), log2(CPM + 1) of the
# filtered counts, a decoupler univariate linear model (ulm) per gene set and
# per sample on the log-CPM values with the set membership as the weight, then
# a two-sample t-test per set between the two condition levels (scipy) and a
# Benjamini-Hochberg adjustment (statsmodels). The Python mirror of
# tpl-gsva-hallmark: the same slots where a t-test admits them, the same
# output names, and the same result columns.

import json
import os
import platform
import sys
from importlib.metadata import version as package_version

import anndata
import decoupler as dc
import matplotlib
import numpy as np
import pandas as pd

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import seaborn as sns  # noqa: E402
from matplotlib.patches import Patch  # noqa: E402
from scipy import stats  # noqa: E402
from statsmodels.stats.multitest import multipletests  # noqa: E402

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH = {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH = {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN = {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN = {{condition_column}}  # [adaptable: condition_column]
REFERENCE_LEVEL = {{reference_level}}  # [adaptable: reference_level]
TEST_LEVEL = {{test_level}}  # [adaptable: test_level]
GMT_PATH = {{gmt_path}}  # [adaptable: gmt_path]
MIN_COUNT = {{min_count}}  # [adaptable: min_count]
MIN_TOTAL_COUNT = {{min_total_count}}  # [adaptable: min_total_count]
MIN_SIZE = {{min_size}}  # [adaptable: min_size]
MAX_SIZE = {{max_size}}  # [adaptable: max_size]
N_TOP_SETS = {{n_top_sets}}  # [adaptable: n_top_sets]
OUTPUT_PREFIX = {{output_prefix}}  # [adaptable: output_prefix]
PADJ_CUTOFF = 0.05
SET_WEIGHT = 1.0
EQUAL_VARIANCE = True
CPM_SCALE = 1e6


def message(*parts):
    print("".join(str(part) for part in parts), file=sys.stderr, flush=True)


def fail(*parts):
    message("Error: ", *parts)
    sys.exit(1)


os.makedirs("output", exist_ok=True)
os.makedirs("figures", exist_ok=True)


def out(name):
    return os.path.join("output", f"{OUTPUT_PREFIX}_{name}")


def fig(name):
    return os.path.join("figures", f"{OUTPUT_PREFIX}_{name}")


def save_figure(figure, name):
    figure.savefig(fig(f"{name}.png"), dpi=300, bbox_inches="tight")
    figure.savefig(fig(f"{name}.pdf"), bbox_inches="tight")
    plt.close(figure)


if MIN_SIZE > MAX_SIZE:
    fail(f"min_size ({MIN_SIZE}) is larger than max_size ({MAX_SIZE})")

# ── Inputs ────────────────────────────────────────────────────────────────────
message("Reading counts from ", COUNTS_PATH)
if not os.path.exists(COUNTS_PATH):
    fail("The count matrix does not exist: ", COUNTS_PATH)
counts_df = pd.read_csv(COUNTS_PATH)
gene_ids = counts_df.iloc[:, 0].astype(str)
counts = counts_df.iloc[:, 1:].apply(pd.to_numeric, errors="coerce")
counts.index = gene_ids.to_numpy()
counts.columns = [str(column) for column in counts.columns]
values = counts.to_numpy(dtype=float)
if np.isnan(values).any() or (values < 0).any() or (np.abs(values - np.round(values)) > 1e-6).any():
    fail("The count matrix must hold non-negative integers. The log-CPM starts from raw counts, not TPM or FPKM.")
counts = pd.DataFrame(np.round(values), index=counts.index, columns=counts.columns)
if gene_ids.duplicated().any():
    fail("The count matrix holds duplicate gene identifiers")

message("Reading the sample table from ", METADATA_PATH)
if not os.path.exists(METADATA_PATH):
    fail("The sample table does not exist: ", METADATA_PATH)
metadata = pd.read_csv(METADATA_PATH)
if SAMPLE_ID_COLUMN not in metadata.columns:
    fail("The sample table has no column ", SAMPLE_ID_COLUMN)
if CONDITION_COLUMN not in metadata.columns:
    fail("The sample table has no column ", CONDITION_COLUMN)
metadata.index = metadata[SAMPLE_ID_COLUMN].astype(str).to_numpy()
missing = [sample for sample in counts.columns if sample not in metadata.index]
if missing:
    fail("Samples in the counts but not in the sample table: ", ", ".join(missing))
metadata = metadata.loc[counts.columns].copy()
metadata["condition"] = metadata[CONDITION_COLUMN].astype(str)
condition_levels = sorted(metadata["condition"].unique().tolist())
if REFERENCE_LEVEL not in condition_levels or TEST_LEVEL not in condition_levels:
    fail("The condition column holds ", ", ".join(condition_levels), " but not both ", REFERENCE_LEVEL, " and ", TEST_LEVEL)
group_sizes = metadata["condition"].value_counts().to_dict()
if min(group_sizes[REFERENCE_LEVEL], group_sizes[TEST_LEVEL]) < 2:
    fail("The t-test on the scores needs at least two samples in each of ", REFERENCE_LEVEL, " and ", TEST_LEVEL)
reference_samples = metadata.index[metadata["condition"] == REFERENCE_LEVEL].tolist()
test_samples = metadata.index[metadata["condition"] == TEST_LEVEL].tolist()
message("Samples: ", counts.shape[1], "; genes: ", counts.shape[0], "; test: two-sample t-test on the scores")
message("Condition levels: ", ", ".join(condition_levels), " (reference ", REFERENCE_LEVEL, ")")

message("Reading the gene sets from ", GMT_PATH)
if not os.path.exists(GMT_PATH):
    fail("The gene set file does not exist: ", GMT_PATH)
gene_sets = {}
with open(GMT_PATH, encoding="utf-8") as handle:
    for line in handle:
        if not line.strip():
            continue
        fields = line.rstrip("\r\n").split("\t")
        name = fields[0]
        if name in gene_sets:
            fail("The gene set file holds a duplicate set name: ", name)
        gene_sets[name] = list(dict.fromkeys(gene for gene in fields[2:] if gene))
if len(gene_sets) == 0:
    fail("The gene set file holds no gene set: ", GMT_PATH)
DATABASE = os.path.basename(GMT_PATH)
message("Gene sets: ", len(gene_sets), " in ", DATABASE)

# ── Filter and log-CPM ────────────────────────────────────────────────────────
adata = anndata.AnnData(
    X=counts.T.to_numpy(dtype=float),
    obs=metadata[["condition"]].copy(),
    var=pd.DataFrame(index=counts.index),
)
kept_genes = dc.pp.filter_by_expr(adata, group="condition", min_count=MIN_COUNT, min_total_count=MIN_TOTAL_COUNT, inplace=False)
kept_genes = [str(gene) for gene in kept_genes]
message("filter_by_expr with min_count ", MIN_COUNT, " and min_total_count ", MIN_TOTAL_COUNT, ": ", len(kept_genes), " of ", counts.shape[0], " genes kept")
if len(kept_genes) == 0:
    fail("No gene passes the filter")
filtered = counts.loc[kept_genes]
library_sizes = filtered.sum(axis=0)
if (library_sizes <= 0).any():
    fail("A sample has no counts after the filter: ", ", ".join(library_sizes.index[library_sizes <= 0]))
message("Library sizes after the filter: ", ", ".join(f"{sample}={int(size)}" for sample, size in library_sizes.items()))
log_cpm = np.log2(filtered.div(library_sizes, axis=1) * CPM_SCALE + 1.0).T

# ── Network from the GMT ──────────────────────────────────────────────────────
network = pd.DataFrame(
    {
        "source": [name for name, members in gene_sets.items() for _gene in members],
        "target": [gene for members in gene_sets.values() for gene in members],
    }
)
network["weight"] = SET_WEIGHT
set_genes = set(network["target"])
n_in_sets = int(sum(1 for gene in log_cpm.columns if gene in set_genes))
if n_in_sets == 0:
    fail("No filtered gene is a member of a gene set. The gene identifiers of the count matrix and of the GMT file do not match.")
message("Filtered genes: ", log_cpm.shape[1], "; in at least one gene set: ", n_in_sets)

network = network[network["target"].isin(log_cpm.columns)]
set_sizes = network.groupby("source").size()
in_window = set_sizes[(set_sizes >= MIN_SIZE) & (set_sizes <= MAX_SIZE)].index
network = network[network["source"].isin(in_window)].reset_index(drop=True)
if len(network) == 0:
    fail("No gene set has between ", MIN_SIZE, " and ", MAX_SIZE, " members among the filtered genes")

# ── decoupler ulm scores ──────────────────────────────────────────────────────
message("decoupler ulm on log2(CPM + 1), sets with ", MIN_SIZE, " to ", MAX_SIZE, " members")
estimates, _ulm_pvalues = dc.mt.ulm(log_cpm, network, tmin=MIN_SIZE, verbose=False)
scores = estimates.T.loc[:, log_cpm.index]
if scores.shape[0] == 0:
    fail("decoupler ulm gave no score")
scores.index = [str(name) for name in scores.index]
scores.columns = [str(sample) for sample in scores.columns]
set_sizes = set_sizes.loc[scores.index]
message("Scored ", scores.shape[0], " of ", len(gene_sets), " sets in ", scores.shape[1], " samples")
scores_table = scores.copy()
scores_table.insert(0, "pathway", scores.index)
scores_table.to_csv(out("scores.csv"), index=False)

# ── t-test on the scores ──────────────────────────────────────────────────────
test_scores = scores[test_samples].to_numpy(dtype=float)
reference_scores = scores[reference_samples].to_numpy(dtype=float)
t_test = stats.ttest_ind(test_scores, reference_scores, axis=1, equal_var=EQUAL_VARIANCE)
pvalue = np.asarray(t_test.pvalue, dtype=float)
statistic = np.asarray(t_test.statistic, dtype=float)
padj = np.full(pvalue.shape, np.nan)
finite = np.isfinite(pvalue)
if finite.any():
    padj[finite] = multipletests(pvalue[finite], method="fdr_bh")[1]
results_table = pd.DataFrame(
    {
        "pathway": scores.index.to_numpy(),
        "log_fold_change_score": test_scores.mean(axis=1) - reference_scores.mean(axis=1),
        "t": statistic,
        "pvalue": pvalue,
        "padj": padj,
        "size": set_sizes.to_numpy(dtype=int),
    }
)
results_table = results_table.sort_values(["padj", "pvalue"], kind="stable", na_position="last").reset_index(drop=True)
results_table.to_csv(out("results.csv"), index=False)

n_tested = len(results_table)
significant_mask = results_table["padj"].notna() & (results_table["padj"] < PADJ_CUTOFF)
n_significant = int(significant_mask.sum())
n_up = int((significant_mask & (results_table["log_fold_change_score"] > 0)).sum())
n_down = n_significant - n_up
message("Tested ", n_tested, " sets with a t-test on the scores; ", n_significant, " at padj < ", PADJ_CUTOFF, " (", n_up, " up, ", n_down, " down in ", TEST_LEVEL, ")")

# ── Figures ───────────────────────────────────────────────────────────────────
top_sets = results_table[results_table["padj"].notna()].head(N_TOP_SETS)
heatmap_matrix = scores.loc[top_sets["pathway"].tolist()]
heatmap_height = max(4.0, 0.18 * heatmap_matrix.shape[0] + 2)
heatmap_width = max(6.0, 0.3 * heatmap_matrix.shape[1] + 4)
palette = dict(zip(condition_levels, sns.color_palette("Set2", len(condition_levels))))
column_colors = pd.Series([palette[level] for level in metadata.loc[heatmap_matrix.columns, "condition"]], index=heatmap_matrix.columns, name="condition")
cluster_columns = heatmap_matrix.shape[1] > 2
grid = sns.clustermap(
    heatmap_matrix,
    row_cluster=False,
    col_cluster=cluster_columns,
    col_colors=column_colors,
    cmap="RdBu_r",
    center=0,
    figsize=(heatmap_width, heatmap_height),
    yticklabels=True,
    xticklabels=True,
    cbar_kws={"label": "ulm score"},
)
grid.ax_heatmap.tick_params(axis="y", labelsize=6)
grid.ax_heatmap.tick_params(axis="x", labelsize=7)
grid.ax_heatmap.set_xlabel("")
grid.ax_heatmap.set_ylabel("")
grid.ax_col_dendrogram.legend(
    handles=[Patch(color=color, label=level) for level, color in palette.items()],
    title="condition",
    loc="upper left",
    bbox_to_anchor=(1.02, 1.0),
    fontsize=7,
    title_fontsize=7,
)
grid.figure.suptitle(f"ulm scores of the top {heatmap_matrix.shape[0]} sets by adjusted p-value", y=1.02)
save_figure(grid.figure, "score_heatmap")

difference_table = top_sets.sort_values("log_fold_change_score", kind="stable")
significant_top = (difference_table["padj"] < PADJ_CUTOFF).to_numpy()
height = max(4.0, 0.25 * len(difference_table) + 1.5)
figure, axis = plt.subplots(figsize=(8, height))
colors = ["#21908C" if flag else "#999999" for flag in significant_top]
axis.barh(np.arange(len(difference_table)), difference_table["log_fold_change_score"], color=colors)
axis.axvline(0, linestyle="--", color="grey")
axis.set_yticks(np.arange(len(difference_table)))
axis.set_yticklabels(difference_table["pathway"], fontsize=7)
axis.set_xlabel(f"ulm score difference: {TEST_LEVEL} minus {REFERENCE_LEVEL}")
axis.set_title(f"Top {len(difference_table)} gene sets by adjusted p-value")
axis.legend(
    handles=[Patch(color="#21908C", label="TRUE"), Patch(color="#999999", label="FALSE")],
    title=f"padj < {PADJ_CUTOFF}",
    loc="lower right",
    fontsize=7,
    title_fontsize=7,
)
for side in ("top", "right"):
    axis.spines[side].set_visible(False)
save_figure(figure, "score_difference")

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record = {
    "template": "tpl-decoupler-scores@1.0.0",
    "method": "decoupler ulm scores with a two-sample t-test on the score matrix",
    "inputs": {"counts_path": COUNTS_PATH, "metadata_path": METADATA_PATH, "gmt_path": GMT_PATH},
    "database": DATABASE,
    "contrast": {"factor": "condition", "test": TEST_LEVEL, "reference": REFERENCE_LEVEL},
    "test": "two-sample t-test, equal variance" if EQUAL_VARIANCE else "two-sample t-test, Welch",
    "n_samples": int(counts.shape[1]),
    "group_sizes": {level: int(size) for level, size in group_sizes.items()},
    "n_genes_input": int(counts.shape[0]),
    "n_genes_after_filter": int(log_cpm.shape[1]),
    "n_genes_in_sets": n_in_sets,
    "n_sets_input": len(gene_sets),
    "n_sets_scored": int(scores.shape[0]),
    "n_sets_tested": n_tested,
    "n_significant": n_significant,
    "n_up": n_up,
    "n_down": n_down,
    "padj_cutoff": PADJ_CUTOFF,
    "set_weight": SET_WEIGHT,
    "min_size": MIN_SIZE,
    "max_size": MAX_SIZE,
    "min_count": MIN_COUNT,
    "min_total_count": MIN_TOTAL_COUNT,
    "versions": {
        "python": platform.python_version(),
        "decoupler": package_version("decoupler"),
        "anndata": package_version("anndata"),
        "pandas": package_version("pandas"),
        "numpy": package_version("numpy"),
        "scipy": package_version("scipy"),
        "statsmodels": package_version("statsmodels"),
        "matplotlib": package_version("matplotlib"),
        "seaborn": package_version("seaborn"),
    },
}
with open(out("summary.json"), "w", encoding="utf-8") as handle:
    json.dump(summary_record, handle, indent=2)
with open(os.path.join("output", "session_info.txt"), "w", encoding="utf-8") as handle:
    handle.write(f"Python {sys.version}\n")
    for name, version in summary_record["versions"].items():
        if name != "python":
            handle.write(f"{name} {version}\n")
message("Done: ", out("results.csv"))
