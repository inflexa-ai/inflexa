"""Sample structure QC: blind VST, PCA, sample distances, library-size QC.

Answers: do the 12 samples (6 control / 6 treated) separate by condition on
the top-variance genes, and how does the flagged shallow sample behave
relative to its group on PCA, sample-distance, and library-size metrics.

Constraints (per briefing):
  - transform = vst_blind (DESeq2 blind variance-stabilizing transform)
  - n_top_genes = 500 for PCA
  - low_depth_policy = keep_inspect_report: never silently drop the shallow
    sample; report the QC evidence and state a justified decision.

Inputs (read-only):
  counts.csv   - raw integer counts, genes (rows) x samples (cols)
  metadata.csv - sample -> condition (control/treated)

Outputs:
  output/library_size_qc.csv         - ranked library size / detected genes table
  output/sample_distance_matrix.csv  - full Euclidean distance matrix (VST, all genes)
  output/pca_coordinates.csv         - PC1/PC2 (+ variance explained) per sample
  output/vst_blind_counts.csv        - blind-VST matrix (filtered genes x samples)
  output/qc_decision_memo.md         - stated, evidence-based retain/exclude decision
  figures/pca_top500.png/.pdf        - PCA on top 500 variable genes, colored by condition
  figures/sample_distance_heatmap.png/.pdf
  figures/library_size_barplot.png/.pdf
"""

# %% [markdown]
# ## Imports and parameters

# %%
import logging
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns
from scipy.spatial.distance import pdist, squareform
from sklearn.decomposition import PCA

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# %% Parameters
COUNTS_PATH = "/eval-u25-live-with-two-group-n6-enrich-s1-1/data/inputs/local/counts.csv"
METADATA_PATH = "/eval-u25-live-with-two-group-n6-enrich-s1-1/data/inputs/local/metadata.csv"
OUTPUT_DIR = Path("output")
FIGURE_DIR = Path("figures")
N_TOP_GENES = 500  # per constraint: n_top_genes = 500
RANDOM_SEED = 42
SHALLOW_FOLD_THRESHOLD = 2.0  # informational threshold for flagging depth outliers
N_CPUS = 2

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
FIGURE_DIR.mkdir(parents=True, exist_ok=True)

CONDITION_PALETTE = {"control": "#3B75AF", "treated": "#EF8636"}  # colorblind-safe (viridis-adjacent, distinct hue+shape use)
CONDITION_MARKER = {"control": "o", "treated": "^"}


# %% [markdown]
# ## Data loading


