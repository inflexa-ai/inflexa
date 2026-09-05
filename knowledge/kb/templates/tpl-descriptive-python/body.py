#!/usr/bin/env python3
# tpl-descriptive-python — descriptive log2 fold changes, no inferential test.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: at least one group holds one sample, thus no within-group dispersion
# can be estimated and a p-value has no inferential basis (DESeq2 vignette,
# "Experiments without replicates"; Schurch et al. 2016). The script normalizes
# the counts (DESeq2 median-of-ratios size factors computed in numpy, or CPM),
# keeps the genes with enough counts in every sample, and reports per gene the
# log2 ratio of the group means with a pseudocount. No p-value, no adjusted
# p-value.

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

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH      = {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH    = {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN = {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN = {{condition_column}}  # [adaptable: condition_column]
REFERENCE_LEVEL  = {{reference_level}}  # [adaptable: reference_level]
TEST_LEVEL       = {{test_level}}  # [adaptable: test_level]
NORMALIZATION    = {{normalization}}  # [adaptable: normalization]
MIN_COUNT        = {{min_count}}  # [adaptable: min_count]
PSEUDOCOUNT      = {{pseudocount}}  # [adaptable: pseudocount]
N_TOP_LABELS     = {{n_top_labels}}  # [adaptable: n_top_labels]
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
gene_ids = counts_df.iloc[:, 0].astype(str)
counts = counts_df.iloc[:, 1:].copy()
counts.index = gene_ids
counts = counts.apply(pd.to_numeric, errors="coerce")
if counts.isna().any().any() or (counts < 0).any().any() or ((counts - counts.round()).abs() > 1e-6).any().any():
    sys.exit("The count matrix must hold non-negative integers. The script takes raw counts, not TPM or FPKM.")
counts = counts.round().astype(float)

message("Reading the sample table from ", METADATA_PATH)
sample_table = pd.read_csv(METADATA_PATH)
if SAMPLE_ID_COLUMN not in sample_table.columns:
    sys.exit(f"The sample table has no column {SAMPLE_ID_COLUMN}")
if CONDITION_COLUMN not in sample_table.columns:
    sys.exit(f"The sample table has no column {CONDITION_COLUMN}")
sample_table.index = sample_table[SAMPLE_ID_COLUMN].astype(str)
missing = [sample for sample in counts.columns if sample not in sample_table.index]
if missing:
    sys.exit("Samples in the counts but not in the sample table: " + ", ".join(missing))
sample_table = sample_table.loc[list(counts.columns)]
condition_values = sample_table[CONDITION_COLUMN].astype(str)
levels = sorted(set(condition_values))
if REFERENCE_LEVEL not in levels or TEST_LEVEL not in levels:
    sys.exit(f"The condition column holds {', '.join(levels)} but not both {REFERENCE_LEVEL} and {TEST_LEVEL}")
reference_samples = [sample for sample in counts.columns if condition_values[sample] == REFERENCE_LEVEL]
test_samples = [sample for sample in counts.columns if condition_values[sample] == TEST_LEVEL]
group_sizes = {REFERENCE_LEVEL: len(reference_samples), TEST_LEVEL: len(test_samples)}
message("Samples: ", counts.shape[1], "; genes: ", counts.shape[0])
message("Group sizes: ", ", ".join(f"{level}={size}" for level, size in group_sizes.items()))
if min(group_sizes.values()) >= 2:
    sys.exit("Every group holds at least two samples. This template is for a design without replication; use an inferential method instead.")
message("At least one group holds one sample: no dispersion can be estimated, thus the script does no inferential test.")

# ── Normalize ─────────────────────────────────────────────────────────────────
# The full matrix gives the size factors, thus the filter does not move them.
count_matrix = counts.to_numpy(dtype=float)
if NORMALIZATION == "median_of_ratios":
    # DESeq2 estimateSizeFactorsForMatrix: the geometric mean per gene over the
    # samples, then the median per sample of the ratio to that mean, over the
    # genes with a positive count in every sample (Anders and Huber 2010).
    with np.errstate(divide="ignore"):
        log_counts = np.log(count_matrix)
    log_geometric_means = log_counts.mean(axis=1)
    finite = np.isfinite(log_geometric_means)
    if not finite.any():
        sys.exit("No gene has a positive count in every sample; the median-of-ratios size factors cannot be estimated. Use normalization cpm.")
    log_ratios = log_counts[finite] - log_geometric_means[finite][:, None]
    size_factor_values = np.exp(np.median(log_ratios, axis=0))
    size_factors = pd.Series(size_factor_values, index=counts.columns)
    normalized_all = counts / size_factors
    message("Median-of-ratios size factors (numpy): ", ", ".join(f"{sample}={value:.3f}" for sample, value in size_factors.items()))
elif NORMALIZATION == "cpm":
    library_sizes = counts.sum(axis=0)
    size_factors = library_sizes / 1e6
    normalized_all = counts / size_factors
    message("Counts per million by library size: ", ", ".join(f"{sample}={value:.0f}" for sample, value in library_sizes.items()))
else:
    sys.exit(f"Unknown normalization {NORMALIZATION}; use median_of_ratios or cpm")
normalized_out = normalized_all.copy()
normalized_out.insert(0, "gene", normalized_out.index.astype(str))
normalized_out.to_csv(out("normalized_counts.csv"), index=False, na_rep="NA")

# ── Filter ────────────────────────────────────────────────────────────────────
keep = (counts >= MIN_COUNT).all(axis=1)
message("Low count filter: keep genes with >= ", MIN_COUNT, " raw counts in every sample: ", int(keep.sum()), " of ", counts.shape[0], " kept")
if int(keep.sum()) == 0:
    sys.exit("No gene passes the low count filter; lower min_count")
normalized = normalized_all.loc[keep]

# ── Descriptive fold change ───────────────────────────────────────────────────
reference_mean = normalized[reference_samples].mean(axis=1)
test_mean = normalized[test_samples].mean(axis=1)
log2_fold_change = np.log2((test_mean + PSEUDOCOUNT) / (reference_mean + PSEUDOCOUNT))
base_mean = normalized.mean(axis=1)

results_table = pd.DataFrame(
    {
        "gene": normalized.index.astype(str),
        "base_mean": base_mean.to_numpy(),
        "log2_fold_change": log2_fold_change.to_numpy(),
    }
)
for sample in normalized.columns:
    results_table[f"normalized_{sample}"] = normalized[sample].to_numpy()
results_table = results_table.iloc[np.argsort(-results_table["log2_fold_change"].abs().to_numpy(), kind="stable")]
results_table = results_table.reset_index(drop=True)
results_table.to_csv(out("results.csv"), index=False, na_rep="NA")

n_up_2fold = int((results_table["log2_fold_change"] >= 1).sum())
n_down_2fold = int((results_table["log2_fold_change"] <= -1).sum())
message("Reported ", results_table.shape[0], " genes; ", n_up_2fold, " with log2 fold change >= 1 and ", n_down_2fold, " with <= -1 (descriptive, no test)")

# ── Figures ───────────────────────────────────────────────────────────────────
top_labels = results_table.head(N_TOP_LABELS)
ma_figure, axis = plt.subplots()
axis.scatter(results_table["base_mean"], results_table["log2_fold_change"], s=3, alpha=0.5, color="grey", linewidths=0)
axis.scatter(top_labels["base_mean"], top_labels["log2_fold_change"], s=8, color="#440154", linewidths=0)
for _, row in top_labels.iterrows():
    axis.annotate(row["gene"], (row["base_mean"], row["log2_fold_change"]), fontsize=6, xytext=(0, 4), textcoords="offset points", ha="center")
axis.set_xscale("log")
axis.axhline(0, linestyle="--", color="black", linewidth=0.8)
for y in (-1, 1):
    axis.axhline(y, linestyle=":", color="grey", linewidth=0.8)
axis.set_xlabel("Mean of normalized counts")
axis.set_ylabel(f"log2 fold change (pseudocount {PSEUDOCOUNT})")
axis.set_title(f"MA-style plot: {TEST_LEVEL} vs {REFERENCE_LEVEL}, no replication, no test", fontsize=9)
save_figure(ma_figure, "ma")

scatter_reference = np.log2(reference_mean + PSEUDOCOUNT)
scatter_test = np.log2(test_mean + PSEUDOCOUNT)
scatter_figure, axis = plt.subplots()
axis.scatter(scatter_reference, scatter_test, s=3, alpha=0.5, color="grey", linewidths=0)
axis.axline((0, 0), slope=1, linestyle="--", color="black", linewidth=0.8)
for intercept in (-1, 1):
    axis.axline((0, intercept), slope=1, linestyle=":", color="grey", linewidth=0.8)
axis.set_xlabel(f"log2 normalized counts, {REFERENCE_LEVEL}")
axis.set_ylabel(f"log2 normalized counts, {TEST_LEVEL}")
axis.set_title("Sample scatter, genes that pass the filter")
save_figure(scatter_figure, "sample_scatter")

# ── Summary ───────────────────────────────────────────────────────────────────
PACKAGES = ["numpy", "pandas", "matplotlib"]


def package_version(name):
    try:
        return importlib_metadata.version(name)
    except importlib_metadata.PackageNotFoundError:
        return None


summary_record = {
    "template": "tpl-descriptive-python@1.0.0",
    "method": "Descriptive log2 fold change, no inferential test",
    "contrast": {"factor": "condition", "test": TEST_LEVEL, "reference": REFERENCE_LEVEL},
    "n_samples": int(counts.shape[1]),
    "group_sizes": {str(level): int(size) for level, size in group_sizes.items()},
    "replication": {
        "has_replication": False,
        "n_per_group_min": int(min(group_sizes.values())),
        "statement": (
            "The design has no replication: at least one group holds one sample. "
            "No within-group dispersion can be estimated, thus no p-value and no adjusted p-value are reported. "
            "The log2 fold changes are descriptive. A design with at least three, better six, biological replicates per group supports inference."
        ),
    },
    "normalization": NORMALIZATION,
    "n_genes_input": int(len(gene_ids)),
    "n_genes_after_filter": int(results_table.shape[0]),
    "n_genes_tested": 0,
    "n_significant": 0,
    "n_up_2fold": n_up_2fold,
    "n_down_2fold": n_down_2fold,
    "min_count": MIN_COUNT,
    "pseudocount": PSEUDOCOUNT,
    "size_factors": {str(sample): round(float(value), 4) for sample, value in size_factors.items()},
    "versions": {"python": platform.python_version(), **{name: package_version(name) for name in PACKAGES}},
}
with open(out("summary.json"), "w", encoding="utf-8") as handle:
    json.dump(summary_record, handle, indent=2)
with open(os.path.join("output", "session_info.txt"), "w", encoding="utf-8") as handle:
    handle.write(f"Python {platform.python_version()} on {platform.platform()}\n")
    for name in PACKAGES:
        handle.write(f"{name} {package_version(name) or 'not installed'}\n")
message("Done: ", out("results.csv"))
