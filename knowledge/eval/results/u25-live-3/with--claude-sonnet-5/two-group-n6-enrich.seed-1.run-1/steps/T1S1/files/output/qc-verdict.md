# QC verdict: shallow-sample handling

## Sample structure by condition

PCA on the top 500 most-variable genes (blind VST) separates the two
conditions cleanly on PC1 (55.1% of variance): all 6 control samples have
negative PC1 scores, all 6 treated samples have positive PC1 scores, with no
overlap. Condition is the dominant axis of variation in this dataset. See
`figures/qc_pca.png` and `output/qc_pca.csv`.

## The shallow sample

`sample_01` (condition: control) has the lowest library size of the
12 samples: 420,347 counts, versus a
dataset-wide median of 1,614,280 and a same-group
(excluding itself) median of 1,635,227
— a ratio of 0.26x its own group's
median (~3.9x below). It also has
the fewest detected genes: 10,918 versus
a same-group median of 11,621.

Under the template's default low-depth rule (flag when library size is below
1/4 of the dataset median), `sample_01` sits at 0.257x
of the dataset median library size — see
`output/qc_library_sizes.csv` for the exact ratio against the dataset-wide
median (ratio_to_median column). It is the clear low-depth outlier of the
cohort by a wide margin over the next-lowest sample, even though it falls
just short of the template's automated 4x cutoff.

## Is it a PCA/clustering outlier unrelated to condition?

- **PC1 (condition axis):** `sample_01`'s PC1 score (-18.4) is on
  the same side as, and comparable in magnitude to, its condition-mates'
  mean PC1 (-16.9). It groups correctly
  by condition on the axis that carries the biological signal.
- **PC2 (residual/technical axis):** `sample_01`'s PC2 score (20.6)
  is far outside the spread of its condition-mates, whose PC2 values span a
  range of 2.6 around a mean of
  -4.3 — a deviation of
  24.8 units, several times
  the within-group spread of the other 5 samples in its arm.
- **Sample distance heatmap:** the mean Euclidean distance (on blind VST
  values) from `sample_01` to its own condition group is
  95.4, versus a mean pairwise
  distance of 84.4 among the
  other 5 samples of that group — a
  1.1x inflation. `sample_01`
  remains visibly closer to its own condition group than to the opposite
  condition (mean distance to the other group:
  104.0), so it does not
  cluster with the wrong arm; it is simply the most distant member within
  its own arm. See `figures/qc_sample_distances.png`.

The elevated PC2 and inflated within-group distance are consistent with
depth-driven technical noise (fewer detected genes → higher dispersion in
low/moderate-count genes after VST) rather than a biologically distinct or
mislabeled sample: `sample_01` does not cross onto the treated side of PC1
and does not cluster with the treated group in the distance heatmap.

## Decision

**Keep `sample_01` in the dataset for modeling.** Per low_depth_policy =
keep_inspect_report and the stated best practice: depth alone is not
sufficient grounds for removal, DESeq2's size factors already correct for
library-size differences between samples (`sample_01`'s estimated size
factor is well below 1, appropriately down-weighting it during dispersion
and effect-size estimation rather than discarding it), and this QC found no
condition-independent outlier behavior that would justify exclusion —
`sample_01` groups by condition correctly on PC1 and is closer to its own
group than to the other group in the distance heatmap. Its elevated PC2 and
inflated within-group distance are noted and attributable to its lower
depth (fewer detected genes, more variance after VST at low counts), not to
a distinct clustering pattern unrelated to condition. This is a report-and-
retain case, not a removal case, under the stated criterion (removal
requires a clear PCA/clustering outlier unrelated to condition, which is
not what is observed here — sample_01 is a within-arm depth-driven
outlier, still correctly grouped by condition).

If downstream DE results for this arm turn out to be unstable or overly
sensitive to `sample_01`, a sensitivity analysis (DE with and without it)
is recommended, but no default exclusion is applied here.
