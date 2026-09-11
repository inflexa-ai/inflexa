#!/usr/bin/env python3
# tpl-decoupler-py-tf-activity — transcription factor activity with decoupler on
# the CollecTRI regulons, from a contrast and per sample.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: a signed regulon network (source, target, weight = mode of
# regulation). The gene-level statistic of the contrast is the pydeseq2 Wald
# statistic of the test level against the reference level, or the `stat`
# column of a given results table. The decoupler univariate linear model (ulm)
# regresses the statistic on the signed target weights of each regulator; the
# t-value of the slope is the activity score, its two-sided p-value comes from
# the t distribution with n_genes - 2 degrees of freedom, and Benjamini-Hochberg
# (statsmodels) adjusts the p-values across the regulators. The same model on
# log2(CPM + 1) of the filtered counts gives one score per regulator and sample
# (Badia-i-Mompel et al. 2022; Müller-Dott et al. 2023). The Python mirror of
# tpl-decoupler-tf-activity.

import json
import os
import platform
import sys
from importlib.metadata import version as package_version

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
RESULTS_PATH = {{results_path}}  # [adaptable: results_path] absent: fit pydeseq2 on the counts for the contrast statistic
NETWORK_PATH = {{network_path}}  # [adaptable: network_path]
REGULON_COLLECTION = {{regulon_collection}}  # [adaptable: regulon_collection]
ACTIVITY_METHOD = {{activity_method}}
MIN_REGULON_SIZE = {{min_regulon_size}}  # [adaptable: min_regulon_size]
MIN_COUNT = {{min_count}}  # [adaptable: min_count]
ALPHA = {{alpha}}
N_TOP_REGULATORS = {{n_top_regulators}}  # [adaptable: n_top_regulators]
OUTPUT_PREFIX = {{output_prefix}}  # [adaptable: output_prefix]
CPM_SCALE = 1e6
DESIGN = "~ condition"


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


if ACTIVITY_METHOD != "ulm":
    fail("The Python path pins the ulm estimator; activity_method is ", ACTIVITY_METHOD)


def run_activity(data, network):
    """The decoupler ulm scores: one t-value per observation (row of data) and regulator with at least MIN_REGULON_SIZE targets."""
    estimates, _adjusted = dc.mt.ulm(data, network, tmin=MIN_REGULON_SIZE, verbose=False)
    estimates.columns = [str(name) for name in estimates.columns]
    return estimates


# ── Inputs ────────────────────────────────────────────────────────────────────
message("Reading counts from ", COUNTS_PATH)
if not os.path.exists(COUNTS_PATH):
    fail("The count matrix does not exist: ", COUNTS_PATH)
counts_df = pd.read_csv(COUNTS_PATH)
gene_ids = counts_df.iloc[:, 0].astype(str)
if gene_ids.duplicated().any():
    fail("The count matrix holds duplicate gene identifiers")
counts = counts_df.iloc[:, 1:].apply(pd.to_numeric, errors="coerce")
counts.index = gene_ids.to_numpy()
counts.columns = [str(column) for column in counts.columns]
values = counts.to_numpy(dtype=float)
if np.isnan(values).any() or (values < 0).any() or (np.abs(values - np.round(values)) > 1e-6).any():
    fail("The count matrix must hold non-negative integers. pydeseq2 takes raw counts, not TPM or FPKM.")
counts = pd.DataFrame(np.round(values).astype(int), index=counts.index, columns=counts.columns)

message("Reading the sample table from ", METADATA_PATH)
if not os.path.exists(METADATA_PATH):
    fail("The sample table does not exist: ", METADATA_PATH)
sample_table = pd.read_csv(METADATA_PATH)
if SAMPLE_ID_COLUMN not in sample_table.columns:
    fail("The sample table has no column ", SAMPLE_ID_COLUMN)
if CONDITION_COLUMN not in sample_table.columns:
    fail("The sample table has no column ", CONDITION_COLUMN)
sample_table.index = sample_table[SAMPLE_ID_COLUMN].astype(str).to_numpy()
missing = [sample for sample in counts.columns if sample not in sample_table.index]
if missing:
    fail("Samples in the counts but not in the sample table: ", ", ".join(missing))
