# Sample Structure QC Summary — Bulk RNA-seq (12 samples, 6 control vs 6 treated)

## Method

- **Transform:** `DESeqDataSetFromMatrix` with design `~ 1`, `estimateSizeFactors`, then `vst(blind = TRUE)` on the full 12,000-gene × 12-sample raw count matrix (`counts.csv`, `metadata.csv`). Confirmed by `output/qc_summary.json`: `"n_samples": 12`, `"n_genes": 12000`, `"design": "~ 1"`, `"method": "Sample structure QC: vst(blind = TRUE), PCA, sample distances, library sizes"`.
- **PCA:** top 500 most-variable genes post-VST (`output/qc_summary.json`: `"n_top_genes_pca": 500`), colored by condition.
- **Sample distances:** Euclidean distance on the full VST matrix, all 12×12 pairs (`output/qc_sample_distance_matrix.csv`).
- **Depth reporting:** library size (total raw counts) and detected-gene count (count > 0) per sample, flagged against `1/4` of the dataset median (`output/qc_summary.json`: `"low_depth_ratio": 4`).
- **Shallow-sample deep-dive:** a second script (`scripts/shallow_sample_assessment.py`) recomputed the Euclidean distance matrix from `output/qc_vst.csv` and cross-referenced it against `output/qc_pca.csv` and `output/qc_library_sizes.csv` to quantify whether the shallowest sample behaves as a condition-independent outlier.
- **Environment:** DESeq2 1.52.0, ggplot2 4.0.3, pheatmap 1.0.13, jsonlite 2.0.0, R 4.6.0 (aarch64-unknown-linux-gnu) — confirmed in `output/session_info.txt` and `output/qc_summary.json`.
- **Citations backing the template's defaults** (`output/decision_record.json`): DESeq2 (Love et al. 2014, doi:10.1186/s13059-014-0550-8), Conesa et al. 2016 best-practices survey (doi:10.1186/s13059-016-0881-8, source of the low-depth ratio default), and the F1000Research exploratory-analysis workflow (doi:10.12688/f1000research.7035.1, source of the top-500-genes PCA default).

## Key quantitative results

### Sample structure by condition
- Read from `output/qc_pca.csv`: PC1 cleanly separates the two arms — all 6 control samples have negative PC1 (range −18.37 to −16.15), all 6 treated samples have positive PC1 (range +16.01 to +17.92), with no overlap.
- `output/qc_summary.json`: `"percent_variance": {"PC1": 55.06, "PC2": 8.23}` — PC1 alone accounts for 55.06% of variance among the top 500 genes, and it aligns with condition.

### Library size and detected genes (`output/qc_library_sizes.csv`)

| sample | library_size | detected_genes | ratio_to_median | low_depth (4× rule) |
|---|---|---|---|---|
| sample_01 | 420,347 | 10,918 | 0.260 | FALSE |
| sample_02 | 1,140,853 | 11,506 | 0.707 | FALSE |
| sample_03 | 1,635,227 | 11,580 | 1.013 | FALSE |
| sample_04 | 2,694,991 | 11,720 | 1.669 | FALSE |
| sample_05 | 1,569,900 | 11,621 | 0.973 | FALSE |
| sample_06 | 2,006,669 | 11,674 | 1.243 | FALSE |
| sample_07 | 2,192,901 | 11,645 | 1.358 | FALSE |
| sample_08 | 1,520,768 | 11,565 | 0.942 | FALSE |
| sample_09 | 2,403,790 | 11,672 | 1.489 | FALSE |
| sample_10 | 1,437,892 | 11,535 | 0.891 | FALSE |
| sample_11 | 1,888,674 | 11,674 | 1.170 | FALSE |
| sample_12 | 1,593,333 | 11,558 | 0.987 | FALSE |

Dataset median library size (`output/qc_summary.json`): **1,614,280**. No sample crosses the template's automated 4× low-depth cutoff (`"n_low_depth_samples": 0`, `"low_depth_samples": []`), but `sample_01` sits nearest the threshold at 0.260× the dataset median.

