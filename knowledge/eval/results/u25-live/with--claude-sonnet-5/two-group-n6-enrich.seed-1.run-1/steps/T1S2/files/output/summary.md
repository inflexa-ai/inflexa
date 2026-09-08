# DESeq2 Differential Expression: Treated vs Control

## Bottom Line

The primary contrast (treated sample_07–12 vs control sample_02–06, with the QC-flagged shallow sample_01 excluded) identifies **826 significantly differentially expressed genes** at BH-adjusted p < 0.05 (Wald test, apeglm-shrunken log2FC): **486 up in treated, 340 down** (`output/deseq2_results_summary_primary.txt`), out of 10,071 genes that passed the pre-filter and were tested (`output/na_breakdown_primary.csv`). A parallel sensitivity run retaining sample_01 (n=6 vs 6) found **875 significant genes** (`output/sensitivity_vs_primary_comparison.csv`), with shrunken log2FC estimates correlating at Pearson r = 0.9889 against the primary run across 9,782 genes tested in both (`output/sensitivity_vs_primary_comparison.csv`) — 780 genes significant in both runs, 28 significant only when sample_01 is excluded, 95 only when it is included.

## Count Provenance

- `output/count_provenance_stats.csv`: all counts integer-valued (`is_integer_valued = TRUE`, 0 negative values), value range [0, 26238].
- Per-sample library sizes: min 420,347, median 1,614,280, max 2,694,991 — library-scale, not TPM's fixed ~1,000,000 sum (`tpm_like_sums_to_1e6 = FALSE`).
- Gene sets match exactly between counts.csv and gene_lengths.csv (12,000 genes in each, `gene_set_matches_length_reference = TRUE`).
- Spearman correlation between per-gene mean count and gene length: **rho = −0.0133, p = 0.1456** (`output/count_provenance_stats.csv`, `output/count_provenance.md`) — essentially null, arguing against the counts already being length-divided (a true FPKM/TPM-style length division would leave a mechanical negative correlation), though this diagnostic alone does not conclusively prove the matrix is raw.
- Post-hoc repeat on the DE result itself: shrunken log2FC vs. gene length gives **rho = 0.00594, p = 0.5509** across 10,071 genes (`output/lfc_vs_length_diagnostic_primary.csv`) — no residual length-associated bias detected.

## Method Choices and Rationale

- **Sample sheet** (`output/sample_sheet_deseq2.csv`): single shared sheet marking sample_01 `excluded_primary = TRUE` with its exclusion rationale recorded in the `exclusion_reason` field, so the T1S1 QC decision is applied identically in both the primary and sensitivity scripts rather than re-decided per script.
- **Pre-filter**: gene kept if ≥10 counts in ≥ the smallest arm size of the samples actually modeled — 5 for the primary run (5 control + 6 treated after excluding sample_01), 6 for the sensitivity run (6 vs 6). This yielded 10,071 genes tested in primary (`output/na_breakdown_primary.csv`) and 9,782 in sensitivity (`output/na_breakdown_sensitivity.csv`).
- **Design**: `~condition`, with `condition` releveled so `control` is the explicit reference, per the DESeq2 vignette note on factor levels.
- **Normalization**: DESeq2's internal median-of-ratios size factors only. Primary-run size factors (`output/size_factors_primary.csv`) range from 0.6711 (sample_02) to 1.6493 (sample_04) across the 11 modeled samples — no pre-normalization of counts was applied before the model.
- **Test**: Wald test, contrast `condition, treated, control` (positive log2FoldChange = higher in treated), confirmed by the top hit `IL15RA` (log2FoldChange = +6.401 unshrunken / +6.344 shrunken, `output/de_results_treated_vs_control_primary.csv`).
- **Shrinkage**: apeglm applied to the `condition_treated_vs_control` coefficient. The results table carries both unshrunken (`log2_fold_change`, `lfc_se`) and shrunken (`log2_fold_change_shrunken`, `lfc_se_shrunken`) values side by side (`output/de_results_treated_vs_control_primary.csv`).
- **Selection**: significance calls use `adjusted_pvalue < 0.05` (BH) only; raw p-values are retained in the table but never used for gene selection.

## Key Quantitative Results

- Top DE genes by adjusted p-value (`output/de_results_treated_vs_control_primary.csv`):
  - `IL15RA`: baseMean 671.24, log2FC (shrunken) +6.344, padj = 7.704e-46
  - `GENE00040`: baseMean 1049.07, log2FC (shrunken) +3.622, padj = 1.900e-31
  - `CDKN2B`: baseMean 683.91, log2FC (shrunken) +2.973, padj = 6.660e-24
  - `SLC25A5`: baseMean 42.16, log2FC (shrunken) −4.710, padj = 4.631e-21
- Same top gene in the sensitivity run: `IL15RA`, baseMean 546.15, log2FC (shrunken) +6.450, padj = 3.935e-49 (`output/de_results_treated_vs_control_sensitivity.csv`).

## Count Outliers vs. Independent Filtering (reported separately)

| | Primary (n=5 vs 6) | Sensitivity (n=6 vs 6) |
|---|---:|---:|
| Genes tested | 10,071 | 9,782 |
| Cook's-distance outlier NA (pvalue AND padj NA) | 2 | 0 |
| Independent-filtering NA (padj NA only) | 0 | 380 |

(`output/na_breakdown_primary.csv`, `output/na_breakdown_sensitivity.csv`). Cross-checked against DESeq2's own `summary()` text (`output/deseq2_results_summary_primary.txt`): "outliers [1]: 2, 0.02%" and "low counts [2]: 0, 0%" — matches the manual breakdown exactly. The two Cook's-outlier genes in the primary run, visible at the tail of `output/de_results_treated_vs_control_primary.csv`, are `GENE01507` (baseMean 13.56, pvalue/padj NA, shrunken log2FC 0.052) and `GENE07232` (baseMean 114.73, pvalue/padj NA, shrunken log2FC −0.116).

## Quality Notes

- n = 5 control vs 6 treated in the primary contrast (sample_01 excluded), n = 6 vs 6 in the sensitivity contrast, per `output/sample_sheet_deseq2.csv`.
- Both group sizes are below DESeq2's default outlier-replacement threshold, so count outliers are flagged (NA), not replaced — consistent with the intended policy.
- Sensitivity vs. primary agreement is high (Pearson r = 0.9889, `output/sensitivity_vs_primary_comparison.csv`), supporting that the exclusion decision affects precision at the margin, not the overall result.
- Outputs also include a packaged AnnData object (`output/deseq2_primary.h5ad`) and CSV exports of normalized counts (`output/normalized_counts_primary.csv`) and VST-transformed counts (`output/vst_counts_primary.csv`) for downstream reuse.

## Limitations

- The gene-length provenance check (rho = −0.0133, p = 0.1456) is suggestive, not conclusive — it rules out the clearest length-division signature but cannot fully exclude a subtler length-scaling.
- No batch/lane/run-date field exists in the inputs, so any residual unexplained variance cannot be attributed to batch vs. biology vs. depth.
- No subject/donor identifier distinct from `sample` exists — biological independence of replicates is assumed, not confirmed.
- The primary (826-gene) result is the decision-bearing list per the upstream QC recommendation; the sensitivity numbers (875 genes, 808/9782 compared genes significant in the restricted intersection) are a robustness check, not an alternative primary answer, and the two lists disagree on 28 + 95 = 123 genes at the padj < 0.05 boundary.