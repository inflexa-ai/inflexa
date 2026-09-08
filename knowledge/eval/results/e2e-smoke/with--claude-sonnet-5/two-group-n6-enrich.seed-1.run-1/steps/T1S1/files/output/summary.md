# T1S1 Summary — Sample Structure QC and Shallow-Sample Assessment

## What was run

Rendered and executed the grounded template `tpl-qc-eda@1.0.0` (method `M-0006`, snapshot `sha256:90c687582244894c67c212e63855415984027bcd54c896821c4e065cf8b5467a`, per `output/decision_record.json`) as `scripts/tpl-qc-eda.R`. Pipeline: build a `DESeqDataSet` with design `~ 1` from raw counts, `estimateSizeFactors`, blind `vst(blind = TRUE)`, PCA on the top 500 most-variable genes, a Euclidean sample-distance heatmap on the VST matrix, and a per-sample library-size / detected-gene table with a low-depth flag. Environment pins (`output/decision_record.json`, `output/session_info.txt`): R 4.6.0, DESeq2 1.52.0, ggplot2 4.0.3, pheatmap 1.0.13, jsonlite 2.0.0 — all resolved as `"exact"` matches.

## Key quantitative results

**Cohort scale** (`output/qc_summary.json`): 12 samples, 12,000 genes, 6 control / 6 treated (`group_sizes`). Median library size = **1,614,280** counts.

**Library size and detected genes, all 12 samples** (`output/qc_library_sizes.csv`):

| sample | condition* | library_size | ratio to median | detected_genes |
|---|---|---:|---:|---:|
| sample_01 | control | 420,347 | 0.260 | 10,918 |
| sample_02 | control | 1,140,853 | 0.707 | 11,506 |
| sample_10 | treated | 1,437,892 | 0.891 | 11,535 |
| sample_08 | treated | 1,520,768 | 0.942 | 11,565 |
| sample_05 | control | 1,569,900 | 0.973 | 11,621 |
| sample_12 | treated | 1,593,333 | 0.987 | 11,558 |
| sample_03 | control | 1,635,227 | 1.013 | 11,580 |
| sample_11 | treated | 1,888,674 | 1.170 | 11,674 |
| sample_06 | control | 2,006,669 | 1.243 | 11,674 |
| sample_07 | treated | 2,192,901 | 1.358 | 11,645 |
| sample_09 | treated | 2,403,790 | 1.489 | 11,672 |
| sample_04 | control | 2,694,991 | 1.669 | 11,720 |

*condition mapping cross-referenced from `output/qc_pca.csv`.

None of the 12 samples were marked `low_depth = TRUE` under the template's default rule (< 0.25× median library size; `n_low_depth_samples = 0` in `output/qc_summary.json`). **sample_01** is nonetheless the flagged shallow sample by inspection: its library size (420,347, ratio 0.260) sits just above the 0.25× cutoff but is the lowest in the cohort by a wide margin — the next-lowest sample (sample_02, 1,140,853) has 2.7× more reads. Its detected-gene count (10,918) is also the cohort minimum, ~6% below the ~11,610 median of the other 11 samples.

**PCA** (`output/qc_pca.csv`, `output/qc_summary.json`): PC1 explains 55.06% of variance, PC2 8.23% (`percent_variance`), computed on the top 500 most-variable genes (`n_top_genes_pca = 500`). PC1 cleanly separates condition with no overlap: all 6 controls score −18.37 to −16.15, all 6 treated score +16.01 to +17.92. sample_01 scores PC1 = −18.37 (inside the control range) but PC2 = +20.56, far outside the other 5 controls' PC2 range (−5.82 to −3.20) and outside the treated range (−1.20 to +2.68).

**Size factors** (`output/qc_summary.json`, `size_factors`): sample_01 = 0.2877, the smallest in the cohort (next-smallest sample_02 = 0.7591; range across all 12 is 0.2877–1.8545).

**Counts provenance** (per the QC script's build-time validation and the values in `data/inputs/local/counts.csv`, as documented in `output/qc_shallow_sample_verdict.md`): counts are non-negative integers, min = 0, max = 26,238, no fractional entries; the rendered script hard-stops on any non-integer/negative value and did not stop. This confirms `counts.csv` holds raw, unnormalized integer read counts, not TPM/FPKM.

**Data-profile discrepancy noted:** the upstream data profile's overview text states counts.csv has 5,702 genes; the file actually loaded and analyzed here has 12,000 gene rows (matching `gene_lengths.csv`'s 12,000 rows exactly). All figures above are computed over the real 12,000-gene matrix on disk.

## Method choices and rationale

- **Blind VST (`vst(blind=TRUE)`)** rather than the design-aware transform, so the QC/EDA step cannot be influenced by the condition labels — appropriate for an unbiased structure check before any DE model is fit.
- **Design `~ 1`** for the `DESeqDataSet` used only to obtain size factors and the VST; no contrast is estimated at this step.
- **Top-500-variable-gene PCA** is the template default (`n_top_genes_pca = 500`, sourced to doi:10.12688/f1000research.7035.1 per `output/decision_record.json`), standard practice to focus PCA on genes carrying the most information rather than noise.
- **Low-depth flag at 1/4 of median library size** (`low_depth_ratio = 4`, sourced to Conesa et al. 2016, doi:10.1186/s13059-016-0881-8) is the template's built-in convention; it is a threshold, not a verdict — sample_01 does not cross it but is still the clear cohort outlier by rank and gap size, so it was reported explicitly rather than silently passed.
- **Euclidean distance on VST values** for the sample-distance heatmap is the standard DESeq2-recommended diagnostic for gross outliers and mislabeling.

## Quality notes and assumptions

- Sample size is small and fixed: n = 6 per arm, no batch/timepoint/pairing metadata available (per the data profile), so this QC is a within-cohort relative comparison only — there is no external reference cohort to calibrate "normal" depth against.
- The `low_depth_ratio = 4` threshold is a template default sourced from general RNA-seq QC literature, not tuned to this specific dataset; sample_01's ratio (0.260) is close enough to the 0.25 cutoff that the binary flag is sensitive to the exact threshold chosen.
- PC2 (8.23% of variance) is a minor axis; sample_01's outlier position there is being interpreted as depth-driven technical noise rather than biological signal, based on the size-factor and library-size evidence, not on an independent noise decomposition.

## Limitations

- This step assesses structure and depth only; it does not run or preview any differential expression contrast, so its recommendation to keep sample_01 is a QC judgment, not a validated confirmation that DE results are insensitive to sample_01 — the summary explicitly proposes an optional sensitivity re-run at T1S2 to confirm this.
- The data-profile's stated gene count (5,702) does not match the 12,000 genes actually present in `counts.csv`; this analysis used the real file, but the discrepancy signals the upstream profile description should not be trusted uncritically for other claims either.
- Organism identity (human) and tissue/cell type remain unconfirmed by any input metadata (per the data profile caveats); this QC step does not depend on organism identity, but downstream annotation-dependent steps will inherit that uncertainty.
- No batch or technical-replicate structure exists in the metadata, so it is not possible to determine whether sample_01's low depth stems from a specific technical cause (e.g., library prep, lane) versus a general biological/handling artifact.