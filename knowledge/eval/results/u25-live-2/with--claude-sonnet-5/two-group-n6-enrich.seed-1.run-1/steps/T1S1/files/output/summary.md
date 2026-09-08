# Sample Structure QC — 12-Sample Bulk RNA-seq (6 Control / 6 Treated)

## What was done
DESeq2's `vst(blind = TRUE)` variance-stabilizing transform was applied to the 12,000-gene × 12-sample raw count matrix (design `~ 1`, i.e. no condition information used in the transform), PCA was computed on the top 500 most-variable genes, a Euclidean sample-distance matrix/heatmap was built on the full VST matrix, and library size + detected-gene counts were tabulated per sample. All 12 samples were kept throughout; none was removed. Scripts: `scripts/tpl-qc-eda.R` (rendered from template `tpl-qc-eda@1.0.0`) and `scripts/compute_distance_matrix.R` (auxiliary distance-matrix/summary export).

## Key quantitative results

**Condition separation (`output/qc_pca.csv`, `output/qc_summary.json`)**
- PC1 explains **55.06%** of variance and separates the two conditions with no overlap: all 6 control samples fall between PC1 = −18.37 and −16.15; all 6 treated samples fall between PC1 = +16.01 and +17.92.
- PC2 explains **8.23%** of variance and does not track condition.

**Library sizes and detected genes (`output/qc_library_sizes.csv`)** — median library size = 1,614,280 counts:

| sample | condition | library_size | detected_genes | ratio_to_median |
|---|---|---:|---:|---:|
| sample_01 | control | 420,347 | 10,918 | 0.260 |
| sample_02 | control | 1,140,853 | 11,506 | 0.707 |
| sample_03 | control | 1,635,227 | 11,580 | 1.013 |
| sample_04 | control | 2,694,991 | 11,720 | 1.669 |
| sample_05 | control | 1,569,900 | 11,621 | 0.973 |
| sample_06 | control | 2,006,669 | 11,674 | 1.243 |
| sample_07 | treated | 2,192,901 | 11,645 | 1.358 |
| sample_08 | treated | 1,520,768 | 11,565 | 0.942 |
| sample_09 | treated | 2,403,790 | 11,672 | 1.489 |
| sample_10 | treated | 1,437,892 | 11,535 | 0.891 |
| sample_11 | treated | 1,888,674 | 11,674 | 1.170 |
| sample_12 | treated | 1,593,333 | 11,558 | 0.987 |

Applying the template's literal low-depth rule (flag if ratio < 1/4 = 0.250) yields `n_low_depth_samples: 0` in `output/qc_summary.json` — sample_01's ratio of 0.260 sits just above that cutoff. It is nonetheless the clear depth outlier of the cohort by a wide margin (next-lowest ratio is 0.707).

**The shallow sample — sample_01**
- Library size 420,347 = **0.26× the cohort median**, ~3.8-fold below median; fewest detected genes (10,918 vs. 11,506–11,720 everywhere else).
- On PC1 it sits at −18.37, comfortably inside the control range — condition placement is correct.
- On PC2 it is a stark outlier at +20.56, versus a range of −5.82 to +2.68 for all 11 other samples (`output/qc_pca.csv`) — PC2 is effectively driven by this one sample.
- Per `output/qc_distance_summary.csv`: sample_01's mean Euclidean distance to the rest of the cohort is **100.08**, the highest of any sample (others range 89.81–92.25). Its mean distance to its own condition group (control, 95.40) is lower than to the treated group (103.98), so it clusters on the correct side of the dendrogram, but it is farther from its own control replicates than any other sample is from its own group (83.57–87.53 for the rest of the cohort, per the same file). Full pairwise distances are in `output/qc_sample_distances.csv`.

**Environment/versions (`output/qc_summary.json`, `output/session_info.txt`)**: R 4.6.0, DESeq2 1.52.0, ggplot2 4.0.3, pheatmap 1.0.13.

## Method choices and rationale
- **vst(blind = TRUE), design `~ 1`**: standard for unsupervised QC — avoids using the condition label to shape the transform that will then be used to *assess* condition-related structure. `output/qc_summary.json` confirms `vst()` (not the slower `varianceStabilizingTransformation`) was used because ≥1000 genes had mean normalized count > 5.
- **Top 500 variable genes for PCA** (`n_top_genes_pca = 500`): the template default (doi:10.12688/f1000research.7035.1), used to focus PCA on genes carrying most of the biological signal rather than noise from lowly variable genes.
- **Low-depth ratio = 4** (doi:10.1186/s13059-016-0881-8): a literature-grounded default threshold used to flag samples with a library size below 1/4 of the cohort median; applied here as a diagnostic label only, not an automatic exclusion rule.
- **No batch adjustment**: `batch_column` is null in `output/qc_summary.json` because the metadata sheet has no batch/timepoint field — PCA uses a single point shape and the heatmap has only a condition annotation.
- **Sample not removed**: per the `keep_inspect_report` policy, sample_01 was retained through this step; the auxiliary distance-summary script was written specifically to quantify (not just visually describe) its divergence from its own group for a later, explicit removal decision.

## Quality notes
- n = 6 per arm, balanced design, no pairing/subject/batch information recorded (per `output/decision_record.json` slot bindings and the source metadata).
- Group sizes confirmed in `output/qc_summary.json`: `control: 6, treated: 6`.
- Size factors (DESeq2, `output/qc_summary.json`) range from 0.2877 (sample_01) to 1.8545 (sample_04), consistent with the wide spread in raw library sizes.
- Citations backing the method are recorded in `output/decision_record.json`: DESeq2 (doi:10.1186/s13059-014-0550-8), RNA-seq best-practices survey (doi:10.1186/s13059-016-0881-8), and the exploratory-analysis workflow reference (doi:10.12688/f1000research.7035.1).

## Limitations
- The 4× low-depth threshold is an arbitrary convention; sample_01 misses it narrowly (ratio 0.260 vs. cutoff 0.250) despite being the unambiguous depth outlier of the cohort — a threshold-based flag alone would have missed it, and the ratio-based table plus PCA/distance behavior were needed to characterize it properly.
- PC1/PC2 percent variance (55.06% / 8.23%) leaves ~37% of the top-500-gene variance unexplained by the first two components; this analysis does not examine PC3+ or use library-size-corrected leverage diagnostics (e.g., DESeq2 Cook's distances), so the full extent of sample_01's influence on downstream DE testing is not established here.
- No batch or subject-level covariate exists in the input, so any structure beyond condition and depth (including unrecorded technical batches) cannot be assessed or ruled out.
- This is a QC/EDA step only; it does not perform or report any differential expression testing, and the decision on whether to exclude sample_01 is explicitly deferred to that later step per the stated policy.