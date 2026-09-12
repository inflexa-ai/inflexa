#!/usr/bin/env python3
# tpl-decoupler-py-pathway-activity — pathway activity with the PROGENy footprint
# model and decoupler, from a contrast and per sample.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: the PROGENy model gives each signaling pathway a weighted set of the
# genes that respond to its perturbation, and the top responsive genes per
# pathway form the network (Schubert et al. 2018). The gene-level statistic of
# the contrast is the pydeseq2 Wald statistic of the test level against the
# reference level, or the `stat` column of a given results table. The
# decoupler multivariate linear model (mlm) regresses the statistic on the
# weights of every pathway at once, thus a gene shared between pathways is
# attributed once; the t-value of a pathway is its activity score, read as a
# footprint and not as a membership (Badia-i-Mompel et al. 2022). The same
# model on log2(CPM + 1) of the filtered counts gives one score per pathway
# and sample. The model ships as an R data file, thus the script reads it
# through the R interpreter of the sandbox and records the table it took. The
# Python mirror of tpl-progeny-pathway-activity.

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
MODEL_PATH = {{model_path}}  # [adaptable: model_path]
TOP_RESPONSIVE_GENES = {{top_responsive_genes}}  # [adaptable: top_responsive_genes]
ACTIVITY_METHOD = {{activity_method}}  # [adaptable: activity_method]
MIN_SIZE = {{min_size}}  # [adaptable: min_size]
MIN_COUNT = {{min_count}}  # [adaptable: min_count]
ALPHA = {{alpha}}  # [adaptable: alpha]
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


if ACTIVITY_METHOD not in ("mlm", "ulm"):
    fail("activity_method must be mlm or ulm, not ", ACTIVITY_METHOD)


def run_activity(data, network):
    """The decoupler scores: one t-value per observation (row of data) and pathway with at least MIN_SIZE genes."""
    estimator = dc.mt.mlm if ACTIVITY_METHOD == "mlm" else dc.mt.ulm
    estimates, _adjusted = estimator(data, network, tmin=MIN_SIZE, verbose=False)
    estimates.columns = [str(name) for name in estimates.columns]
    return estimates


# ── Inputs ────────────────────────────────────────────────────────────────────
message("Reading counts from ", COUNTS_PATH)
if not os.path.exists(COUNTS_PATH):
    fail("The count matrix does not exist: ", COUNTS_PATH)
counts_df = pd.read_csv(COUNTS_PATH)
gene_ids = counts_df.iloc[:, 0].astype(str)
if gene_ids.duplicated().any():
    fail("The count matrix holds a duplicated gene identifier; the model needs one row per gene symbol.")
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

# ── The footprint model ───────────────────────────────────────────────────────
message("Loading the PROGENy model from ", MODEL_PATH)
if not os.path.exists(MODEL_PATH):
    fail("The model file does not exist: ", MODEL_PATH)
model_table_path = out("model_table.csv")
if MODEL_PATH.lower().endswith((".rda", ".rdata")):
    # The model is an R data file with one data frame. The R interpreter of
    # the sandbox writes it as a CSV, which the script reads and keeps.
    import rpy2.robjects as robjects

    loaded = list(robjects.r["load"](MODEL_PATH))
    if len(loaded) != 1:
        fail("The model file must hold one object, but it holds ", len(loaded))
    robjects.r["write.csv"](robjects.r["as.data.frame"](robjects.r[loaded[0]]), model_table_path, **{"row.names": False})
    model_object = loaded[0]
else:
    model_object = os.path.basename(MODEL_PATH)
    pd.read_csv(MODEL_PATH).to_csv(model_table_path, index=False)
model = pd.read_csv(model_table_path)
needed = ["gene", "pathway", "weight", "p.value"]
if any(column not in model.columns for column in needed):
    fail("The model ", model_object, " must hold the columns ", ", ".join(needed), " but holds ", ", ".join(model.columns))
model = model.dropna(subset=["gene", "weight", "p.value"]).copy()
model["gene"] = model["gene"].astype(str)
model["pathway"] = model["pathway"].astype(str)
model = model.sort_values(["pathway", "p.value"], kind="stable")
network = model.groupby("pathway", sort=False).head(TOP_RESPONSIVE_GENES)
network = pd.DataFrame({"source": network["pathway"].to_numpy(), "target": network["gene"].to_numpy(), "weight": network["weight"].to_numpy(dtype=float)})
network = network.drop_duplicates(subset=["source", "target"], keep="first").reset_index(drop=True)
n_pathways_model = int(model["pathway"].nunique())
message("Model ", model_object, ": ", n_pathways_model, " pathways, ", len(model), " gene-pathway weights; top ", TOP_RESPONSIVE_GENES, " responsive genes per pathway kept: ", len(network), " edges")

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