sample_table = sample_table.loc[counts.columns].copy()
condition_values = sample_table[CONDITION_COLUMN].astype(str)
condition_levels = sorted(condition_values.unique().tolist())
if REFERENCE_LEVEL not in condition_levels or TEST_LEVEL not in condition_levels:
    fail("The condition column holds ", ", ".join(condition_levels), " but not both ", REFERENCE_LEVEL, " and ", TEST_LEVEL)
# The first category is the reference level of the design matrix, as relevel() in R.
condition_levels = [REFERENCE_LEVEL] + [level for level in condition_levels if level != REFERENCE_LEVEL]
metadata = pd.DataFrame(index=sample_table.index)
metadata["condition"] = pd.Categorical(condition_values.to_numpy(), categories=condition_levels)
message("Samples: ", counts.shape[1], "; genes: ", counts.shape[0])
message("Condition levels: ", ", ".join(condition_levels), " (reference ", REFERENCE_LEVEL, ")")

message("Reading the regulon network from ", NETWORK_PATH)
if not os.path.exists(NETWORK_PATH):
    fail("The network file does not exist: ", NETWORK_PATH)
network_df = pd.read_csv(NETWORK_PATH)
for column in ("source", "target", "weight"):
    if column not in network_df.columns:
        fail("The network has no column ", column, "; it needs source, target, and weight")
network = pd.DataFrame(
    {
        "source": network_df["source"].astype(str),
        "target": network_df["target"].astype(str),
        "weight": pd.to_numeric(network_df["weight"], errors="coerce"),
    }
)
network = network[network["weight"].notna() & (network["weight"] != 0)]
network = network.drop_duplicates(subset=["source", "target"], keep="first").reset_index(drop=True)
if len(network) == 0:
    fail("The network holds no edge with a non-zero weight")
network_targets = set(network["target"])
n_regulators_network = int(network["source"].nunique())
message("Network ", REGULON_COLLECTION, ": ", len(network), " edges, ", n_regulators_network, " regulators, ", len(network_targets), " targets")
network_overlap = int(sum(1 for gene in gene_ids if gene in network_targets))
message("Network targets among the genes of the counts: ", network_overlap, " of ", len(network_targets))
if network_overlap == 0:
    fail("No target of the network is among the gene identifiers of the counts; the identifier spaces do not match")

# ── Filter ────────────────────────────────────────────────────────────────────
group_sizes = metadata["condition"].value_counts().to_dict()
min_samples = int(min(group_sizes.values()))
keep = (counts >= MIN_COUNT).sum(axis=1) >= min_samples
message("Low count filter: keep genes with >= ", MIN_COUNT, " counts in >= ", min_samples, " samples: ", int(keep.sum()), " of ", counts.shape[0], " kept")
if int(keep.sum()) == 0:
    fail("No gene passes the filter")
counts = counts.loc[keep]

# ── Contrast statistic ────────────────────────────────────────────────────────
if RESULTS_PATH is None:
    from pydeseq2.dds import DeseqDataSet
    from pydeseq2.ds import DeseqStats

    if min(group_sizes[REFERENCE_LEVEL], group_sizes[TEST_LEVEL]) < 2:
        fail("The pydeseq2 Wald test needs at least two samples in each of ", REFERENCE_LEVEL, " and ", TEST_LEVEL)
    message("Fitting pydeseq2 Wald: ", TEST_LEVEL, " vs ", REFERENCE_LEVEL)
    dds = DeseqDataSet(counts=counts.T, metadata=metadata, design=DESIGN, quiet=True)
    dds.deseq2()
    coefficient = f"condition[T.{TEST_LEVEL}]"
    if coefficient not in dds.varm["LFC"].columns:
        fail("The coefficient ", coefficient, " is not in the LFC columns: ", ", ".join(dds.varm["LFC"].columns))
    stat_res = DeseqStats(dds, contrast=["condition", TEST_LEVEL, REFERENCE_LEVEL], alpha=ALPHA, quiet=True)
    stat_res.summary()
    wald = stat_res.results_df
    contrast_stat = pd.Series(wald["stat"].to_numpy(dtype=float), index=wald.index.astype(str))
    statistic_source = "pydeseq2_wald"