### Size factors (`output/qc_summary.json`)
`sample_01 = 0.2877` — the lowest of all 12, and roughly 6.4× smaller than the largest (`sample_04 = 1.8545`), consistent with the raw library-size disparity.

### Shallow-sample assessment (`output/shallow_sample_assessment.csv`, `output/shallow_sample_assessment_summary.json`)
- Identified shallow sample: `sample_01` (condition: control).
- Library size 420,347 vs. same-group (excl. self) median 1,635,227 → ratio **0.257** (~3.9× below its own group's median).
- Detected genes 10,918 vs. same-group median 11,621.
- PC1 = −18.37, own-group mean PC1 (excl. self) = −16.92 → `sample_01` sits on the correct (control) side of the condition axis (`PC1_sign_matches_own_condition: true`).
- PC2 = 20.56, own-group mean PC2 (excl. self) = −4.28, own-group PC2 range (excl. self) = 2.63 → deviation of **24.84 units** from its group's PC2 mean, far exceeding the ~2.6-unit spread of the other 5 controls.
- Mean Euclidean distance from `sample_01` to its own group = 95.40, vs. mean pairwise distance among the other 5 controls = 84.35 → inflation ratio **1.13×**.
- Mean distance from `sample_01` to the treated group = 103.98 — larger than its distance to its own group, i.e., it remains closer to controls than to treated samples.
- Full pairwise distances in `output/qc_sample_distance_matrix.csv` confirm `sample_01`'s distances to the other 5 controls (93.87–96.48) are all smaller than its distances to any treated sample (102.83–104.91).

## Decision (recorded in `output/qc-verdict.md`)

**Keep `sample_01`.** Rationale, as stated in the verdict memo:
- It falls just short of the automated 4× low-depth cutoff (0.257 vs. 0.25) and depth alone is not adequate grounds for exclusion per the stated policy (`keep_inspect_report`).
- DESeq2's size factor (0.2877) already down-weights it appropriately during modeling rather than discarding its information.
- On the axis that carries the biological signal (PC1), it groups correctly with the control arm.
- Its distance-matrix behavior places it closer to its own condition group than to the opposite group — no condition-independent mislabeling or wrong-cluster pattern was observed.
- The elevated PC2 (24.84-unit deviation) and modest within-group distance inflation (1.13×) are attributed to depth-driven technical noise (fewer detected genes, higher VST variance at low/moderate counts), not to a distinct biological or QC-failure signature.
- A sensitivity check (differential expression with and without `sample_01`) is recommended if downstream control-arm results prove sensitive to it, but no default exclusion is applied at this stage.

## Quality notes and assumptions

- Design is unpaired, 6 vs. 6, single factor, no batch/subject/timepoint metadata (`metadata.csv` carries only `sample` and `condition`) — the DESeq2 design used for the blind VST is intentionally `~ 1`.
- Organism is not stated in any input file; this QC is organism-agnostic (raw counts and sample identities only) and does not depend on annotation, so this assumption does not affect the results above.
- n=6 per arm is small for variance estimation in general, but this step is QC/EDA, not the differential-expression model itself.

## Limitations

- The automated low-depth flag (4× ratio) did not trigger for `sample_01` even though it is visibly the shallowest sample by a wide margin over the next-lowest (`sample_02` at 0.707×) — the deep-dive assessment was necessary specifically because the mechanical rule under-flagged a sample the task context identified as shallow.
- The keep/exclude decision for `sample_01` is a QC judgment call based on PCA/distance evidence gathered in this step; it is not re-validated against downstream DE model stability here — a with/without sensitivity analysis at the modeling stage was recommended but not performed as part of this QC step.
- PC2 (8.23% of variance) is a low-variance axis; `sample_01`'s large deviation on it is notable but explains a small fraction of total variance, and its interpretation as "depth-driven noise" versus an unmodeled biological effect cannot be fully disambiguated from PCA/distance evidence alone.
- ~63% of gene identifiers in the input matrix are synthetic placeholder IDs (per the data profile), which does not affect this count-based QC but limits any biological interpretation of which genes drive the PC1/PC2 structure.