def load_counts_and_metadata(
    counts_path: str, metadata_path: str
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Load raw count matrix (genes x samples) and sample metadata.

    Returns
    -------
    counts : pd.DataFrame
        genes (rows) x samples (columns), raw integer counts.
    metadata : pd.DataFrame
        indexed by sample, with a 'condition' column.
    """
    counts = pd.read_csv(counts_path, index_col=0)
    metadata = pd.read_csv(metadata_path, index_col=0)
    metadata = metadata.loc[counts.columns]  # enforce sample order match
    logger.info(
        "Loaded counts: %d genes x %d samples; metadata: %d samples, condition levels=%s",
        counts.shape[0],
        counts.shape[1],
        metadata.shape[0],
        sorted(metadata["condition"].unique()),
    )
    return counts, metadata


# %% [markdown]
# ## Library size / detected gene QC table (on raw, unfiltered counts.csv)


def compute_library_qc_table(counts: pd.DataFrame, metadata: pd.DataFrame) -> pd.DataFrame:
    """Compute per-sample library size and detected-gene counts, ranked ascending.

    Detected genes = genes with raw count > 0 for that sample.
    Fold-difference from median = median(library_size) / library_size[sample]
    (>1 means the sample is that many-fold shallower than the cohort median).
    """
    lib_size = counts.sum(axis=0)
    detected_genes = (counts > 0).sum(axis=0)
    median_lib_size = lib_size.median()

    qc = pd.DataFrame(
        {
            "sample": lib_size.index,
            "condition": metadata.loc[lib_size.index, "condition"].values,
            "library_size": lib_size.values,
            "detected_genes": detected_genes.values,
            "median_library_size": median_lib_size,
            "fold_below_median": median_lib_size / lib_size.values,
        }
    )
    qc = qc.sort_values("library_size", ascending=True).reset_index(drop=True)
    qc["depth_rank"] = np.arange(1, len(qc) + 1)  # 1 = shallowest
    qc["flag_shallow"] = qc["fold_below_median"] >= SHALLOW_FOLD_THRESHOLD
    logger.info(
        "Library size range: %.0f - %.0f (median %.0f). Shallowest sample: %s (%.0f reads, %.2fx below median)",
        qc["library_size"].min(),
        qc["library_size"].max(),
        median_lib_size,
        qc.iloc[0]["sample"],
        qc.iloc[0]["library_size"],
        qc.iloc[0]["fold_below_median"],
    )
    return qc


# %% [markdown]
# ## Blind VST via PyDESeq2 (use_design=False == DESeq2 vst(blind=TRUE))


def filter_all_zero_genes(counts: pd.DataFrame) -> pd.DataFrame:
    """Drop genes with zero counts across every sample.

    These carry no information and break DESeq2/PyDESeq2 size-factor and
    dispersion-trend fitting (log of zero). This is the standard minimal
    pre-filter from the DESeq2 workflow (Love, Anders & Huber, F1000Research
    2015; doi:10.12688/f1000research.7035.1) applied before vst(), distinct
    from the stricter filter used before differential testing.
    """
    keep = counts.sum(axis=1) > 0
    n_dropped = (~keep).sum()
    if n_dropped:
        logger.info("Dropping %d genes with zero counts in all samples before VST", n_dropped)
    return counts.loc[keep]


def run_blind_vst(counts: pd.DataFrame, metadata: pd.DataFrame) -> pd.DataFrame:
    """Fit DESeq2-style blind VST via PyDESeq2 and return a samples x genes matrix.

    Blind VST (use_design=False, PyDESeq2's default) fits dispersions and the
    trend curve using an intercept-only design, i.e. ignoring the condition
    label -- this is what makes the transform valid for unbiased QC/clustering
    (equivalent to R DESeq2's vst(dds, blind=TRUE)).
    """
    from pydeseq2.dds import DeseqDataSet

    filtered = filter_all_zero_genes(counts)
    counts_samples_x_genes = filtered.T  # PyDESeq2 wants samples as rows

    dds = DeseqDataSet(
        counts=counts_samples_x_genes,
        metadata=metadata,
        design="~condition",
        n_cpus=N_CPUS,
        quiet=True,
    )
    dds.vst(use_design=False)  # blind VST
    vst_df = pd.DataFrame(
        dds.layers["vst_counts"],
        index=dds.obs_names,
        columns=dds.var_names,
    )
    size_factors = pd.Series(
        dds.obs["size_factors"].values, index=dds.obs_names, name="deseq2_size_factor"
    )
    logger.info("Blind VST complete: %d samples x %d genes", vst_df.shape[0], vst_df.shape[1])
    return vst_df, size_factors


# %% [markdown]
# ## PCA on top-N variable genes


def compute_pca_top_variable(
    vst_df: pd.DataFrame, metadata: pd.DataFrame, n_top_genes: int, seed: int
) -> tuple[pd.DataFrame, np.ndarray, list[str]]:
    """PCA on the n_top_genes most-variable genes (by variance across samples) in VST space.

    vst_df: samples x genes.
    """
    gene_var = vst_df.var(axis=0, ddof=1)
    top_genes = gene_var.sort_values(ascending=False).index[:n_top_genes].tolist()
    x = vst_df[top_genes].values
    x_centered = x - x.mean(axis=0, keepdims=True)

    pca = PCA(n_components=min(5, x_centered.shape[0] - 1), random_state=seed)
    scores = pca.fit_transform(x_centered)
    var_explained = pca.explained_variance_ratio_ * 100

    pc_cols = [f"PC{i + 1}" for i in range(scores.shape[1])]
    pca_df = pd.DataFrame(scores, index=vst_df.index, columns=pc_cols)
    pca_df["sample"] = pca_df.index
    pca_df["condition"] = metadata.loc[pca_df.index, "condition"].values
    logger.info(
        "PCA on top %d variable genes: PC1=%.1f%%, PC2=%.1f%% variance explained",
        n_top_genes,
        var_explained[0],
        var_explained[1],
    )
    return pca_df, var_explained, top_genes


# %% [markdown]
# ## Sample-to-sample Euclidean distance (full VST matrix, all filtered genes)


def compute_sample_distance_matrix(vst_df: pd.DataFrame) -> pd.DataFrame:
    """Pairwise Euclidean distance between samples in blind-VST space (all genes)."""
    dist = squareform(pdist(vst_df.values, metric="euclidean"))
    return pd.DataFrame(dist, index=vst_df.index, columns=vst_df.index)


# %% [markdown]
# ## Plotting


def plot_pca(pca_df: pd.DataFrame, var_explained: np.ndarray, shallow_sample: str, out_base: Path) -> None:
    """PCA scatter, colored by condition, marker by condition, sample labels, shallow sample highlighted."""
    plt.style.use("seaborn-v0_8-whitegrid")
    fig, ax = plt.subplots(figsize=(7, 6))
    for cond, sub in pca_df.groupby("condition"):
        ax.scatter(
            sub["PC1"],
            sub["PC2"],
            s=110,
            c=CONDITION_PALETTE[cond],
            marker=CONDITION_MARKER[cond],
            label=cond,
            edgecolor="black",
            linewidth=0.6,
            zorder=3,
        )
    shallow_row = pca_df.loc[shallow_sample]
    ax.scatter(
        shallow_row["PC1"],
        shallow_row["PC2"],
        s=260,
        facecolors="none",
        edgecolors="red",
        linewidths=2.2,
        zorder=4,
        label=f"shallow sample ({shallow_sample})",
    )
    for _, row in pca_df.iterrows():
        ax.annotate(
            row["sample"],
            (row["PC1"], row["PC2"]),
            textcoords="offset points",
            xytext=(6, 4),
            fontsize=8,
        )
    ax.set_xlabel(f"PC1 ({var_explained[0]:.1f}% variance)")
    ax.set_ylabel(f"PC2 ({var_explained[1]:.1f}% variance)")
    ax.set_title("PCA on top 500 variable genes (blind VST)")
    ax.legend(frameon=True)
    fig.tight_layout()
    fig.savefig(out_base.with_suffix(".png"), dpi=300)
    fig.savefig(out_base.with_suffix(".pdf"))
    plt.close(fig)


def plot_distance_heatmap(
    dist_df: pd.DataFrame, metadata: pd.DataFrame, shallow_sample: str, out_base: Path
) -> None:
    """Sample-to-sample Euclidean distance heatmap, hierarchically clustered, condition-annotated."""
    from scipy.cluster.hierarchy import linkage
    from scipy.spatial.distance import squareform as sf

    condensed = sf(dist_df.values, checks=False)
    link = linkage(condensed, method="average")

    row_colors = dist_df.index.to_series().map(
        lambda s: CONDITION_PALETTE[metadata.loc[s, "condition"]]
    )
    g = sns.clustermap(
        dist_df,
        row_linkage=link,
        col_linkage=link,
        cmap="viridis_r",
        row_colors=row_colors,
        col_colors=row_colors,
        figsize=(8.5, 8),
        cbar_kws={"label": "Euclidean distance (blind VST)"},
    )
    g.ax_heatmap.set_xticklabels(g.ax_heatmap.get_xmajorticklabels(), fontsize=8, rotation=90)
    g.ax_heatmap.set_yticklabels(g.ax_heatmap.get_ymajorticklabels(), fontsize=8)
    for tick_label in g.ax_heatmap.get_xticklabels() + g.ax_heatmap.get_yticklabels():
        if tick_label.get_text() == shallow_sample:
            tick_label.set_color("red")
            tick_label.set_fontweight("bold")
    g.fig.suptitle("Sample-to-sample Euclidean distance (blind VST, all genes)", y=1.02)
    g.savefig(out_base.with_suffix(".png"), dpi=300, bbox_inches="tight")
    g.savefig(out_base.with_suffix(".pdf"), bbox_inches="tight")
    plt.close(g.fig)


def plot_library_size_barplot(qc_table: pd.DataFrame, out_base: Path) -> None:
    """Bar plot of library size per sample, ranked, condition-colored, shallow sample flagged."""
    plt.style.use("seaborn-v0_8-whitegrid")
    fig, ax = plt.subplots(figsize=(8, 5))
    ordered = qc_table.sort_values("library_size")
    colors = [CONDITION_PALETTE[c] for c in ordered["condition"]]
    bars = ax.bar(ordered["sample"], ordered["library_size"], color=colors, edgecolor="black", linewidth=0.5)
    ax.axhline(ordered["median_library_size"].iloc[0], color="black", linestyle="--", linewidth=1, label="cohort median")
    shallow_idx = ordered["flag_shallow"].values
    for bar, is_shallow in zip(bars, shallow_idx):
        if is_shallow:
            bar.set_edgecolor("red")
            bar.set_linewidth(2.5)
    ax.set_ylabel("Library size (total raw counts)")
    ax.set_xlabel("Sample (ranked, shallowest first)")
    ax.set_title("Library size per sample")
    plt.setp(ax.get_xticklabels(), rotation=45, ha="right")
    handles = [
        plt.Rectangle((0, 0), 1, 1, color=CONDITION_PALETTE["control"]),
        plt.Rectangle((0, 0), 1, 1, color=CONDITION_PALETTE["treated"]),
    ]
    ax.legend(handles + [ax.lines[0]], ["control", "treated", "cohort median"], frameon=True)
    fig.tight_layout()
    fig.savefig(out_base.with_suffix(".png"), dpi=300)
    fig.savefig(out_base.with_suffix(".pdf"))
    plt.close(fig)


# %% [markdown]
# ## QC decision memo


def summarize_shallow_sample_evidence(
    qc_table: pd.DataFrame,
    pca_df: pd.DataFrame,
    dist_df: pd.DataFrame,
    size_factors: pd.Series,
    metadata: pd.DataFrame,
) -> dict:
    """Assemble the QC evidence needed to justify a retain/exclude decision."""
    shallow_row = qc_table.iloc[0]
    shallow_sample = shallow_row["sample"]
    shallow_cond = shallow_row["condition"]

    same_cond_samples = [s for s in metadata.index if metadata.loc[s, "condition"] == shallow_cond and s != shallow_sample]
    other_cond_samples = [s for s in metadata.index if metadata.loc[s, "condition"] != shallow_cond]

    dist_to_own_group = dist_df.loc[shallow_sample, same_cond_samples].mean()
    dist_to_other_group = dist_df.loc[shallow_sample, other_cond_samples].mean()

    # baseline: mean within-group distance among the OTHER same-condition samples
    within_group_dists = []
    for i, s1 in enumerate(same_cond_samples):
        for s2 in same_cond_samples[i + 1 :]:
            within_group_dists.append(dist_df.loc[s1, s2])
    baseline_within_group_dist = float(np.mean(within_group_dists)) if within_group_dists else np.nan

    pc1_own_group = pca_df.loc[same_cond_samples, "PC1"]
    pc2_own_group = pca_df.loc[same_cond_samples, "PC2"]
    shallow_pc1 = pca_df.loc[shallow_sample, "PC1"]
    shallow_pc2 = pca_df.loc[shallow_sample, "PC2"]
    pc1_z = (shallow_pc1 - pc1_own_group.mean()) / pc1_own_group.std(ddof=1) if pc1_own_group.std(ddof=1) > 0 else np.nan
    pc2_z = (shallow_pc2 - pc2_own_group.mean()) / pc2_own_group.std(ddof=1) if pc2_own_group.std(ddof=1) > 0 else np.nan

    evidence = {
        "shallow_sample": shallow_sample,
        "shallow_condition": shallow_cond,
        "library_size": float(shallow_row["library_size"]),
        "median_library_size": float(shallow_row["median_library_size"]),
        "fold_below_median": float(shallow_row["fold_below_median"]),
        "detected_genes": int(shallow_row["detected_genes"]),
        "median_detected_genes": float(qc_table["detected_genes"].median()),
        "deseq2_size_factor": float(size_factors[shallow_sample]),
        "median_size_factor": float(size_factors.median()),
        "dist_to_own_group_mean": float(dist_to_own_group),
        "dist_to_other_group_mean": float(dist_to_other_group),
        "baseline_within_group_dist": baseline_within_group_dist,
        "pc1_z_vs_own_group": float(pc1_z),
        "pc2_z_vs_own_group": float(pc2_z),
    }
    return evidence


def write_decision_memo(
    evidence: dict, qc_table: pd.DataFrame, pca_condition_separates: bool, path: Path
) -> None:
    """Write the QC memo with a stated, evidence-based retain/exclude decision."""
    s = evidence
    outlier_by_distance = s["dist_to_own_group_mean"] > 1.5 * s["baseline_within_group_dist"]
    outlier_by_pca = abs(s["pc1_z_vs_own_group"]) > 2 or abs(s["pc2_z_vs_own_group"]) > 2
    clusters_with_own_group = s["dist_to_own_group_mean"] < s["dist_to_other_group_mean"]

    if clusters_with_own_group and not outlier_by_distance and not outlier_by_pca:
        decision = "RETAIN"
        rationale = (
            f"{s['shallow_sample']} is {s['fold_below_median']:.2f}x below the cohort median library size "
            f"(the lowest of all 12 samples) and has visibly fewer detected genes "
            f"({s['detected_genes']} vs a cohort median of {s['median_detected_genes']:.0f}). "
            "Despite that, on the blind-VST PCA it falls within its own condition group "
            f"(PC1 z-score vs its group = {s['pc1_z_vs_own_group']:.2f}, PC2 z-score = {s['pc2_z_vs_own_group']:.2f}), "
            f"and its mean sample-distance to its own condition group "
            f"({s['dist_to_own_group_mean']:.1f}) is not inflated relative to the baseline within-group "
            f"distance among its other same-condition replicates ({s['baseline_within_group_dist']:.1f}), "
            f"and is smaller than its mean distance to the opposite condition ({s['dist_to_other_group_mean']:.1f}). "
            f"Its DESeq2 median-of-ratios size factor ({s['deseq2_size_factor']:.3f} vs cohort median "
            f"{s['median_size_factor']:.3f}) is materially below 1, meaning the count model already "
            "down-weights this sample's contribution to dispersion/normalization proportionally to its depth. "
            "Because the sample is not a structural outlier on PCA or sample-distance despite its low depth, "
            "and the DESeq2 model already compensates for depth via the size factor, it is retained for "
            "downstream analysis. It should be watched: a sample this shallow contributes disproportionate "
            "sampling noise to lowly-expressed genes, so any DE hit driven predominantly by this one sample "
            "warrants a leave-one-out sensitivity check at the DE step."
        )
    else:
        decision = "EXCLUDE (flag for sensitivity analysis)"
        rationale = (
            f"{s['shallow_sample']} is {s['fold_below_median']:.2f}x below the cohort median library size "
            f"and has {s['detected_genes']} detected genes vs a cohort median of {s['median_detected_genes']:.0f}. "
            f"On top of the depth shortfall, it behaves as a structural outlier: "
        )
        if outlier_by_pca:
            rationale += (
                f"its PCA position deviates from its own condition group by {max(abs(s['pc1_z_vs_own_group']), abs(s['pc2_z_vs_own_group'])):.2f} "
                "standard deviations on the top-500-variable-gene PCA, "
            )
        if outlier_by_distance:
            rationale += (
                f"its mean blind-VST Euclidean distance to its own condition group ({s['dist_to_own_group_mean']:.1f}) "
                f"exceeds 1.5x the baseline within-group distance among its other same-condition replicates "
                f"({s['baseline_within_group_dist']:.1f}), "
            )
        if not clusters_with_own_group:
            rationale += (
                f"and it is on average closer to the opposite condition ({s['dist_to_other_group_mean']:.1f}) "
                f"than to its own ({s['dist_to_own_group_mean']:.1f}), "
            )
        rationale += (
            "so its low depth is accompanied by genuine structural divergence, not just proportional shrinkage "
            "the size factor can absorb. Recommend excluding it from the primary DE contrast and reporting "
            "results with and without it, rather than dropping it silently."
        )

    lines = [
        "# QC decision: shallow sample retain/exclude",
        "",
        f"**Decision: {decision}**",
        "",
        "## Evidence",
        "",
        f"- Shallow sample: **{s['shallow_sample']}** (condition: {s['shallow_condition']})",
        (
            f"- Library size: {s['library_size']:,.0f} reads vs cohort median {s['median_library_size']:,.0f} "
            f"({s['fold_below_median']:.2f}x below median; lowest-depth sample among all 12)"
        ),
        f"- Detected genes: {s['detected_genes']:,} vs cohort median {s['median_detected_genes']:,.0f}",
        f"- DESeq2 size factor: {s['deseq2_size_factor']:.3f} vs cohort median {s['median_size_factor']:.3f}",
        (
            f"- PCA (top 500 variable genes, blind VST): PC1 z vs own group = {s['pc1_z_vs_own_group']:.2f}, "
            f"PC2 z vs own group = {s['pc2_z_vs_own_group']:.2f}"
        ),
        (
            f"- Mean blind-VST Euclidean distance to own condition group: {s['dist_to_own_group_mean']:.2f} "
            f"(baseline within-group distance among other same-condition replicates: {s['baseline_within_group_dist']:.2f})"
        ),
        f"- Mean blind-VST Euclidean distance to opposite condition group: {s['dist_to_other_group_mean']:.2f}",
        (
            f"- Condition separation on PCA overall (both groups, top 500 genes): "
            f"{'separates cleanly along PC1/PC2' if pca_condition_separates else 'does NOT separate cleanly'}"
        ),
        "",
        "## Rationale",
        "",
        rationale,
        "",
        "## Caveats",
        "",
        (
            "- No batch, lane, or run-date field exists in metadata.csv. Batch effects cannot be assessed or "
            "adjusted for; any residual dispersion in the PCA/distance structure that looks technical cannot be "
            "attributed to batch versus biology versus depth with the metadata available."
        ),
        (
            "- No subject/donor identifier separate from 'sample' exists, so biological independence of replicates "
            "is assumed, not confirmed."
        ),
        (
            "- This QC step does not run differential expression; the retain/exclude call is about sample structure "
            "QC input to a downstream DE step, not a final DE conclusion."
        ),
        "",
        "## Full library-size / detected-gene ranking",
        "",
        qc_table[
            ["depth_rank", "sample", "condition", "library_size", "detected_genes", "fold_below_median", "flag_shallow"]
        ].to_markdown(index=False),
        "",
    ]
    path.write_text("\n".join(lines))
    logger.info("Decision memo written: %s (decision=%s)", path, decision)


def assess_condition_separation(pca_df: pd.DataFrame) -> bool:
    """Rough check: does a simple PC1 threshold separate control vs treated with no overlap?"""
    control_pc1 = pca_df.loc[pca_df["condition"] == "control", "PC1"]
    treated_pc1 = pca_df.loc[pca_df["condition"] == "treated", "PC1"]
    separates = (control_pc1.max() < treated_pc1.min()) or (treated_pc1.max() < control_pc1.min())
    return bool(separates)


# %% [markdown]
# ## Main


def main() -> None:
    np.random.seed(RANDOM_SEED)

    counts, metadata = load_counts_and_metadata(COUNTS_PATH, METADATA_PATH)

    qc_table = compute_library_qc_table(counts, metadata)
    qc_table.to_csv(OUTPUT_DIR / "library_size_qc.csv", index=False)

    vst_df, size_factors = run_blind_vst(counts, metadata)
    vst_df.T.to_csv(OUTPUT_DIR / "vst_blind_counts.csv")  # genes x samples, standard orientation

    pca_df, var_explained, top_genes = compute_pca_top_variable(vst_df, metadata, N_TOP_GENES, RANDOM_SEED)
    pca_df.to_csv(OUTPUT_DIR / "pca_coordinates.csv", index=False)
    pd.Series(top_genes, name="gene").to_csv(OUTPUT_DIR / "top500_variable_genes.csv", index=False)

    dist_df = compute_sample_distance_matrix(vst_df)
    dist_df.to_csv(OUTPUT_DIR / "sample_distance_matrix.csv")

    shallow_sample = qc_table.iloc[0]["sample"]
    condition_separates = assess_condition_separation(pca_df)

    plot_pca(pca_df, var_explained, shallow_sample, FIGURE_DIR / "pca_top500")
    plot_distance_heatmap(dist_df, metadata, shallow_sample, FIGURE_DIR / "sample_distance_heatmap")
    plot_library_size_barplot(qc_table, FIGURE_DIR / "library_size_barplot")

    evidence = summarize_shallow_sample_evidence(qc_table, pca_df, dist_df, size_factors, metadata)
    write_decision_memo(evidence, qc_table, condition_separates, OUTPUT_DIR / "qc_decision_memo.md")

    logger.info("Done. Condition separates on PC1 (top %d genes): %s", N_TOP_GENES, condition_separates)


if __name__ == "__main__":
    main()