else:
    message("Reading the contrast statistic from ", RESULTS_PATH)
    if not os.path.exists(RESULTS_PATH):
        fail("The results table does not exist: ", RESULTS_PATH)
    results_df = pd.read_csv(RESULTS_PATH)
    for column in ("gene", "stat"):
        if column not in results_df.columns:
            fail("The results table has no column ", column, "; it needs gene and stat")
    results_df = results_df[~results_df["gene"].astype(str).duplicated(keep="first")]
    contrast_stat = pd.Series(pd.to_numeric(results_df["stat"], errors="coerce").to_numpy(dtype=float), index=results_df["gene"].astype(str).to_numpy())
    statistic_source = "results_table"
contrast_stat = contrast_stat[np.isfinite(contrast_stat.to_numpy())]
if len(contrast_stat) == 0:
    fail("No gene has a finite contrast statistic")
message("Genes with a finite contrast statistic: ", len(contrast_stat))

# ── Regulator activity on the contrast ────────────────────────────────────────
tested_edges = network[network["target"].isin(contrast_stat.index)]
n_targets = tested_edges.groupby("source").size()
contrast_matrix = pd.DataFrame([contrast_stat.to_numpy()], index=["contrast"], columns=contrast_stat.index)
message("Running decoupler ", ACTIVITY_METHOD, " on the contrast statistic with tmin ", MIN_REGULON_SIZE)
contrast_estimates = run_activity(contrast_matrix, network)
if contrast_estimates.shape[1] == 0:
    fail("No regulator has at least ", MIN_REGULON_SIZE, " targets among the tested genes")
score = contrast_estimates.iloc[0]
# decoupler returns the Benjamini-Hochberg adjusted p-value only. The raw two-sided
# p-value of the slope comes from the t distribution with n_genes - 2 degrees of
# freedom (the ulm fits an intercept and a slope over every gene of the matrix),
# and the adjustment across the tested regulators is done here with statsmodels.
pvalue = 2.0 * stats.t.sf(np.abs(score.to_numpy(dtype=float)), df=len(contrast_stat) - 2)
padj = np.full(pvalue.shape, np.nan)
finite = np.isfinite(pvalue)
if finite.any():
    padj[finite] = multipletests(pvalue[finite], method="fdr_bh")[1]
activity_table = pd.DataFrame(
    {
        "regulator": score.index.to_numpy(),
        "score": score.to_numpy(dtype=float),
        "pvalue": pvalue,
        "padj": padj,
        "n_targets": n_targets.reindex(score.index).fillna(0).astype(int).to_numpy(),
    }
)
activity_table = activity_table.sort_values("pvalue", kind="stable", na_position="last").reset_index(drop=True)
activity_table.to_csv(out("activity.csv"), index=False)

n_regulators_tested = int(len(activity_table))
significant_mask = activity_table["padj"].notna() & (activity_table["padj"] < ALPHA)
n_significant = int(significant_mask.sum())
n_up = int((significant_mask & (activity_table["score"] > 0)).sum())
n_down = n_significant - n_up
message("Tested ", n_regulators_tested, " regulators; ", n_significant, " at padj < ", ALPHA, " (", n_up, " up, ", n_down, " down)")

# ── Per-sample scores on the log-CPM matrix ───────────────────────────────────
library_sizes = counts.sum(axis=0)
if (library_sizes <= 0).any():
    fail("A sample has no counts after the filter: ", ", ".join(library_sizes.index[library_sizes <= 0]))
log_cpm = np.log2(counts.div(library_sizes, axis=1) * CPM_SCALE + 1.0).T
message("Running decoupler ", ACTIVITY_METHOD, " on log2(CPM + 1) for the per-sample scores")
sample_estimates = run_activity(log_cpm, network)
if sample_estimates.shape[1] == 0:
    fail("No regulator has at least ", MIN_REGULON_SIZE, " targets among the filtered genes")
score_matrix = sample_estimates.T.loc[:, log_cpm.index].sort_index()
score_matrix.columns = [str(sample) for sample in score_matrix.columns]
scores_table = score_matrix.copy()
scores_table.insert(0, "regulator", score_matrix.index)
scores_table.to_csv(out("scores.csv"), index=False)

