#!/usr/bin/env python3
# tpl-pydeseq2-multigroup — pydeseq2 for three or more groups: one Wald contrast
# per level against the reference level, and an any-difference table.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# SUBSTITUTION OF THE METHOD OF RECORD. The method of record (M-0002) is the
# DESeq2 likelihood ratio test of the full design against the reduced design.
# pydeseq2 0.5.4 has no likelihood ratio test: DeseqStats runs the Wald test
# only, and DeseqDataSet takes no reduced design. Thus this script fits the
# full design once, runs one Wald contrast per non-reference level against the
# reference level (as the R template does after its LRT), and builds the
# any-difference table without an LRT: for each gene the smallest Wald p-value
# across the contrasts, multiplied by the number of contrasts with a p-value
# (the first Holm step, a Bonferroni bound on the minimum), then
# Benjamini-Hochberg across the genes. The reduced design is checked and
# recorded, not fitted. The summary JSON states the substitution in the field
# `any_difference_method`.
#
# Method: the DESeq2 negative binomial GLM as implemented in pydeseq2, Wald
# tests on the condition coefficients, median-of-ratios size factors,
# independent filtering at alpha, and apeglm-style shrinkage of the reported
# log2 fold change of each contrast (Love et al. 2014; Zhu et al. 2019;
# Muzellec et al. 2023). The any-difference table reports the largest shrunken
# contrast of each gene as its log2 fold change.

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
from scipy.cluster.hierarchy import leaves_list, linkage  # noqa: E402
from scipy.spatial.distance import pdist, squareform  # noqa: E402

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH         = {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH       = {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN    = {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN    = {{condition_column}}  # [adaptable: condition_column]
REFERENCE_LEVEL     = {{reference_level}}  # [adaptable: reference_level]
FULL_DESIGN         = "{{full_design}}"  # [adaptable: full_design]
REDUCED_DESIGN      = "{{reduced_design}}"  # [adaptable: reduced_design]
MIN_COUNT           = {{min_count}}  # [adaptable: min_count]
{{#if min_samples}}
MIN_SAMPLES         = {{min_samples}}  # [adaptable: min_samples]
{{/if}}
{{#unless min_samples}}
MIN_SAMPLES         = None  # [adaptable: min_samples] None: the smallest group size, computed below
{{/unless}}
ALPHA               = {{alpha}}
LFC_SHRINK          = {{lfc_shrink}}  # [adaptable: lfc_shrink]
N_TOP_GENES_PCA     = {{n_top_genes_pca}}  # [adaptable: n_top_genes_pca]
N_TOP_GENES_HEATMAP = {{n_top_genes_heatmap}}  # [adaptable: n_top_genes_heatmap]
OUTPUT_PREFIX       = {{output_prefix}}  # [adaptable: output_prefix]

ANY_DIFFERENCE_METHOD = "minimum_wald_pvalue_bonferroni_holm_then_bh"

os.makedirs("output", exist_ok=True)
os.makedirs("figures", exist_ok=True)


def message(*parts):
    print("".join(str(part) for part in parts), file=sys.stderr, flush=True)


def out(name):
    return os.path.join("output", f"{OUTPUT_PREFIX}_{name}")


def fig(name):
    return os.path.join("figures", f"{OUTPUT_PREFIX}_{name}")


def file_safe(text):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", str(text))


def save_figure(figure, name, width=6, height=5):
    figure.set_size_inches(width, height)
    figure.tight_layout()
    figure.savefig(fig(f"{name}.png"), dpi=300)
    figure.savefig(fig(f"{name}.pdf"))
    plt.close(figure)


def formula_terms(formula):
    """The additive terms of a one-sided formula, without the intercept token."""
    if "~" not in formula:
        sys.exit(f"The design {formula!r} must start with ~")
    body = formula.split("~", 1)[1]
    terms = [term.strip() for term in body.split("+")]
    return [term for term in terms if term not in ("", "0", "1")]


def term_variables(term):
    """The variable names of a term, so that a:b and b:a are the same term."""
    return frozenset(part.strip("() ") for part in re.split(r"[:*]", term) if part.strip("() "))


def column_variables(column):
    """The variable names of a design matrix column, for example batch[T.y]:condition[T.a] gives {batch, condition}."""
    return frozenset(re.sub(r"\[.*\]$", "", part) for part in column.split(":"))


def benjamini_hochberg(pvalues):
    """The Benjamini-Hochberg adjustment, as p.adjust(method = "BH") in R; a NaN stays NaN and does not count."""
    adjusted = np.full(pvalues.shape, np.nan)
    mask = np.isfinite(pvalues)
    values = pvalues[mask]
    m = values.size
    if m == 0:
        return adjusted
    order = np.argsort(values)[::-1]
    ranked = np.minimum.accumulate(values[order] * m / np.arange(m, 0, -1))
    result = np.empty(m)
    result[order] = np.minimum(ranked, 1.0)
    adjusted[mask] = result
    return adjusted


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
for column in (SAMPLE_ID_COLUMN, CONDITION_COLUMN):
    if column not in sample_table.columns:
        sys.exit(f"The sample table has no column {column}")
sample_table.index = sample_table[SAMPLE_ID_COLUMN].astype(str)
missing = [sample for sample in counts.columns if sample not in sample_table.index]
if missing:
    sys.exit("Samples in the counts but not in the sample table: " + ", ".join(missing))
sample_table = sample_table.loc[list(counts.columns)]
condition_values = sample_table[CONDITION_COLUMN].astype(str)
levels = sorted(set(condition_values))
if REFERENCE_LEVEL not in levels:
    sys.exit(f"The condition column holds {', '.join(levels)} but not {REFERENCE_LEVEL}")
if len(levels) < 3:
    sys.exit(f"The condition column holds {len(levels)} levels; this template is for three or more groups")
# The first category is the reference level of the design matrix, as relevel() in R.
levels = [REFERENCE_LEVEL] + [level for level in levels if level != REFERENCE_LEVEL]
metadata = pd.DataFrame(index=sample_table.index)
metadata["condition"] = pd.Categorical(condition_values, categories=levels)
group_sizes = metadata["condition"].value_counts().sort_index()
if (group_sizes < 2).any():
    sys.exit("Each group needs at least two replicates: " + ", ".join(f"{level}={int(size)}" for level, size in group_sizes.items()))

full_terms = formula_terms(FULL_DESIGN)
reduced_terms = formula_terms(REDUCED_DESIGN)
full_term_sets = [term_variables(term) for term in full_terms]
reduced_term_sets = [term_variables(term) for term in reduced_terms]
design_columns = sorted(set().union(*full_term_sets, *reduced_term_sets) - {"condition"}) if full_terms or reduced_terms else []
for column in design_columns:
    if column not in sample_table.columns:
        sys.exit(f"A design names {column} but the sample table has no such column")
    values = sample_table[column]
    metadata[column] = values if pd.api.types.is_numeric_dtype(values) else pd.Categorical(values.astype(str))
if frozenset(["condition"]) not in full_term_sets:
    sys.exit("The full design must name condition")
if any("condition" in term for term in reduced_term_sets):
    sys.exit("The reduced design must not name condition; the any-difference test removes the condition")
extra_terms = [term for term, variables in zip(reduced_terms, reduced_term_sets) if variables not in full_term_sets]
if extra_terms:
    sys.exit("The reduced design holds terms that the full design does not: " + ", ".join(extra_terms))
removed_terms = [term for term, variables in zip(full_terms, full_term_sets) if variables not in reduced_term_sets]
if not removed_terms:
    sys.exit("The full design has no more terms than the reduced design")
removed_term_sets = [term_variables(term) for term in removed_terms]

contrast_levels = [level for level in levels if level != REFERENCE_LEVEL]
message("Samples: ", counts.shape[1], "; genes: ", counts.shape[0])
message("Full design: ", FULL_DESIGN, "; reduced design: ", REDUCED_DESIGN, " (recorded, not fitted: pydeseq2 has no likelihood ratio test)")
message("Terms that the likelihood ratio test would remove: ", ", ".join(removed_terms))
message("Condition levels: ", ", ".join(levels), " (reference ", REFERENCE_LEVEL, ")")
message("Contrasts: ", ", ".join(f"{level} vs {REFERENCE_LEVEL}" for level in contrast_levels))

# ── Filter ────────────────────────────────────────────────────────────────────
if MIN_SAMPLES is None:
    MIN_SAMPLES = int(group_sizes.min())
keep = (counts >= MIN_COUNT).sum(axis=1) >= MIN_SAMPLES
message("Low count filter: keep genes with >= ", MIN_COUNT, " counts in >= ", MIN_SAMPLES, " samples: ", int(keep.sum()), " of ", counts.shape[0], " kept")
counts = counts.loc[keep]

# ── Model: the full design, fitted once ───────────────────────────────────────
dds = DeseqDataSet(counts=counts.T, metadata=metadata, design=FULL_DESIGN, quiet=True)
dds.deseq2()
size_factors = dds.obs["size_factors"]
message("Size factors: ", ", ".join(f"{sample}={value:.2f}" for sample, value in size_factors.items()))

design_matrix_columns = list(dds.obsm["design_matrix"].columns)
df_tested = sum(1 for column in design_matrix_columns if column_variables(column) in removed_term_sets)
if df_tested < 1:
    sys.exit("No column of the design matrix belongs to a removed term: " + ", ".join(design_matrix_columns))
message("Design matrix columns: ", ", ".join(design_matrix_columns), " (", df_tested, " degrees of freedom for the removed terms)")

# ── One Wald contrast per level against the reference ────────────────────────
# The coefficient condition[T.<level>] is the contrast of the level against
# the reference, because the reference is the first category. The shrinkage
# takes that coefficient. DeseqStats copies the coefficients, thus one
# DeseqStats per level leaves the fitted object as it is.
contrast_tables = {}
contrast_records = []
raw_pvalues = pd.DataFrame(index=counts.index, columns=contrast_levels, dtype=float)
wald_stats = pd.DataFrame(index=counts.index, columns=contrast_levels, dtype=float)
adjusted_pvalues = pd.DataFrame(index=counts.index, columns=contrast_levels, dtype=float)
shrunken_lfc = pd.DataFrame(index=counts.index, columns=contrast_levels, dtype=float)
base_mean = None
for level in contrast_levels:
    coefficient = f"condition[T.{level}]"
    if coefficient not in dds.varm["LFC"].columns:
        sys.exit(f"The coefficient {coefficient} is not in the LFC columns: {', '.join(dds.varm['LFC'].columns)}")
    stat_res = DeseqStats(dds, contrast=["condition", level, REFERENCE_LEVEL], alpha=ALPHA, quiet=True)
    stat_res.summary()
    res = stat_res.results_df.copy()
    unshrunken_lfc = res["log2FoldChange"].copy()
    if LFC_SHRINK == "apeglm":
        message("Shrinking the log2 fold change of ", level, " vs ", REFERENCE_LEVEL, " with the apeglm prior on ", coefficient)
        stat_res.lfc_shrink(coeff=coefficient)
        res_shrunk = stat_res.results_df.copy()
    else:
        res_shrunk = res
    res = res.reindex(counts.index)
    res_shrunk = res_shrunk.reindex(counts.index)
    if base_mean is None:
        base_mean = res["baseMean"].copy()
    raw_pvalues[level] = res["pvalue"].to_numpy(dtype=float)
    wald_stats[level] = res["stat"].to_numpy(dtype=float)
    adjusted_pvalues[level] = res["padj"].to_numpy(dtype=float)
    shrunken_lfc[level] = res_shrunk["log2FoldChange"].to_numpy(dtype=float)
    contrast_table = pd.DataFrame(
        {
            "gene": counts.index.astype(str),
            "base_mean": res["baseMean"].to_numpy(),
            "log2_fold_change": res_shrunk["log2FoldChange"].to_numpy(),
            "log2_fold_change_unshrunken": unshrunken_lfc.reindex(counts.index).to_numpy(),
            "lfc_se": res_shrunk["lfcSE"].to_numpy(),
            "stat": res["stat"].to_numpy(),
            "pvalue": res["pvalue"].to_numpy(),
            "adjusted_pvalue": res["padj"].to_numpy(),
        }
    )
    contrast_table = contrast_table.sort_values("pvalue", na_position="last", kind="stable")
    contrast_file = os.path.join("output", f"{file_safe(level)}_vs_{file_safe(REFERENCE_LEVEL)}_results.csv")
    contrast_table.to_csv(contrast_file, index=False, na_rep="NA")
    tested = contrast_table["adjusted_pvalue"].notna()
    significant = tested & (contrast_table["adjusted_pvalue"] < ALPHA)
    n_significant = int(significant.sum())
    n_up = int((significant & (contrast_table["log2_fold_change"] > 0)).sum())
    message("Wald contrast ", level, " vs ", REFERENCE_LEVEL, ": ", int(tested.sum()), " genes tested; ", n_significant, " at padj < ", ALPHA, " (", n_up, " up, ", n_significant - n_up, " down): ", contrast_file)
    contrast_tables[level] = contrast_table
    contrast_records.append(
        {
            "level": level,
            "reference": REFERENCE_LEVEL,
            "coefficient": coefficient,
            "n_genes_tested": int(tested.sum()),
            "n_significant": n_significant,
            "n_up": n_up,
            "n_down": n_significant - n_up,
            "results_file": contrast_file,
        }
    )

# ── The any-difference table ──────────────────────────────────────────────────
# No likelihood ratio test in pydeseq2: the p-value of a gene is its smallest
# Wald p-value across the contrasts, multiplied by the number of contrasts
# that gave it a p-value (the first Holm step, a Bonferroni bound), capped at
# 1. Then Benjamini-Hochberg across the genes with a p-value. The log2 fold
# change of a gene is its largest shrunken contrast by absolute value, with
# the sign kept, and largest_contrast names the level.
pvalue_matrix = raw_pvalues.to_numpy(dtype=float)
n_with_pvalue = np.isfinite(pvalue_matrix).sum(axis=1)
has_pvalue = n_with_pvalue > 0
filled = np.where(np.isfinite(pvalue_matrix), pvalue_matrix, np.inf)
min_index = filled.argmin(axis=1)
min_pvalue = np.where(has_pvalue, filled[np.arange(filled.shape[0]), min_index], np.nan)
combined_pvalue = np.where(has_pvalue, np.minimum(min_pvalue * n_with_pvalue, 1.0), np.nan)
combined_adjusted = benjamini_hochberg(combined_pvalue)
min_stat = np.where(has_pvalue, wald_stats.to_numpy(dtype=float)[np.arange(filled.shape[0]), min_index], np.nan)

lfc_matrix = shrunken_lfc.to_numpy(dtype=float)
has_lfc = np.isfinite(lfc_matrix).any(axis=1)
largest_index = np.where(np.isfinite(lfc_matrix), np.abs(lfc_matrix), -np.inf).argmax(axis=1)
largest_lfc = np.where(has_lfc, lfc_matrix[np.arange(lfc_matrix.shape[0]), largest_index], np.nan)
largest_level = np.where(has_lfc, np.array(contrast_levels, dtype=object)[largest_index], None)

any_difference = pd.DataFrame(
    {
        "gene": counts.index.astype(str),
        "base_mean": base_mean.to_numpy(),
        "log2_fold_change": largest_lfc,
        "largest_contrast": largest_level,
        "stat": min_stat,
        "pvalue": combined_pvalue,
        "adjusted_pvalue": combined_adjusted,
    }
)
any_difference = any_difference.sort_values("pvalue", na_position="last", kind="stable")
any_difference_file = os.path.join("output", "any_difference_results.csv")
any_difference.to_csv(any_difference_file, index=False, na_rep="NA")
any_tested = any_difference["adjusted_pvalue"].notna()
n_tested_any = int(any_tested.sum())
n_significant_any = int((any_tested & (any_difference["adjusted_pvalue"] < ALPHA)).sum())
message("Any-difference table (", ANY_DIFFERENCE_METHOD, "): ", n_tested_any, " genes with a p-value; ", n_significant_any, " at padj < ", ALPHA, ": ", any_difference_file)

normalized = pd.DataFrame(dds.layers["normed_counts"].T, index=counts.index, columns=counts.columns)
normalized.insert(0, "gene", normalized.index.astype(str))
normalized.to_csv(out("normalized_counts.csv"), index=False, na_rep="NA")

# The VST, blind to the design, on a fresh object so that the fitted model stays as it is.
vst_dds = DeseqDataSet(counts=counts.T, metadata=metadata, design=FULL_DESIGN, quiet=True)
vst_dds.vst(use_design=False)
vst = pd.DataFrame(vst_dds.layers["vst_counts"].T, index=counts.index, columns=counts.columns)
vst_table = vst.copy()
vst_table.insert(0, "gene", vst_table.index.astype(str))
vst_table.to_csv(out("vst.csv"), index=False, na_rep="NA")

# ── Figures ───────────────────────────────────────────────────────────────────
condition_colors = dict(zip(levels, matplotlib.colormaps["viridis"](np.linspace(0, 0.8, len(levels)))))
sample_conditions = metadata["condition"].astype(str)

n_top = min(N_TOP_GENES_PCA, vst.shape[0])
top_variable = vst.var(axis=1).sort_values(ascending=False).index[:n_top]
centered = vst.loc[top_variable].T - vst.loc[top_variable].T.mean(axis=0)
u, s, _ = np.linalg.svd(centered.to_numpy(), full_matrices=False)
scores = u[:, :2] * s[:2]
percent_var = np.round(100 * (s**2 / (s**2).sum())[:2]).astype(int)
pca_figure, axis = plt.subplots()
for level in levels:
    mask = (sample_conditions == level).to_numpy()
    axis.scatter(scores[mask, 0], scores[mask, 1], s=40, color=condition_colors[level], label=level)
for index, sample in enumerate(counts.columns):
    axis.annotate(sample, (scores[index, 0], scores[index, 1]), fontsize=6, xytext=(0, 5), textcoords="offset points", ha="center")
axis.set_xlabel(f"PC1: {percent_var[0]}% variance")
axis.set_ylabel(f"PC2: {percent_var[1]}% variance")
axis.set_title("PCA of the samples, VST, top variable genes")
axis.legend(title="condition")
save_figure(pca_figure, "pca")

# Euclidean sample distances on the VST, samples ordered by complete-linkage clustering.
distances = pdist(vst.T.to_numpy(), metric="euclidean")
sample_order = leaves_list(linkage(distances, method="complete"))
distance_matrix = squareform(distances)[np.ix_(sample_order, sample_order)]
ordered_samples = [counts.columns[index] for index in sample_order]
distance_figure, axis = plt.subplots()
image = axis.imshow(distance_matrix, cmap="Blues_r", aspect="auto")
axis.set_xticks(range(len(ordered_samples)))
axis.set_yticks(range(len(ordered_samples)))
axis.set_xticklabels(ordered_samples, rotation=90, fontsize=6)
axis.set_yticklabels(ordered_samples, fontsize=6)
for label, sample in zip(axis.get_xticklabels(), ordered_samples):
    label.set_color(condition_colors[sample_conditions[sample]])
for label, sample in zip(axis.get_yticklabels(), ordered_samples):
    label.set_color(condition_colors[sample_conditions[sample]])
distance_figure.colorbar(image, ax=axis, label="Euclidean distance")
axis.legend(handles=[matplotlib.patches.Patch(color=condition_colors[level], label=level) for level in levels], title="condition", loc="upper left", bbox_to_anchor=(1.35, 1.0), fontsize=7)
axis.set_title("Euclidean sample distances (VST)")
save_figure(distance_figure, "sample_distances", width=7, height=5)

top_genes = list(any_difference.loc[any_difference["pvalue"].notna(), "gene"].head(N_TOP_GENES_HEATMAP))
if len(top_genes) >= 2:
    column_order = np.argsort(metadata["condition"].cat.codes.to_numpy(), kind="stable")
    heatmap_samples = [counts.columns[index] for index in column_order]
    heatmap_values = vst.loc[top_genes, heatmap_samples].to_numpy()
    row_sd = heatmap_values.std(axis=1, ddof=1, keepdims=True)
    row_sd[row_sd == 0] = 1.0
    scaled = (heatmap_values - heatmap_values.mean(axis=1, keepdims=True)) / row_sd
    limit = float(np.nanmax(np.abs(scaled))) if np.isfinite(scaled).any() else 1.0
    heatmap_figure, (strip_axis, axis) = plt.subplots(2, 1, gridspec_kw={"height_ratios": [1, 40], "hspace": 0.02}, sharex=True)
    strip_axis.imshow(np.array([[levels.index(sample_conditions[sample]) for sample in heatmap_samples]]), cmap=matplotlib.colors.ListedColormap([condition_colors[level] for level in levels]), vmin=0, vmax=len(levels) - 1, aspect="auto")
    strip_axis.set_yticks([])
    strip_axis.tick_params(axis="x", bottom=False, labelbottom=False)
    image = axis.imshow(scaled, cmap="RdBu_r", vmin=-limit, vmax=limit, aspect="auto")
    axis.set_xticks(range(len(heatmap_samples)))
    axis.set_xticklabels(heatmap_samples, rotation=90, fontsize=6)
    axis.set_yticks(range(len(top_genes)))
    axis.set_yticklabels(top_genes, fontsize=5)
    heatmap_figure.colorbar(image, ax=[strip_axis, axis], label="Row z-score of the VST", shrink=0.6)
    strip_axis.legend(handles=[matplotlib.patches.Patch(color=condition_colors[level], label=level) for level in levels], title="condition", loc="lower left", bbox_to_anchor=(1.02, -0.5), fontsize=7)
    strip_axis.set_title(f"Top {len(top_genes)} any-difference genes, VST, scaled by row")
    heatmap_figure.set_size_inches(7, 8)
    heatmap_figure.savefig(fig("top_genes_heatmap.png"), dpi=300, bbox_inches="tight")
    heatmap_figure.savefig(fig("top_genes_heatmap.pdf"), bbox_inches="tight")
    plt.close(heatmap_figure)
else:
    message("Fewer than 2 genes have a p-value; no heatmap")

for level in contrast_levels:
    contrast_name = f"{file_safe(level)}_vs_{file_safe(REFERENCE_LEVEL)}"
    plot_df = contrast_tables[level][contrast_tables[level]["adjusted_pvalue"].notna()].copy()
    plot_df["significant"] = plot_df["adjusted_pvalue"] < ALPHA
    ma_figure, axis = plt.subplots()
    for flag, color in ((False, "grey"), (True, "#440154")):
        subset = plot_df[plot_df["significant"] == flag]
        axis.scatter(subset["base_mean"], subset["log2_fold_change"], s=3, alpha=0.6, color=color, label=str(flag), linewidths=0)
    axis.set_xscale("log")
    axis.axhline(0, linestyle="--", color="black", linewidth=0.8)
    axis.set_xlabel("Mean of normalized counts")
    axis.set_ylabel("Shrunken log2 fold change")
    axis.set_title(f"MA plot: {level} vs {REFERENCE_LEVEL}")
    axis.legend(title=f"padj < {ALPHA}")
    save_figure(ma_figure, f"ma_{contrast_name}")

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
    axis.set_title(f"Volcano: {level} vs {REFERENCE_LEVEL}")
    axis.legend(title=f"padj < {ALPHA}")
    save_figure(volcano_figure, f"volcano_{contrast_name}")

# ── Summary ───────────────────────────────────────────────────────────────────
PACKAGES = ["pydeseq2", "pandas", "numpy", "scipy", "matplotlib", "anndata", "formulaic"]


def package_version(name):
    try:
        return importlib_metadata.version(name)
    except importlib_metadata.PackageNotFoundError:
        return None


summary_record = {
    "template": "tpl-pydeseq2-multigroup@1.0.0",
    "method": "pydeseq2 Wald test, one contrast per level against the reference; the any-difference table from the minimum Wald p-value per gene, because pydeseq2 0.5.4 has no likelihood ratio test",
    "method_of_record": "DESeq2 likelihood ratio test (M-0002)",
    "likelihood_ratio_test": False,
    "any_difference_method": ANY_DIFFERENCE_METHOD,
    "any_difference_method_note": "For each gene: the smallest Wald p-value across the contrasts, multiplied by the number of contrasts with a p-value (the first Holm step, a Bonferroni bound), capped at 1. Then Benjamini-Hochberg across the genes.",
    "full_design": FULL_DESIGN,
    "reduced_design": REDUCED_DESIGN,
    "reduced_design_fitted": False,
    "terms_removed": removed_terms,
    "df_tested": int(df_tested),
    "design_matrix_columns": design_matrix_columns,
    "condition": {"column": CONDITION_COLUMN, "levels": levels, "reference": REFERENCE_LEVEL},
    "n_samples": int(counts.shape[1]),
    "n_groups": len(levels),
    "group_sizes": {str(level): int(size) for level, size in group_sizes.items()},
    "n_genes_input": int(len(gene_ids)),
    "n_genes_after_filter": int(counts.shape[0]),
    "any_difference": {
        "n_genes_tested": n_tested_any,
        "n_significant": n_significant_any,
        "n_contrasts": len(contrast_levels),
        "results_file": any_difference_file,
    },
    "contrasts": contrast_records,
    "alpha": ALPHA,
    "lfc_shrink": LFC_SHRINK,
    "min_count": MIN_COUNT,
    "min_samples": MIN_SAMPLES,
    "n_top_genes_pca": N_TOP_GENES_PCA,
    "n_top_genes_heatmap": N_TOP_GENES_HEATMAP,
    "size_factors": {str(sample): round(float(value), 4) for sample, value in size_factors.items()},
    "versions": {"python": platform.python_version(), **{name: package_version(name) for name in ["pydeseq2", "pandas", "numpy", "scipy", "matplotlib"]}},
}
with open(out("summary.json"), "w", encoding="utf-8") as handle:
    json.dump(summary_record, handle, indent=2)
with open(os.path.join("output", "session_info.txt"), "w", encoding="utf-8") as handle:
    handle.write(f"Python {platform.python_version()} on {platform.platform()}\n")
    for name in PACKAGES:
        handle.write(f"{name} {package_version(name) or 'not installed'}\n")
message("Done: ", any_difference_file)
