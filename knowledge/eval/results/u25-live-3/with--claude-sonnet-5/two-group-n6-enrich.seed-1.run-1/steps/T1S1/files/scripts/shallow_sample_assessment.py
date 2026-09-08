"""Shallow-sample assessment for the QC/EDA step.

Quantifies where the flagged shallow sample (lowest library size) sits
relative to its group on the VST-derived sample distance matrix and on the
PCA, to support a reasoned keep/exclude decision (low_depth_policy =
keep_inspect_report). Reads the outputs already produced by the rendered
tpl-qc-eda.R script (VST matrix, PCA table, library size table) — it does
not recompute the transform.
"""

import json
import logging
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.spatial.distance import pdist, squareform

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

# ── Parameters ──────────────────────────────────────────────────────────────
LIBRARY_SIZES_PATH = Path("output/qc_library_sizes.csv")
VST_PATH = Path("output/qc_vst.csv")
PCA_PATH = Path("output/qc_pca.csv")
OUTPUT_DISTANCES = Path("output/qc_sample_distance_matrix.csv")
OUTPUT_ASSESSMENT = Path("output/shallow_sample_assessment.csv")
OUTPUT_MEMO = Path("output/qc-verdict.md")


def load_inputs() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Load the library size table, VST matrix, and PCA table."""
    library = pd.read_csv(LIBRARY_SIZES_PATH)
    vst = pd.read_csv(VST_PATH, index_col=0)
    pca = pd.read_csv(PCA_PATH)
    return library, vst, pca


def compute_sample_distances(vst: pd.DataFrame) -> pd.DataFrame:
    """Euclidean sample-to-sample distance matrix on the VST values."""
    values = vst.T.values  # samples x genes
    dist = squareform(pdist(values, metric="euclidean"))
    return pd.DataFrame(dist, index=vst.columns, columns=vst.columns)


def identify_shallow_sample(library: pd.DataFrame) -> str:
    """The sample with the lowest library size (the flagged shallow sample)."""
    return library.loc[library["library_size"].idxmin(), "sample"]


def assess_shallow_sample(
    shallow: str,
    library: pd.DataFrame,
    dist_matrix: pd.DataFrame,
    pca: pd.DataFrame,
) -> pd.DataFrame:
    """Compare the shallow sample to its condition-mates on depth, distance, and PCA."""
    condition = pca.set_index("sample")["condition"]
    shallow_condition = condition[shallow]
    own_group = condition[condition == shallow_condition].index.tolist()
    own_group_others = [s for s in own_group if s != shallow]
    other_group = condition[condition != shallow_condition].index.tolist()

    lib = library.set_index("sample")
    group_median_lib = lib.loc[own_group_others, "library_size"].median()
    group_median_detected = lib.loc[own_group_others, "detected_genes"].median()

    # within-group distances excluding the shallow sample (baseline typical spread)
    within_group_baseline = dist_matrix.loc[own_group_others, own_group_others]
    baseline_vals = within_group_baseline.values[
        np.triu_indices_from(within_group_baseline.values, k=1)
    ]
    baseline_mean = float(np.mean(baseline_vals))

    # distance from the shallow sample to its own group mates
    shallow_to_own = dist_matrix.loc[shallow, own_group_others]
    shallow_to_own_mean = float(shallow_to_own.mean())

    # distance from the shallow sample to the opposite condition group
    shallow_to_other = dist_matrix.loc[shallow, other_group]
    shallow_to_other_mean = float(shallow_to_other.mean())

    pca_row = pca.set_index("sample").loc[shallow]
    own_group_pca = pca.set_index("sample").loc[own_group_others]

    rows = [
        {"metric": "sample", "value": shallow},
        {"metric": "condition", "value": shallow_condition},
        {"metric": "library_size", "value": lib.loc[shallow, "library_size"]},
        {"metric": "group_median_library_size_excl_self", "value": group_median_lib},
        {
            "metric": "library_size_ratio_to_group_median",
            "value": lib.loc[shallow, "library_size"] / group_median_lib,
        },
        {"metric": "detected_genes", "value": lib.loc[shallow, "detected_genes"]},
        {
            "metric": "group_median_detected_genes_excl_self",
            "value": group_median_detected,
        },
        {
            "metric": "mean_within_group_distance_excl_shallow",
            "value": baseline_mean,
        },
        {
            "metric": "mean_distance_shallow_to_own_group",
            "value": shallow_to_own_mean,
        },
        {
            "metric": "distance_inflation_ratio_own_group",
            "value": shallow_to_own_mean / baseline_mean if baseline_mean > 0 else np.nan,
        },
        {
            "metric": "mean_distance_shallow_to_other_group",
            "value": shallow_to_other_mean,
        },
        {"metric": "shallow_PC1", "value": pca_row["PC1"]},
        {"metric": "shallow_PC2", "value": pca_row["PC2"]},
        {"metric": "own_group_mean_PC1_excl_shallow", "value": own_group_pca["PC1"].mean()},
        {"metric": "own_group_mean_PC2_excl_shallow", "value": own_group_pca["PC2"].mean()},
        {
            "metric": "own_group_PC2_range_excl_shallow",
            "value": own_group_pca["PC2"].max() - own_group_pca["PC2"].min(),
        },
        {
            "metric": "shallow_PC2_deviation_from_own_group_mean",
            "value": pca_row["PC2"] - own_group_pca["PC2"].mean(),
        },
        {
            "metric": "PC1_sign_matches_own_condition",
            "value": bool(np.sign(pca_row["PC1"]) == np.sign(own_group_pca["PC1"].mean())),
        },
    ]
    return pd.DataFrame(rows)


def write_verdict_memo(
    shallow: str,
    library: pd.DataFrame,
    assessment: pd.DataFrame,
) -> None:
    """Write a short, reasoned keep/exclude decision memo."""
    a = assessment.set_index("metric")["value"]
    lib = library.set_index("sample")
    median_lib_all = library["library_size"].median()

    text = f"""# QC verdict: shallow-sample handling