# ── Coverage of the model ─────────────────────────────────────────────────────
model_genes = set(network["target"])
covered_genes = model_genes & set(contrast_stat.index)
coverage = len(covered_genes) / len(model_genes)
covered = network[network["target"].isin(contrast_stat.index)]
n_targets = covered.groupby("source").size()
message("Model coverage: ", len(covered_genes), " of ", len(model_genes), " responsive genes are among the tested genes (", round(100 * coverage), "%)")
if coverage < 0.1:
    fail("Fewer than 10% of the responsive genes are in the data. Make sure that the gene column holds symbols of the same organism as the model.")
if (n_targets < MIN_SIZE).all():
    fail("No pathway has at least ", MIN_SIZE, " responsive genes among the tested genes")

# ── Activity on the contrast ──────────────────────────────────────────────────
contrast_matrix = pd.DataFrame([contrast_stat.to_numpy()], index=["contrast"], columns=contrast_stat.index)
message("Running decoupler ", ACTIVITY_METHOD, " on the contrast statistic with tmin ", MIN_SIZE)
contrast_estimates = run_activity(contrast_matrix, network)
if contrast_estimates.shape[1] == 0:
    fail("No pathway has at least ", MIN_SIZE, " responsive genes among the tested genes")
score = contrast_estimates.iloc[0]
# decoupler returns the Benjamini-Hochberg adjusted p-value only. The raw two-sided
# p-value of a t-value comes from the t distribution with the residual degrees of
# freedom of the fit: n_genes - n_pathways - 1 for the multivariate model, n_genes - 2
# for the univariate one. The adjustment across the pathways is done here.
residual_df = len(contrast_stat) - (contrast_estimates.shape[1] + 1 if ACTIVITY_METHOD == "mlm" else 2)
pvalue = 2.0 * stats.t.sf(np.abs(score.to_numpy(dtype=float)), df=max(residual_df, 1))
padj = np.full(pvalue.shape, np.nan)
finite = np.isfinite(pvalue)
if finite.any():
    padj[finite] = multipletests(pvalue[finite], method="fdr_bh")[1]
activity_table = pd.DataFrame(
    {
        "pathway": score.index.to_numpy(),
        "score": score.to_numpy(dtype=float),
        "pvalue": pvalue,
        "padj": padj,
        "n_targets": n_targets.reindex(score.index).fillna(0).astype(int).to_numpy(),
    }
)
activity_table = activity_table.sort_values("pvalue", kind="stable", na_position="last").reset_index(drop=True)
activity_table.to_csv(out("activity.csv"), index=False)

n_pathways_tested = int(len(activity_table))
significant_mask = activity_table["padj"].notna() & (activity_table["padj"] < ALPHA)
n_significant = int(significant_mask.sum())
n_up = int((significant_mask & (activity_table["score"] > 0)).sum())
n_down = n_significant - n_up
message("Pathways scored: ", n_pathways_tested, "; ", n_significant, " at padj < ", ALPHA, " (", n_up, " up, ", n_down, " down)")

# ── Per-sample scores on the log-CPM matrix ───────────────────────────────────
library_sizes = counts.sum(axis=0)
if (library_sizes <= 0).any():
    fail("A sample has no counts after the filter: ", ", ".join(library_sizes.index[library_sizes <= 0]))
log_cpm = np.log2(counts.div(library_sizes, axis=1) * CPM_SCALE + 1.0).T
message("Running decoupler ", ACTIVITY_METHOD, " on log2(CPM + 1) for the per-sample scores")
sample_estimates = run_activity(log_cpm, network)
if sample_estimates.shape[1] == 0:
    fail("No pathway has at least ", MIN_SIZE, " responsive genes among the filtered genes")
score_matrix = sample_estimates.T.loc[:, log_cpm.index]
score_matrix.columns = [str(sample) for sample in score_matrix.columns]
scores_table = score_matrix.copy()
scores_table.insert(0, "pathway", score_matrix.index)
scores_table.to_csv(out("scores.csv"), index=False)

