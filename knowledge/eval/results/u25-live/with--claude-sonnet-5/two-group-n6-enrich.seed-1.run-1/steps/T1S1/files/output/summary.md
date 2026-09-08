# Sample Structure QC Summary: Blind VST, PCA, Sample Distances, and Shallow-Sample Evidence

## Bottom line

The 12 samples (6 control, 6 treated) separate cleanly by condition on the top-500-variable-gene PCA — no overlap between groups on PC1. The flagged shallow sample, **sample_01** (control), is 3.84× below the cohort median library size, sits correctly within its condition cluster on PC1, but is a large outlier on PC2 relative to its five control replicates. Combined with a materially reduced detected-gene count and a low DESeq2 size factor, the QC evidence supports **excluding sample_01 from the primary DE contrast and reporting results with and without it** — a decision made from the assembled evidence, not a default action, and documented in `output/qc_decision_memo.md` without deleting the sample from any QC artifact.

## Method choices and rationale

- **Blind VST via PyDESeq2** (`dds.vst(use_design=False)`), confirmed in `scripts/sample_qc.py`, is PyDESeq2's default and fits dispersions/trend using an intercept-only design — equivalent to R DESeq2's `vst(dds, blind=TRUE)`. This keeps the transform unbiased for QC/clustering, per the constraint `transform = vst_blind`.
- **All-zero genes were filtered before VST** (`filter_all_zero_genes()` in `scripts/sample_qc.py`), the standard pre-VST filter from the DESeq2 workflow, since genes with zero counts in every sample cannot support log-based size-factor/dispersion estimation.
- **PCA on the top 500 most-variable genes** (`N_TOP_GENES = 500` in `scripts/sample_qc.py`, output written to `output/top500_variable_genes.csv`), per the constraint `n_top_genes = 500`. Genes were ranked by variance across samples in blind-VST space.
- **Sample-to-sample Euclidean distance** was computed on the full blind-VST matrix (all filtered genes), not restricted to the top 500, following the standard DESeq2 QC convention — distinct from the PCA gene subset, and reported separately in `output/sample_distance_matrix.csv`.
- **Library size and detected-gene counts** were computed directly on the raw `counts.csv` matrix (not VST-transformed), so the QC table in `output/library_size_qc.csv` reflects unnormalized sequencing depth.
- The low-depth sample was **kept through every QC computation** (VST, PCA, distance matrix, library-size ranking) per the `keep_inspect_report` policy; only a downstream-analysis recommendation was made, in `output/qc_decision_memo.md`.

## Key quantitative results

### Library size and detected genes (`output/library_size_qc.csv`, `output/qc_decision_memo.md`)

- 12 samples total: 6 control (sample_01–06), 6 treated (sample_07–12).
- Library size ranges from 420,347 reads (sample_01) to 2,694,991 reads (sample_04); cohort median = 1,614,280 reads.
- Detected genes (count > 0) range from 10,918 (sample_01) to 11,720 (sample_04).
- **sample_01 is the shallowest sample**: 420,347 reads, **3.84× below** the cohort median (`fold_below_median = 3.8403509481452227`), with 10,918 detected genes versus a cohort median of 11,600. It ranks 1 of 12 by depth (`depth_rank = 1`), and is the only sample flagged (`flag_shallow = True`).
- The next-shallowest sample (sample_02, control) is only 1.41× below median (1,140,853 reads) — a much smaller gap than sample_01's.

### PCA on top 500 variable genes (`output/pca_coordinates.csv`)

- PC1 separates the two conditions with no overlap: control samples occupy PC1 ≈ −18.39 to −16.10; treated samples occupy PC1 ≈ +16.02 to +17.86.
- On PC2, sample_01 (control) sits at −20.56, while the other five control samples cluster tightly between +3.27 and +5.80 — a stark, isolated deviation on the second axis despite sample_01's normal position on PC1.
- These raw z-score computations, reported in `output/qc_decision_memo.md`, quantify this: sample_01's PC1 deviates from its own group by −1.92 SD, but its PC2 deviates by **−23.77 SD**.

### Sample-to-sample Euclidean distance (`output/sample_distance_matrix.csv`)

- sample_01's distances to the other five control samples are 96.49 (sample_02), 95.26 (sample_03), 93.88 (sample_04), 96.02 (sample_05), and 95.38 (sample_06) — mean 95.41.
- The baseline within-group distance among the other five controls (excluding sample_01) is 84.36 (`output/qc_decision_memo.md`).
- sample_01's mean distance to the treated group is 103.98 — larger than its distance to its own group (95.41), so on the full-transcriptome distance metric it is still closer to control than to treated, though the gap to its own group is elevated (~13%) relative to baseline.

### DESeq2 size factor (`output/qc_decision_memo.md`)

- sample_01's fitted median-of-ratios size factor is 0.288, versus a cohort median of 1.076 — roughly proportional to its lower read depth, meaning the count model already down-weights its contribution to normalization and dispersion fitting.

## Decision on the shallow sample

**EXCLUDE from the primary DE contrast; retain in QC and report results with and without it (sensitivity analysis)** — stated and justified in `output/qc_decision_memo.md`. The rationale: sample_01's low depth is accompanied by a large, structural PC2 deviation (−23.77 SD from its own condition group) on the top-500-gene PCA that goes well beyond what the depth-proportional size-factor down-weighting can absorb, even though the full-transcriptome distance elevation is comparatively modest and the sample still falls correctly on the condition axis (PC1). This is not a default drop — the evidence was assembled across four independent QC lenses (library size, detected genes, PCA, distance matrix) before the call was made, and the sample was not removed from any QC computation or output file.

## Quality notes and caveats

- n=6/6 balanced design; only 12 samples total, so per-condition PCA/distance statistics (e.g., the "baseline within-group distance" used to judge sample_01) are themselves computed from only 5 remaining same-condition replicates — a small denominator that limits precision.
- No subject/donor identifier separate from `sample` exists in the input metadata, so biological independence of replicates is assumed, not confirmed (stated in `output/qc_decision_memo.md`).
- Genes with zero counts across all 12 samples were removed before VST fitting; this is a standard pre-processing step, not a sample-level exclusion.

## Limitations

- **No batch/lane/run-date field exists in metadata.csv.** Batch effects cannot be assessed or corrected for — the PC2 divergence and elevated own-group distance for sample_01 cannot be attributed to a specific technical cause (batch vs. biology vs. depth) with the available metadata. This limitation is recorded explicitly in `output/qc_decision_memo.md`.
- This QC step does not run differential expression; the retain/exclude call concerns sample-structure input to a downstream DE analysis, not a DE result itself.
- Variance-explained percentages for PC1/PC2 were computed during the analysis but are not persisted in any output artifact, so they are not reported here as citable numbers.

## Output files produced

`output/vst_blind_counts.csv`, `output/pca_coordinates.csv`, `output/top500_variable_genes.csv`, `output/sample_distance_matrix.csv`, `output/library_size_qc.csv`, `output/qc_decision_memo.md`, `figures/pca_top500.{png,pdf}`, `figures/library_size_barplot.{png,pdf}`, `figures/sample_distance_heatmap.{png,pdf}`, `scripts/sample_qc.py`.