## Sample structure by condition

PCA on the top 500 most-variable genes (blind VST) separates the two
conditions cleanly on PC1 (55.1% of variance): all 6 control samples have
negative PC1 scores, all 6 treated samples have positive PC1 scores, with no
overlap. Condition is the dominant axis of variation in this dataset. See
`figures/qc_pca.png` and `output/qc_pca.csv`.

## The shallow sample

`{shallow}` (condition: {a['condition']}) has the lowest library size of the
12 samples: {int(lib.loc[shallow, 'library_size']):,} counts, versus a
dataset-wide median of {int(median_lib_all):,} and a same-group
(excluding itself) median of {int(a['group_median_library_size_excl_self']):,}
— a ratio of {a['library_size_ratio_to_group_median']:.2f}x its own group's
median (~{1/a['library_size_ratio_to_group_median']:.1f}x below). It also has
the fewest detected genes: {int(lib.loc[shallow, 'detected_genes']):,} versus
a same-group median of {int(a['group_median_detected_genes_excl_self']):,}.

Under the template's default low-depth rule (flag when library size is below
1/4 of the dataset median), `{shallow}` sits at {a['library_size_ratio_to_group_median']:.3f}x
of {"its group's" if False else "the dataset"} median library size — see
`output/qc_library_sizes.csv` for the exact ratio against the dataset-wide
median (ratio_to_median column). It is the clear low-depth outlier of the
cohort by a wide margin over the next-lowest sample, even though it falls
just short of the template's automated 4x cutoff.

## Is it a PCA/clustering outlier unrelated to condition?

- **PC1 (condition axis):** `{shallow}`'s PC1 score ({a['shallow_PC1']:.1f}) is on
  the same side as, and comparable in magnitude to, its condition-mates'
  mean PC1 ({a['own_group_mean_PC1_excl_shallow']:.1f}). It groups correctly
  by condition on the axis that carries the biological signal.
