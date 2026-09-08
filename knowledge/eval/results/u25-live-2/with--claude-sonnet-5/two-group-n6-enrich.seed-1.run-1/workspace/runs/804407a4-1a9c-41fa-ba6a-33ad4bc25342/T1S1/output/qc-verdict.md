# Sample structure QC — 12-sample bulk RNA-seq (6 control / 6 treated)

## Method
- Raw count matrix (12,000 genes × 12 samples) and the condition sheet were loaded and matched 1:1 by sample id.
- `DESeqDataSetFromMatrix` with design `~ 1` (unsupervised), size factors estimated, then `vst(blind = TRUE)` (12,000 genes qualified for the regularized VST, so `vst()` was used rather than the slower `varianceStabilizingTransformation`).
- PCA on the top 500 most-variable genes by VST variance (`plotPCA`, `ntop = 500`).
- Euclidean sample-distance matrix on the full VST matrix, plotted as a hierarchically clustered heatmap, annotated by condition.
- Library size (total raw counts) and detected-gene count (count > 0) tabulated per sample; low-depth flag = library size < 1/4 of the cohort median (per template default, doi:10.1186/s13059-016-0881-8).
- No batch column exists in the metadata (confirmed absent in the profile), so PCA uses a single point shape and the heatmap carries only the condition annotation.

Script: `scripts/tpl-qc-eda.R` (rendered from `tpl-qc-eda@1.0.0`) + `scripts/compute_distance_matrix.R` (distance-matrix and per-sample distance-summary export for this report). All 12 samples were retained throughout — none was dropped.

## Do the 12 samples separate by condition?

**Yes, cleanly.** PC1 explains 55.1% of variance and separates the two conditions perfectly: all 6 control samples have PC1 between −18.4 and −16.2, all 6 treated samples have PC1 between +16.0 and +17.9 (`output/qc_pca.csv`). There is no overlap on PC1. PC2 explains a further 8.2% and does not track condition — it is dominated by a single sample (see below). The sample-distance heatmap (`figures/qc_sample_distances.png`) hierarchically clusters into the same two condition blocks. This is a strong, unconfounded condition signal for a two-group design with n=6 per arm.

## Library size and detected genes (all 12 samples)

Full table: `output/qc_library_sizes.csv`. Median library size = 1,614,280 counts.

| sample | condition | library_size | detected_genes | ratio_to_median |
|---|---|---:|---:|---:|
| sample_01 | control | 420,347 | 10,918 | **0.26×** |
| sample_02 | control | 1,140,853 | 11,506 | 0.71× |
| sample_03 | control | 1,635,227 | 11,580 | 1.01× |
| sample_04 | control | 2,694,991 | 11,720 | 1.67× |
| sample_05 | control | 1,569,900 | 11,621 | 0.97× |
| sample_06 | control | 2,006,669 | 11,674 | 1.24× |
| sample_07 | treated | 2,192,901 | 11,645 | 1.36× |
| sample_08 | treated | 1,520,768 | 11,565 | 0.94× |
| sample_09 | treated | 2,403,790 | 11,672 | 1.49× |
| sample_10 | treated | 1,437,892 | 11,535 | 0.89× |
| sample_11 | treated | 1,888,674 | 11,674 | 1.17× |
| sample_12 | treated | 1,593,333 | 11,558 | 0.99× |

Figure: `figures/qc_library_sizes.png` (library size and detected-gene bar charts per sample, colored by low-depth flag).

## The shallow sample: sample_01

**sample_01 (control) is the shallow sample.** Its library size (420,347 counts) is 0.26× the cohort median (1,614,280) — roughly **3.8-fold below the median**, by far the lowest of the 12 samples (the next-lowest, sample_02, is 0.71× median, i.e. within ~1.4-fold). It also has the fewest detected genes (10,918 vs. 11,506–11,720 for every other sample).

Applying the template's literature-based low-depth rule literally (flag if library size < 1/4 of the median, i.e. ratio < 0.25) does **not** trip for sample_01 — its ratio of 0.260 sits just above the 0.250 cutoff (`output/qc_summary.json`: `n_low_depth_samples: 0`). This is a borderline miss on an arbitrary threshold, not a substantive difference: sample_01 is unambiguously the depth outlier of the cohort by a wide margin over every other sample, and is reported as the flagged shallow sample this step is asked to characterize.

**PCA/heatmap behavior:**
- On **PC1** (condition axis, 55.1% variance), sample_01 sits at −18.37, comfortably inside the control cluster (control range −18.4 to −16.2) — it does **not** cross into the treated group. Condition assignment is preserved.
- On **PC2** (8.2% variance), sample_01 is a clear outlier: PC2 = +20.56, versus a range of −5.82 to +2.68 for all 11 other samples combined. PC2 is effectively a "sample_01 axis" — no other sample comes close to this value in either direction. This is consistent with low-depth-driven technical noise (higher dispersion / more zero-count genes at 420K reads) inflating variance in a way unrelated to the biological condition.
- **Distance summary** (`output/qc_distance_summary.csv`, `output/qc_sample_distances.csv`): sample_01's mean Euclidean distance to the rest of the cohort is 100.08, the highest of any sample (others range 89.8–92.3). Its mean distance to its own condition group (control, 95.40) is still lower than its mean distance to the treated group (103.98), so it clusters on the correct side of the heatmap dendrogram — but it is farther from its own control replicates (95.40) than any other sample is from its own group (83.6–87.5 for the rest of the cohort). In the heatmap this shows up as sample_01 joining the control block at a visibly longer branch length / lighter (more dissimilar) row-block than the tight sub-clustering among the other 5 control replicates.

**Verdict:** sample_01 is a mild-to-moderate structural outlier driven by its depth (correct condition placement on PC1 and in the heatmap's condition partition, but an outsized, condition-unrelated PC2 excursion and elevated within-group distance). It is **not** removed at this step per the `keep_inspect_report` policy. Its low depth (0.26× median, ~11K genes detected vs. ~11.5-11.7K for the rest) is a plausible technical explanation for its PC2/heatmap divergence, and this should be weighed explicitly at the DE step: it does not break condition separation (PC1, hierarchical clustering) so a case can be made either way; if DE results in the control group are found to be disproportionately influenced by sample_01 (e.g. via Cook's distance / leverage diagnostics in DESeq2, or by comparing DE results with/without it), exclusion should be justified there — not defaulted here.

## Acceptance-criteria check
- PCA plot + sample-distance heatmap for all 12 samples, colored by condition: `figures/qc_pca.png`/`.pdf`, `figures/qc_sample_distances.png`/`.pdf`. ✔
- Library size / detected-gene table, all 12 samples: `output/qc_library_sizes.csv`, plotted in `figures/qc_library_sizes.png`/`.pdf`. ✔
- Shallow sample explicitly identified with ratio-to-median and PCA/heatmap behavior: sample_01, 0.26× median, described above. ✔
- No sample dropped: all 12 samples present in every output table and figure; `qc_summary.json.n_samples = 12`. ✔