# ── Figures ───────────────────────────────────────────────────────────────────
top = activity_table.sort_values(["padj", "pvalue"], kind="stable", na_position="last").head(N_TOP_REGULATORS)
bar_table = top.iloc[::-1]
significant_top = (bar_table["padj"].fillna(1.0) < ALPHA).to_numpy()
figure, axis = plt.subplots(figsize=(6, 6))
colors = ["#21908C" if flag else "#999999" for flag in significant_top]
axis.barh(np.arange(len(bar_table)), bar_table["score"], color=colors)
axis.axvline(0, linestyle="--", color="black", linewidth=0.8)
axis.set_yticks(np.arange(len(bar_table)))
axis.set_yticklabels(bar_table["regulator"], fontsize=7)
axis.set_xlabel(f"Activity score ({ACTIVITY_METHOD} t-value)")
axis.set_title(f"Top regulators: {TEST_LEVEL} vs {REFERENCE_LEVEL}")
axis.legend(
    handles=[Patch(color="#21908C", label="TRUE"), Patch(color="#999999", label="FALSE")],
    title=f"padj < {ALPHA}",
    loc="lower right",
    fontsize=7,
    title_fontsize=7,
)
for side in ("top", "right"):
    axis.spines[side].set_visible(False)
save_figure(figure, "top_regulators")

heatmap_regulators = [regulator for regulator in activity_table["regulator"].head(N_TOP_REGULATORS) if regulator in score_matrix.index]
heatmap_matrix = score_matrix.loc[heatmap_regulators]
heatmap_matrix = heatmap_matrix[np.isfinite(heatmap_matrix.to_numpy()).all(axis=1) & (heatmap_matrix.std(axis=1, ddof=1) > 0).to_numpy()]
if heatmap_matrix.shape[0] == 0:
    fail("No top regulator has a finite per-sample score with a non-zero spread for the heatmap")
palette = dict(zip(condition_levels, sns.color_palette("Set2", len(condition_levels))))
column_colors = pd.Series([palette[level] for level in metadata.loc[heatmap_matrix.columns, "condition"].astype(str)], index=heatmap_matrix.columns, name="condition")
grid = sns.clustermap(
    heatmap_matrix,
    z_score=0,
    row_cluster=heatmap_matrix.shape[0] > 1,
    col_cluster=heatmap_matrix.shape[1] > 2,
    col_colors=column_colors,
    cmap="RdBu_r",
    center=0,
    figsize=(6, 6),
    yticklabels=True,
    xticklabels=True,
    cbar_kws={"label": "row z-score"},
)
grid.ax_heatmap.tick_params(axis="y", labelsize=7)
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
grid.figure.suptitle(f"Per-sample {ACTIVITY_METHOD} scores, top regulators (row scaled)", y=1.02)
save_figure(grid.figure, "score_heatmap")

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record = {
    "template": "tpl-decoupler-py-tf-activity@1.0.0",
    "method": f"decoupler {ACTIVITY_METHOD}",
    "activity_method": ACTIVITY_METHOD,
    "contrast": {"factor": "condition", "test": TEST_LEVEL, "reference": REFERENCE_LEVEL},
    "design": DESIGN,
    "statistic_source": statistic_source,
    "network": {
        "name": REGULON_COLLECTION,
        "path": NETWORK_PATH,
        "n_edges": int(len(network)),
        "n_regulators": n_regulators_network,
        "n_targets_in_counts": network_overlap,
    },
    "min_regulon_size": MIN_REGULON_SIZE,
    "n_samples": int(counts.shape[1]),
    "group_sizes": {str(level): int(size) for level, size in group_sizes.items()},
    "n_genes_input": int(len(gene_ids)),
    "n_genes_after_filter": int(counts.shape[0]),
    "n_genes_with_statistic": int(len(contrast_stat)),
    "n_regulators_tested": n_regulators_tested,
    "n_significant": n_significant,
    "n_up": n_up,
    "n_down": n_down,
    "alpha": ALPHA,
    "adjustment": "BH",
    "min_count": MIN_COUNT,
    "per_sample_input": "log_cpm",
    "n_regulators_scored_per_sample": int(score_matrix.shape[0]),
    "versions": {
        "python": platform.python_version(),
        "decoupler": package_version("decoupler"),
        "pydeseq2": package_version("pydeseq2"),
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
message("Done: ", out("activity.csv"))