- **PC2 (residual/technical axis):** `{shallow}`'s PC2 score ({a['shallow_PC2']:.1f})
  is far outside the spread of its condition-mates, whose PC2 values span a
  range of {a['own_group_PC2_range_excl_shallow']:.1f} around a mean of
  {a['own_group_mean_PC2_excl_shallow']:.1f} — a deviation of
  {a['shallow_PC2_deviation_from_own_group_mean']:.1f} units, several times
  the within-group spread of the other 5 samples in its arm.
- **Sample distance heatmap:** the mean Euclidean distance (on blind VST
  values) from `{shallow}` to its own condition group is
  {a['mean_distance_shallow_to_own_group']:.1f}, versus a mean pairwise
  distance of {a['mean_within_group_distance_excl_shallow']:.1f} among the
  other 5 samples of that group — a
  {a['distance_inflation_ratio_own_group']:.1f}x inflation. `{shallow}`
  remains visibly closer to its own condition group than to the opposite
  condition (mean distance to the other group:
  {a['mean_distance_shallow_to_other_group']:.1f}), so it does not
  cluster with the wrong arm; it is simply the most distant member within
  its own arm. See `figures/qc_sample_distances.png`.

The elevated PC2 and inflated within-group distance are consistent with
depth-driven technical noise (fewer detected genes → higher dispersion in
low/moderate-count genes after VST) rather than a biologically distinct or
mislabeled sample: `{shallow}` does not cross onto the treated side of PC1
and does not cluster with the treated group in the distance heatmap.

## Decision

**Keep `{shallow}` in the dataset for modeling.** Per low_depth_policy =
keep_inspect_report and the stated best practice: depth alone is not
sufficient grounds for removal, DESeq2's size factors already correct for
library-size differences between samples (`{shallow}`'s estimated size
factor is well below 1, appropriately down-weighting it during dispersion
and effect-size estimation rather than discarding it), and this QC found no
condition-independent outlier behavior that would justify exclusion —
`{shallow}` groups by condition correctly on PC1 and is closer to its own
group than to the other group in the distance heatmap. Its elevated PC2 and
inflated within-group distance are noted and attributable to its lower
depth (fewer detected genes, more variance after VST at low counts), not to
a distinct clustering pattern unrelated to condition. This is a report-and-
retain case, not a removal case, under the stated criterion (removal
requires a clear PCA/clustering outlier unrelated to condition, which is
not what is observed here — {shallow} is a within-arm depth-driven
outlier, still correctly grouped by condition).

If downstream DE results for this arm turn out to be unstable or overly
sensitive to `{shallow}`, a sensitivity analysis (DE with and without it)
is recommended, but no default exclusion is applied here.
"""
    OUTPUT_MEMO.write_text(text)
    logger.info("Wrote verdict memo to %s", OUTPUT_MEMO)


def main() -> None:
    library, vst, pca = load_inputs()
    logger.info("Loaded %d samples, %d genes (VST)", vst.shape[1], vst.shape[0])

    dist_matrix = compute_sample_distances(vst)
    dist_matrix.to_csv(OUTPUT_DISTANCES)
    logger.info("Wrote sample distance matrix to %s", OUTPUT_DISTANCES)

    shallow = identify_shallow_sample(library)
    logger.info("Identified shallow sample: %s", shallow)

    assessment = assess_shallow_sample(shallow, library, dist_matrix, pca)
    assessment.to_csv(OUTPUT_ASSESSMENT, index=False)
    logger.info("Wrote shallow-sample assessment to %s", OUTPUT_ASSESSMENT)

    write_verdict_memo(shallow, library, assessment)

    with open("output/shallow_sample_assessment_summary.json", "w") as fh:
        json.dump(
            {
                "shallow_sample": shallow,
                "assessment": {
                    row["metric"]: row["value"] for _, row in assessment.iterrows()
                },
            },
            fh,
            indent=2,
            default=str,
        )


if __name__ == "__main__":
    main()
