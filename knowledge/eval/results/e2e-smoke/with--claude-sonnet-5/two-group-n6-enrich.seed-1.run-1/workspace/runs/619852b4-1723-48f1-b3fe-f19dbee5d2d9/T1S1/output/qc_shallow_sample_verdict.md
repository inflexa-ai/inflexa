# Sample structure QC and shallow-sample assessment — T1S1

Method: `tpl-qc-eda@1.0.0` (M-0006) — `scripts/tpl-qc-eda.R`. DESeqDataSet with
design `~ 1`, `vst(blind = TRUE)`, PCA on the top 500 most-variable genes,
Euclidean sample-distance heatmap, library-size / detected-gene table, all
computed from the actual `counts.csv` / `metadata.csv` in
`data/inputs/local/`. Full numeric outputs: `output/qc_library_sizes.csv`,
`output/qc_pca.csv`, `output/qc_vst.csv`, `output/qc_summary.json`. Figures:
`figures/qc_pca.{png,pdf}`, `figures/qc_sample_distances.{png,pdf}`,
`figures/qc_library_sizes.{png,pdf}`.

## 1. Counts provenance: confirmed raw integer counts

`counts.csv` is **12,000 genes x 12 samples** (see note below on a profile
discrepancy), values are non-negative integers, min = 0,
max = 26,238, and every cell equals its own rounded value (no fractional
entries). The rendered script hard-fails ("must hold non-negative integers ...
not TPM or FPKM") if this were violated, and it did not fail. Per-sample
library sizes span ~420K–2.7M reads with no evidence of prior scaling
(TPM/FPKM would compress the range and force non-integer values). **This
confirms `counts.csv` holds raw, unnormalized integer read counts**, the
correct input for DESeq2's own size-factor normalization — consistent with
the data profile's caveat on this point.

Note: the data profile's overview text states counts.csv has "5702 genes";
the file actually read from disk has 12,000 gene rows (12,001 lines including
header), matching the 12,000-row `gene_lengths.csv` exactly. This script used
the real file on disk (verified with `wc -l`), so all counts below are over
12,000 genes, not 5702. This is a discrepancy in the upstream profile
description, not in the data itself, and does not affect this QC step's
conclusions.

## 2. Library size and detected-gene count, all 12 samples

Median library size = **1,614,280** counts. Median detected genes (count > 0)
across the cohort ≈ 11,610 (range 11,506–11,720 for the 11 non-flagged
samples).

| sample | condition | library_size | ratio to median | detected_genes |
|---|---|---:|---:|---:|
| **sample_01** | control | **420,347** | **0.26×** | **10,918** |
| sample_02 | control | 1,140,853 | 0.71× | 11,506 |
| sample_10 | treated | 1,437,892 | 0.89× | 11,535 |
| sample_08 | treated | 1,520,768 | 0.94× | 11,565 |
| sample_05 | control | 1,569,900 | 0.97× | 11,621 |
| sample_12 | treated | 1,593,333 | 0.99× | 11,558 |
| sample_03 | control | 1,635,227 | 1.01× | 11,580 |
| sample_11 | treated | 1,888,674 | 1.17× | 11,674 |
| sample_06 | control | 2,006,669 | 1.24× | 11,674 |
| sample_07 | treated | 2,192,901 | 1.36× | 11,645 |
| sample_09 | treated | 2,403,790 | 1.49× | 11,672 |
| sample_04 | control | 2,694,991 | 1.67× | 11,720 |

**sample_01 is the flagged shallow sample.** Its library size (420,347) is
0.26× the cohort median and is the lowest of all 12 samples by a wide margin:
the next-lowest sample (sample_02, 1,140,853) has 2.7× more reads. Its
detected-gene count (10,918) is also the lowest in the cohort, but only ~6%
below the median (~11,610) — most genes are still detected, this is a depth
effect, not a dropout/failure signature. Under the template's standard
low-depth rule (< 1/4 of the median library size, following the QC
conventions surveyed in Conesa et al., *Genome Biology* 2016,
doi:10.1186/s13059-016-0881-8), sample_01 sits at 0.26×, just above the 0.25×
cutoff — it does **not** cross the formal low-depth flag threshold, but it is
unambiguously the depth outlier of the study by rank and by gap size to the
next sample.

## 3. PCA and sample-distance structure: does sample_01 separate from its condition group?

**No — it does not separate from the control group on the axis that encodes
condition.** PC1 (55.1% of variance, `output/qc_pca.csv`) is the
condition-separating axis: all 6 control samples score −16.2 to −18.4 and all
6 treated samples score +16.0 to +17.9, a clean, complete separation with no
overlap. sample_01 scores **PC1 = −18.37**, comfortably inside the control
range and on the "correct" side — it is not pulled toward treated.

sample_01 *is* an outlier on **PC2** (8.2% of variance): PC2 = **+20.56**,
starkly different from the other 5 controls (−3.2 to −5.8) and from all
treated samples (−1.2 to +2.7). This is consistent with sample_01's much
lower sequencing depth injecting extra technical noise/variance that shows up
on a minor axis, not with a condition mislabel or biological outlier.

Quantitative confirmation from the VST Euclidean distance matrix
(`figures/qc_sample_distances.png`, distances computed directly from
`output/qc_vst.csv`): sample_01's mean distance to the other 5 control
samples (95.4) is smaller than its mean distance to the 6 treated samples
(104.0) — it clusters with its own condition group, as every other sample
does. Its within-control-group distance (95.4) is somewhat elevated versus
the other controls' within-group distances (85.6–87.5), i.e. sample_01 is a
mild, noisier outlier *within* its correct cluster, not a sample that groups
with the wrong condition or floats alone between groups.

## 4. Recommendation: **KEEP sample_01** for the downstream DE step (T1S2)

Reasoning, not a default:

1. **It does not cross the condition boundary.** On PC1 — the axis that
   actually encodes control vs. treated (55% of variance, clean 6/6
   separation) — sample_01 sits squarely with the other controls, and its
   nearest-neighbor distance confirms it clusters with control, not treated.
   The elevated variance it shows is confined to a minor axis (PC2, 8%),
   consistent with technical noise from lower depth rather than a
   condition-confounding or mislabeling problem.
2. **Depth loss is moderate, not catastrophic.** 10,918 of ~12,000 genes are
   still detected (91%), only ~6% fewer than the cohort median. This is not
   an empty or failed library.
3. **It does not cross the study's own low-depth threshold** (0.26× vs. a
   0.25× cutoff) — it is the depth outlier of the cohort, but only just.
4. **DESeq2 already models this.** The per-sample size factor for sample_01
   (0.29, `output/qc_summary.json`) is the smallest in the cohort and will
   correctly down-weight/rescale its counts in the DE model; DESeq2's
   negative-binomial framework is built to handle moderate library-size
   heterogeneity through size-factor normalization and shrinkage, which is
   why raw counts (not pre-normalized values) are required as input in the
   first place.
5. **Power cost of exclusion is high for this design.** n = 6 per arm is
   already the entire replication budget; dropping to n = 5 controls removes
   ~17% of the control arm's replicates for a sample that clusters correctly
   by condition. Exclusion should be reserved for samples that fail QC more
   fundamentally (misclustering by condition, corrupted/near-empty library,
   metadata mismatch) — none of which apply here.

**Action for T1S2:** keep sample_01 in the primary DE model. As a due-diligence
sensitivity check (optional, not required to proceed), T1S2 can re-run the
control-vs-treated contrast with sample_01 excluded and confirm the set of
significant genes is not driven by it — but there is no QC basis here to drop
it by default.
