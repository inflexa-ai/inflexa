#!/usr/bin/env python3
# tpl-pydeseq2-two-group — pydeseq2 two-group differential expression.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: the DESeq2 negative binomial GLM as implemented in pydeseq2, Wald test
# on the condition coefficient, median-of-ratios size factors, independent
# filtering at alpha, and apeglm-style shrinkage of the reported log2 fold
# change (Love et al. 2014; Zhu et al. 2019; Muzellec et al. 2023).

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
from pydeseq2.dds import DeseqDataSet  # noqa: E402
from pydeseq2.ds import DeseqStats  # noqa: E402

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH      = {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH    = {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN = {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN = {{condition_column}}  # [adaptable: condition_column]
REFERENCE_LEVEL  = {{reference_level}}  # [adaptable: reference_level]
TEST_LEVEL       = {{test_level}}  # [adaptable: test_level]
{{#if covariates}}
COVARIATES       = {{covariates}}  # [adaptable: covariates]
{{/if}}
{{#unless covariates}}
COVARIATES       = []  # [adaptable: covariates] empty: the design is ~ condition
{{/unless}}
MIN_COUNT        = {{min_count}}  # [adaptable: min_count]
{{#if min_samples}}
MIN_SAMPLES      = {{min_samples}}  # [adaptable: min_samples]
{{/if}}
{{#unless min_samples}}
MIN_SAMPLES      = None  # [adaptable: min_samples] None: the smallest group size, computed below
{{/unless}}
ALPHA            = {{alpha}}
LFC_SHRINK       = {{lfc_shrink}}  # [adaptable: lfc_shrink]
LFC_THRESHOLD    = {{lfc_threshold}}  # [adaptable: lfc_threshold]
N_TOP_GENES_PCA  = {{n_top_genes_pca}}  # [adaptable: n_top_genes_pca]
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
    sys.exit("The count matrix must hold non-negative integers. pydeseq2 takes raw counts, not TPM or FPKM.")
counts = counts.round().astype(int)

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
# The first category is the reference level of the design matrix, as relevel() in R.
levels = [REFERENCE_LEVEL] + [level for level in levels if level != REFERENCE_LEVEL]
metadata = pd.DataFrame(index=sample_table.index)
metadata["condition"] = pd.Categorical(condition_values, categories=levels)
for column in COVARIATES:
    if column == "condition":
        continue
    if column not in sample_table.columns:
        sys.exit(f"The covariates name {column} but the sample table has no such column")
    values = sample_table[column]
    metadata[column] = values if pd.api.types.is_numeric_dtype(values) else pd.Categorical(values.astype(str))
DESIGN = "~ " + " + ".join([column for column in COVARIATES if column != "condition"] + ["condition"])
message("Samples: ", counts.shape[1], "; genes: ", counts.shape[0], "; design: ", DESIGN)
message("Condition levels: ", ", ".join(levels), " (reference ", REFERENCE_LEVEL, ")")

# ── Filter ────────────────────────────────────────────────────────────────────
group_sizes = metadata["condition"].value_counts().sort_index()
if MIN_SAMPLES is None:
    MIN_SAMPLES = int(group_sizes.min())
keep = (counts >= MIN_COUNT).sum(axis=1) >= MIN_SAMPLES
message("Low count filter: keep genes with >= ", MIN_COUNT, " counts in >= ", MIN_SAMPLES, " samples: ", int(keep.sum()), " of ", counts.shape[0], " kept")
counts = counts.loc[keep]

# ── Model ─────────────────────────────────────────────────────────────────────
dds = DeseqDataSet(counts=counts.T, metadata=metadata, design=DESIGN, quiet=True)
dds.deseq2()
size_factors = dds.obs["size_factors"]
message("Size factors: ", ", ".join(f"{sample}={value:.2f}" for sample, value in size_factors.items()))

coefficient = f"condition[T.{TEST_LEVEL}]"
if coefficient not in dds.varm["LFC"].columns:
    sys.exit(f"The coefficient {coefficient} is not in the LFC columns: {', '.join(dds.varm['LFC'].columns)}")
stat_res = DeseqStats(
    dds,
    contrast=["condition", TEST_LEVEL, REFERENCE_LEVEL],
    alpha=ALPHA,
    lfc_null=LFC_THRESHOLD,
    alt_hypothesis="greaterAbs" if LFC_THRESHOLD > 0 else None,
    quiet=True,
)
stat_res.summary()
res = stat_res.results_df.copy()
unshrunken_lfc = res["log2FoldChange"].copy()

if LFC_SHRINK == "apeglm":
    message("Shrinking the log2 fold change with the apeglm prior on ", coefficient)
    stat_res.lfc_shrink(coeff=coefficient)
    res_shrunk = stat_res.results_df.copy()
else:
    res_shrunk = res

# ── Results table ─────────────────────────────────────────────────────────────
results_table = pd.DataFrame(
    {
        "gene": res.index.astype(str),
        "base_mean": res["baseMean"].to_numpy(),
        "log2_fold_change": res_shrunk["log2FoldChange"].to_numpy(),
        "log2_fold_change_unshrunken": unshrunken_lfc.to_numpy(),
        "lfc_se": res_shrunk["lfcSE"].to_numpy(),
        "stat": res["stat"].to_numpy(),
        "pvalue": res["pvalue"].to_numpy(),
        "adjusted_pvalue": res["padj"].to_numpy(),
    }
)
results_table = results_table.sort_values("pvalue", na_position="last", kind="stable")
results_table.to_csv(out("results.csv"), index=False, na_rep="NA")

normalized = pd.DataFrame(dds.layers["normed_counts"].T, index=counts.index, columns=counts.columns)
normalized.insert(0, "gene", normalized.index.astype(str))
normalized.to_csv(out("normalized_counts.csv"), index=False, na_rep="NA")

tested = results_table["adjusted_pvalue"].notna()
significant = tested & (results_table["adjusted_pvalue"] < ALPHA)
n_significant = int(significant.sum())
n_up = int((significant & (results_table["log2_fold_change"] > 0)).sum())
n_down = n_significant - n_up
message("Tested ", int(tested.sum()), " genes after independent filtering; ", n_significant, " at padj < ", ALPHA, " (", n_up, " up, ", n_down, " down)")

# ── Figures ───────────────────────────────────────────────────────────────────
# The VST for the PCA, blind to the design, on a fresh object so that the fitted model stays as it is.
vst_dds = DeseqDataSet(counts=counts.T, metadata=metadata, design=DESIGN, quiet=True)
vst_dds.vst(use_design=False)
vst = pd.DataFrame(vst_dds.layers["vst_counts"].T, index=counts.index, columns=counts.columns)
n_top = min(N_TOP_GENES_PCA, vst.shape[0])
top_genes = vst.var(axis=1).sort_values(ascending=False).index[:n_top]
centered = vst.loc[top_genes].T - vst.loc[top_genes].T.mean(axis=0)
u, s, _ = np.linalg.svd(centered.to_numpy(), full_matrices=False)
scores = u[:, :2] * s[:2]
percent_var = np.round(100 * (s**2 / (s**2).sum())[:2]).astype(int)
condition_colors = dict(zip(levels, matplotlib.colormaps["viridis"](np.linspace(0, 0.8, len(levels)))))
pca_figure, axis = plt.subplots()
for level in levels:
    mask = (metadata["condition"] == level).to_numpy()
    axis.scatter(scores[mask, 0], scores[mask, 1], s=40, color=condition_colors[level], label=level)
for index, sample in enumerate(counts.columns):
    axis.annotate(sample, (scores[index, 0], scores[index, 1]), fontsize=6, xytext=(0, 5), textcoords="offset points", ha="center")
axis.set_xlabel(f"PC1: {percent_var[0]}% variance")
axis.set_ylabel(f"PC2: {percent_var[1]}% variance")
axis.set_title("PCA of the samples, VST, top variable genes")
axis.legend(title="condition")
save_figure(pca_figure, "pca")

plot_df = results_table[tested].copy()
plot_df["significant"] = plot_df["adjusted_pvalue"] < ALPHA
ma_figure, axis = plt.subplots()
for flag, color in ((False, "grey"), (True, "#440154")):
    subset = plot_df[plot_df["significant"] == flag]
    axis.scatter(subset["base_mean"], subset["log2_fold_change"], s=3, alpha=0.6, color=color, label=str(flag), linewidths=0)
axis.set_xscale("log")
axis.axhline(0, linestyle="--", color="black", linewidth=0.8)
axis.set_xlabel("Mean of normalized counts")
axis.set_ylabel("Shrunken log2 fold change")
axis.set_title(f"MA plot: {TEST_LEVEL} vs {REFERENCE_LEVEL}")
axis.legend(title=f"padj < {ALPHA}")
save_figure(ma_figure, "ma")

top_labels = plot_df.sort_values("adjusted_pvalue").head(15)
volcano_figure, axis = plt.subplots()
for flag, color in ((False, "grey"), (True, "#21908C")):
    subset = plot_df[plot_df["significant"] == flag]
    axis.scatter(subset["log2_fold_change"], -np.log10(subset["adjusted_pvalue"]), s=3, alpha=0.6, color=color, label=str(flag), linewidths=0)
for _, row in top_labels.iterrows():
    axis.annotate(row["gene"], (row["log2_fold_change"], -np.log10(row["adjusted_pvalue"])), fontsize=6, xytext=(0, 4), textcoords="offset points", ha="center")
axis.axhline(-np.log10(ALPHA), linestyle="--", color="black", linewidth=0.8)
axis.set_xlabel("Shrunken log2 fold change")
axis.set_ylabel("-log10 adjusted p-value")
axis.set_title(f"Volcano: {TEST_LEVEL} vs {REFERENCE_LEVEL}")
axis.legend(title=f"padj < {ALPHA}")
save_figure(volcano_figure, "volcano")

# ── Summary ───────────────────────────────────────────────────────────────────
PACKAGES = ["pydeseq2", "pandas", "numpy", "matplotlib", "anndata", "formulaic", "scipy"]


def package_version(name):
    try:
        return importlib_metadata.version(name)
    except importlib_metadata.PackageNotFoundError:
        return None


summary_record = {
    "template": "tpl-pydeseq2-two-group@1.0.0",
    "method": "pydeseq2 Wald test",
    "contrast": {"factor": "condition", "test": TEST_LEVEL, "reference": REFERENCE_LEVEL},
    "design": DESIGN,
    "covariates": [column for column in COVARIATES if column != "condition"],
    "n_samples": int(counts.shape[1]),
    "group_sizes": {str(level): int(size) for level, size in group_sizes.items()},
    "n_genes_input": int(len(gene_ids)),
    "n_genes_after_filter": int(counts.shape[0]),
    "n_genes_tested": int(tested.sum()),
    "n_significant": n_significant,
    "n_up": n_up,
    "n_down": n_down,
    "alpha": ALPHA,
    "lfc_threshold": LFC_THRESHOLD,
    "lfc_shrink": LFC_SHRINK,
    "min_count": MIN_COUNT,
    "min_samples": MIN_SAMPLES,
    "size_factors": {str(sample): round(float(value), 4) for sample, value in size_factors.items()},
    "versions": {"python": platform.python_version(), **{name: package_version(name) for name in ["pydeseq2", "pandas", "numpy", "matplotlib"]}},
}
with open(out("summary.json"), "w", encoding="utf-8") as handle:
    json.dump(summary_record, handle, indent=2)
with open(os.path.join("output", "session_info.txt"), "w", encoding="utf-8") as handle:
    handle.write(f"Python {platform.python_version()} on {platform.platform()}\n")
    for name in PACKAGES:
        handle.write(f"{name} {package_version(name) or 'not installed'}\n")
message("Done: ", out("results.csv"))
