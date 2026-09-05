#!/usr/bin/env python3
# tpl-pydeseq2-interaction — pydeseq2 2x2 factorial design with an interaction term.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: the DESeq2 negative binomial GLM as implemented in pydeseq2 on the
# formulaic design ~ factor_a + factor_b + factor_a:factor_b, a Wald test on
# the interaction coefficient and on the simple effect of factor_b inside each
# level of factor_a (each a contrast vector over the design matrix),
# median-of-ratios size factors, independent filtering at alpha, and
# apeglm-style shrinkage of a named coefficient (Love et al. 2014; Zhu et al.
# 2019; Muzellec et al. 2023). pydeseq2 shrinks one coefficient by name, thus
# the interaction and the simple effect inside the reference level of factor_a
# are shrunken, and the simple effect inside the test level (the sum of two
# coefficients) is reported unshrunken. The summary records which.

import json
import os
import platform
import re
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
COUNTS_PATH        = {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH      = {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN   = {{sample_id_column}}  # [adaptable: sample_id_column]
FACTOR_A_COLUMN    = {{factor_a_column}}  # [adaptable: factor_a_column]
FACTOR_A_REFERENCE = {{factor_a_reference}}  # [adaptable: factor_a_reference]
FACTOR_B_COLUMN    = {{factor_b_column}}  # [adaptable: factor_b_column]
FACTOR_B_REFERENCE = {{factor_b_reference}}  # [adaptable: factor_b_reference]
DESIGN             = "~ factor_a + factor_b + factor_a:factor_b"
MIN_COUNT          = {{min_count}}  # [adaptable: min_count]
{{#if min_samples}}
MIN_SAMPLES        = {{min_samples}}  # [adaptable: min_samples]
{{/if}}
{{#unless min_samples}}
MIN_SAMPLES        = None  # [adaptable: min_samples] None: the smallest cell size, computed below
{{/unless}}
ALPHA              = {{alpha}}
LFC_SHRINK         = {{lfc_shrink}}  # [adaptable: lfc_shrink]
LFC_THRESHOLD      = {{lfc_threshold}}  # [adaptable: lfc_threshold]
N_TOP_GENES_PCA    = {{n_top_genes_pca}}  # [adaptable: n_top_genes_pca]
OUTPUT_PREFIX      = {{output_prefix}}  # [adaptable: output_prefix]

os.makedirs("output", exist_ok=True)
os.makedirs("figures", exist_ok=True)


def message(*parts):
    print("".join(str(part) for part in parts), file=sys.stderr, flush=True)


def out(name):
    return os.path.join("output", f"{OUTPUT_PREFIX}_{name}")


def fig(name):
    return os.path.join("figures", f"{OUTPUT_PREFIX}_{name}")


def file_token(level):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", str(level))


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
for column in (SAMPLE_ID_COLUMN, FACTOR_A_COLUMN, FACTOR_B_COLUMN):
    if column not in sample_table.columns:
        sys.exit(f"The sample table has no column {column}")
if FACTOR_A_COLUMN == FACTOR_B_COLUMN:
    sys.exit(f"factor_a_column and factor_b_column name the same column {FACTOR_A_COLUMN}")
sample_table.index = sample_table[SAMPLE_ID_COLUMN].astype(str)
missing = [sample for sample in counts.columns if sample not in sample_table.index]
if missing:
    sys.exit("Samples in the counts but not in the sample table: " + ", ".join(missing))
sample_table = sample_table.loc[list(counts.columns)]


def two_level_factor(column, reference, label):
    values = sample_table[column].astype(str)
    levels = sorted(set(values))
    if len(levels) != 2:
        sys.exit(f"The column {column} ({label}) must hold exactly two levels for a 2x2 design, but holds {len(levels)}: {', '.join(levels)}")
    if reference not in levels:
        sys.exit(f"The column {column} holds {', '.join(levels)} but not the reference level {reference}")
    # The first category is the reference level of the design matrix, as relevel() in R.
    return pd.Categorical(values, categories=[reference] + [level for level in levels if level != reference])


metadata = pd.DataFrame(index=sample_table.index)
metadata["factor_a"] = two_level_factor(FACTOR_A_COLUMN, FACTOR_A_REFERENCE, "factor_a")
metadata["factor_b"] = two_level_factor(FACTOR_B_COLUMN, FACTOR_B_REFERENCE, "factor_b")
FACTOR_A_TEST = str(metadata["factor_a"].cat.categories[1])
FACTOR_B_TEST = str(metadata["factor_b"].cat.categories[1])
LEVELS_A = [FACTOR_A_REFERENCE, FACTOR_A_TEST]
LEVELS_B = [FACTOR_B_REFERENCE, FACTOR_B_TEST]
cell_sizes = pd.crosstab(metadata["factor_a"], metadata["factor_b"]).reindex(index=LEVELS_A, columns=LEVELS_B, fill_value=0)
cell_text = ", ".join(f"{level_a}/{level_b}={int(cell_sizes.loc[level_a, level_b])}" for level_b in LEVELS_B for level_a in LEVELS_A)
if (cell_sizes == 0).any().any():
    sys.exit(f"Each of the four cells of the 2x2 design needs at least one sample. Cell sizes: {cell_text}")
if (cell_sizes < 2).any().any():
    message("Warning: a cell holds one sample only, thus the interaction test has low power. Cell sizes: ", cell_text)
message("Samples: ", counts.shape[1], "; genes: ", counts.shape[0], "; design: ", DESIGN)
message("factor_a = ", FACTOR_A_COLUMN, ": ", FACTOR_A_TEST, " vs ", FACTOR_A_REFERENCE, " (reference)")
message("factor_b = ", FACTOR_B_COLUMN, ": ", FACTOR_B_TEST, " vs ", FACTOR_B_REFERENCE, " (reference)")
message("Cell sizes: ", cell_text)

# ── Filter ────────────────────────────────────────────────────────────────────
if MIN_SAMPLES is None:
    MIN_SAMPLES = int(cell_sizes.to_numpy().min())
keep = (counts >= MIN_COUNT).sum(axis=1) >= MIN_SAMPLES
message("Low count filter: keep genes with >= ", MIN_COUNT, " counts in >= ", MIN_SAMPLES, " samples: ", int(keep.sum()), " of ", counts.shape[0], " kept")
counts = counts.loc[keep]

# ── Model ─────────────────────────────────────────────────────────────────────
dds = DeseqDataSet(counts=counts.T, metadata=metadata, design=DESIGN, quiet=True)
dds.deseq2()
size_factors = dds.obs["size_factors"]
message("Size factors: ", ", ".join(f"{sample}={value:.2f}" for sample, value in size_factors.items()))

# formulaic names a treatment-coded column `factor[T.level]` and an interaction
# column `factor_a[T.level]:factor_b[T.level]`. The LFC matrix shares the columns.
coefficient_names = list(dds.obsm["design_matrix"].columns)


def find_coefficient(expected, pattern, label):
    if expected in coefficient_names:
        return expected
    found = [name for name in coefficient_names if re.search(pattern, name)]
    if len(found) == 1:
        return found[0]
    sys.exit(f"The {label} coefficient {expected} is not in the design matrix columns: {', '.join(coefficient_names)}")


b_coefficient = find_coefficient(f"factor_b[T.{FACTOR_B_TEST}]", r"^factor_b\[T\.", "factor_b main effect")
interaction_coefficient = find_coefficient(f"factor_a[T.{FACTOR_A_TEST}]:factor_b[T.{FACTOR_B_TEST}]", r"^factor_a\[T\..*\]:factor_b\[T\.", "interaction")
message("Interaction coefficient: ", interaction_coefficient, "; factor_b main effect: ", b_coefficient)


def contrast_vector(coefficients):
    vector = np.zeros(len(coefficient_names))
    for name in coefficients:
        vector[coefficient_names.index(name)] = 1.0
    return vector


# ── Tests ─────────────────────────────────────────────────────────────────────
# One Wald test per table, on a contrast vector over the design matrix: the sum
# of the named coefficients. The reported pvalue and adjusted_pvalue come from
# the Wald test. The reported log2_fold_change and lfc_se come from the apeglm
# prior when the table tests one coefficient, because pydeseq2 shrinks one
# named coefficient and writes that coefficient into the results. A sum of two
# coefficients is reported unshrunken.
def wald_table(label, coefficients):
    stat_res = DeseqStats(
        dds,
        contrast=contrast_vector(coefficients),
        alpha=ALPHA,
        lfc_null=LFC_THRESHOLD,
        alt_hypothesis="greaterAbs" if LFC_THRESHOLD > 0 else None,
        quiet=True,
    )
    stat_res.summary()
    res = stat_res.results_df.copy()
    shrink_applied = False
    if LFC_SHRINK == "apeglm" and len(coefficients) == 1:
        message("Shrinking the log2 fold change of ", label, " with the apeglm prior on ", coefficients[0])
        stat_res.lfc_shrink(coeff=coefficients[0])
        res_shrunk = stat_res.results_df.copy()
        shrink_applied = True
    else:
        if LFC_SHRINK == "apeglm":
            message("No shrinkage for ", label, ": pydeseq2 shrinks one named coefficient, and this table sums ", " + ".join(coefficients))
        res_shrunk = res
    table = pd.DataFrame(
        {
            "gene": res.index.astype(str),
            "base_mean": res["baseMean"].to_numpy(),
            "log2_fold_change": res_shrunk["log2FoldChange"].to_numpy(),
            "lfc_se": res_shrunk["lfcSE"].to_numpy(),
            "stat": res["stat"].to_numpy(),
            "pvalue": res["pvalue"].to_numpy(),
            "adjusted_pvalue": res["padj"].to_numpy(),
        }
    )
    table = table.sort_values("pvalue", na_position="last", kind="stable")
    tested = table["adjusted_pvalue"].notna()
    significant = tested & (table["adjusted_pvalue"] < ALPHA)
    n_significant = int(significant.sum())
    n_up = int((significant & (table["log2_fold_change"] > 0)).sum())
    counts_record = {
        "n_tested": int(tested.sum()),
        "n_significant": n_significant,
        "n_up": n_up,
        "n_down": n_significant - n_up,
        "lfc_shrink_applied": shrink_applied,
    }
    message(label, ": tested ", counts_record["n_tested"], " genes after independent filtering; ", n_significant,
            " at padj < ", ALPHA, " (", n_up, " up, ", n_significant - n_up, " down)")
    return table, counts_record


interaction_label = f"{FACTOR_A_COLUMN}:{FACTOR_B_COLUMN} ({FACTOR_A_TEST} x {FACTOR_B_TEST})"
interaction_table, interaction_counts = wald_table(f"interaction {interaction_label}", [interaction_coefficient])
interaction_table.to_csv(out("interaction_results.csv"), index=False, na_rep="NA")


def simple_effect_label(level_a):
    return f"{FACTOR_B_COLUMN} {FACTOR_B_TEST} vs {FACTOR_B_REFERENCE} within {FACTOR_A_COLUMN} = {level_a}"


simple_effects = {
    FACTOR_A_REFERENCE: [b_coefficient],
    FACTOR_A_TEST: [b_coefficient, interaction_coefficient],
}
simple_effects_record = {}
for level_a, coefficients in simple_effects.items():
    table, counts_record = wald_table(simple_effect_label(level_a), coefficients)
    file_name = f"simple_effect_{file_token(level_a)}.csv"
    table.to_csv(out(file_name), index=False, na_rep="NA")
    simple_effects_record[level_a] = {"coefficients": coefficients, "file": os.path.basename(out(file_name)), **counts_record}

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
a_colors = dict(zip(LEVELS_A, matplotlib.colormaps["viridis"](np.linspace(0, 0.8, len(LEVELS_A)))))
b_markers = dict(zip(LEVELS_B, ["o", "^"]))
pca_figure, axis = plt.subplots()
for level_a in LEVELS_A:
    for level_b in LEVELS_B:
        mask = ((metadata["factor_a"] == level_a) & (metadata["factor_b"] == level_b)).to_numpy()
        axis.scatter(scores[mask, 0], scores[mask, 1], s=40, color=a_colors[level_a], marker=b_markers[level_b], label=f"{level_a} / {level_b}")
for index, sample in enumerate(counts.columns):
    axis.annotate(sample, (scores[index, 0], scores[index, 1]), fontsize=6, xytext=(0, 5), textcoords="offset points", ha="center")
axis.set_xlabel(f"PC1: {percent_var[0]}% variance")
axis.set_ylabel(f"PC2: {percent_var[1]}% variance")
axis.set_title("PCA of the samples, VST, top variable genes")
axis.legend(title=f"{FACTOR_A_COLUMN} / {FACTOR_B_COLUMN}", fontsize=7)
save_figure(pca_figure, "pca")

plot_df = interaction_table[interaction_table["adjusted_pvalue"].notna()].copy()
plot_df["significant"] = plot_df["adjusted_pvalue"] < ALPHA
lfc_axis_label = "Shrunken interaction log2 fold change" if interaction_counts["lfc_shrink_applied"] else "Interaction log2 fold change"
ma_figure, axis = plt.subplots()
for flag, color in ((False, "grey"), (True, "#440154")):
    subset = plot_df[plot_df["significant"] == flag]
    axis.scatter(subset["base_mean"], subset["log2_fold_change"], s=3, alpha=0.6, color=color, label=str(flag), linewidths=0)
axis.set_xscale("log")
axis.axhline(0, linestyle="--", color="black", linewidth=0.8)
axis.set_xlabel("Mean of normalized counts")
axis.set_ylabel(lfc_axis_label)
axis.set_title(f"MA plot, interaction: {interaction_label}")
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
axis.set_xlabel(lfc_axis_label)
axis.set_ylabel("-log10 adjusted p-value")
axis.set_title(f"Volcano, interaction: {interaction_label}")
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
    "template": "tpl-pydeseq2-interaction@1.0.0",
    "method": "pydeseq2 Wald test",
    "design": DESIGN,
    "factor_a": {"column": FACTOR_A_COLUMN, "reference": FACTOR_A_REFERENCE, "test": FACTOR_A_TEST},
    "factor_b": {"column": FACTOR_B_COLUMN, "reference": FACTOR_B_REFERENCE, "test": FACTOR_B_TEST},
    "n_samples": int(counts.shape[1]),
    "cell_sizes": {level_a: {level_b: int(cell_sizes.loc[level_a, level_b]) for level_b in LEVELS_B} for level_a in LEVELS_A},
    "n_genes_input": int(len(gene_ids)),
    "n_genes_after_filter": int(counts.shape[0]),
    "interaction": {"coefficient": interaction_coefficient, **interaction_counts},
    "simple_effects": simple_effects_record,
    "alpha": ALPHA,
    "lfc_threshold": LFC_THRESHOLD,
    "lfc_shrink": LFC_SHRINK,
    "lfc_shrink_note": "pydeseq2 shrinks one named coefficient with the apeglm prior. A table that sums two coefficients is unshrunken; see lfc_shrink_applied per table.",
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
message("Done: ", out("interaction_results.csv"))