# ── Figures ───────────────────────────────────────────────────────────────────
bar_table = activity_table.sort_values("score", kind="stable")
significant_bar = (bar_table["padj"].fillna(1.0) < ALPHA).to_numpy()
figure, axis = plt.subplots(figsize=(6, 5))
colors = ["#21908C" if flag else "#999999" for flag in significant_bar]
axis.barh(np.arange(len(bar_table)), bar_table["score"], color=colors)
axis.axvline(0, color="black", linewidth=0.8)
axis.set_yticks(np.arange(len(bar_table)))
axis.set_yticklabels(bar_table["pathway"], fontsize=8)
axis.set_xlabel(f"PROGENy activity score ({ACTIVITY_METHOD} t-value)")
axis.set_title(f"Pathway footprint activity: {TEST_LEVEL} vs {REFERENCE_LEVEL}")
axis.legend(
    handles=[Patch(color="#21908C", label="TRUE"), Patch(color="#999999", label="FALSE")],
    title=f"padj < {ALPHA}",
    loc="lower right",
    fontsize=7,
    title_fontsize=7,
)
for side in ("top", "right"):
    axis.spines[side].set_visible(False)
save_figure(figure, "activity_bar")

heatmap_matrix = score_matrix.loc[[pathway for pathway in activity_table["pathway"] if pathway in score_matrix.index]]
heatmap_matrix = heatmap_matrix[np.isfinite(heatmap_matrix.to_numpy()).all(axis=1) & (heatmap_matrix.std(axis=1, ddof=1) > 0).to_numpy()]
if heatmap_matrix.shape[0] == 0:
    fail("No pathway has a finite per-sample score with a non-zero spread for the heatmap")
palette = dict(zip(condition_levels, sns.color_palette("Set2", len(condition_levels))))
column_colors = pd.Series([palette[level] for level in metadata.loc[heatmap_matrix.columns, "condition"].astype(str)], index=heatmap_matrix.columns, name="condition")
grid = sns.clustermap(
    heatmap_matrix,
    z_score=0,
    row_cluster=False,
    col_cluster=heatmap_matrix.shape[1] > 2,
    col_colors=column_colors,
    cmap="RdBu_r",
    center=0,
    figsize=(7, 5),
    yticklabels=True,
    xticklabels=True,
    cbar_kws={"label": "row z-score"},
)
grid.ax_heatmap.tick_params(axis="y", labelsize=8)
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
grid.figure.suptitle(f"PROGENy {ACTIVITY_METHOD} score per sample, scaled by pathway", y=1.02)
save_figure(grid.figure, "score_heatmap")

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record = {
    "template": "tpl-decoupler-py-pathway-activity@1.0.0",
    "method": f"decoupler {ACTIVITY_METHOD} on the PROGENy footprint model",
    "activity_method": ACTIVITY_METHOD,
    "interpretation": "footprint_not_membership",
    "contrast": {"factor": "condition", "test": TEST_LEVEL, "reference": REFERENCE_LEVEL},
    "design": DESIGN,
    "statistic_source": statistic_source,
    "model": {
        "path": MODEL_PATH,
        "object": model_object,
        "table_written": model_table_path,
        "n_pathways": n_pathways_model,
        "n_weights": int(len(model)),
        "top_responsive_genes": TOP_RESPONSIVE_GENES,
        "n_edges": int(len(network)),
        "coverage": round(coverage, 4),
    },
    "min_size": MIN_SIZE,
    "n_samples": int(counts.shape[1]),
    "group_sizes": {str(level): int(size) for level, size in group_sizes.items()},
    "n_genes_input": int(len(gene_ids)),
    "n_genes_after_filter": int(counts.shape[0]),
    "n_genes_with_statistic": int(len(contrast_stat)),
    "n_pathways_tested": n_pathways_tested,
    "n_significant": n_significant,
    "n_up": n_up,
    "n_down": n_down,
    "alpha": ALPHA,
    "adjustment": "BH",
    "min_count": MIN_COUNT,
    "per_sample_input": "log_cpm",
    "n_pathways_scored_per_sample": int(score_matrix.shape[0]),
    "versions": {
        "python": platform.python_version(),
        "decoupler": package_version("decoupler"),
        "pydeseq2": package_version("pydeseq2"),
        "rpy2": package_version("rpy2"),
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
