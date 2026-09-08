# DESeq2 Differential Expression — Treated vs Control

## Key quantitative results

**Headline (source: `output/de_treated_vs_control_summary.json`):**
- Input: 12,000 genes × 12 samples (6 control, 6 treated).
- Post minimal pre-filter (≥10 counts in ≥6 samples): **9,782 genes** kept (`n_genes_after_filter`).
- Post DESeq2 automatic independent filtering: **9,402 genes tested** (`n_genes_tested`); **380 genes** dropped by independent filtering alone (`n_independent_filter_na`), at a mean-normalized-count threshold of **11.35** (`independent_filter_threshold_mean_count`).
- **0 genes** flagged as Cook's-distance count outliers (`n_cooks_outlier_na`) — no extreme, isolated count values drove `pvalue`/`padj` to NA.
- **875 genes significant at padj < 0.05** (`n_significant`): **513 up** in treated, **362 down** (`n_up`, `n_down`).
- Size factors (median-of-ratios, `size_factors` block) ranged from **0.2835** (sample_01) to **1.8498** (sample_04) — consistent with the ~6.5× library-size spread carried over from T1S1.

**p-value histogram (source: `output/pvalue_histogram_bins.csv`, `output/de_qc_report.json`):**
- 9,782 non-NA p-values tabulated in 20 bins of width 0.05.
- Lowest bin [0.00, 0.05): **1,533 genes** — far above the ~5% expected under a null with no signal.
- Remaining 19 bins are approximately flat, ranging **387–470 genes/bin** (e.g. [0.5,0.55)=468, [0.65,0.7)=387, [0.95,1.0)=456), with no secondary peak near 1.
- Kolmogorov–Smirnov test of the p > 0.5 tail against Uniform(0.5,1): **D = 0.0162, p = 0.204** (`ks_stat_tail_uniform_p_gt_0.5`, `ks_p_tail_uniform_p_gt_0.5`) — does not reject uniformity, supporting a well-calibrated test.

**Full results table (source: `output/de_treated_vs_control_results.csv`, ranked by shrunken log2FoldChange descending):**
- Columns: `gene, base_mean, log2_fold_change` (apeglm-shrunken), `log2_fold_change_unshrunken, lfc_se, stat, pvalue, adjusted_pvalue, na_reason`.
- Top upregulated: `IL15RA` (log2FC = 6.450, padj = 3.94e-49), `GENE06568` (3.735, padj = 6.89e-06), `GENE07358` (3.648, padj = 1.01e-16), `GENE00040` (3.630, padj = 2.28e-36), `NFE2L2` (3.231, padj = 9.996e-14), `PTGS2` (2.955, padj = 3.32e-13), `CDKN2B` (2.913, padj = 5.55e-26).
- Top downregulated: `UQCRC2` (log2FC = −4.425, padj = 2.29e-18), `GENE05017` (−3.040, padj = 3.62e-23), `PRDX1` (−2.908, padj = 3.90e-15), `GENE00133` (−2.892, padj = 7.55e-09), `GENE05373` (−2.809, padj = 7.02e-08).
- All rows shown carry `na_reason = NA` (i.e., not flagged by either NA mechanism).

**Gene-identifier composition (source: `output/gene_id_composition.csv`, `output/de_qc_report.json`):**

| gene_set | n_total | n_named_symbol | n_placeholder_id | pct_placeholder |
|---|---|---|---|---|
| all_prefiltered | 9,782 | 3,541 | 6,241 | 63.8% |
| tested_after_independent_filtering | 9,402 | 3,403 | 5,999 | 63.8% |
| significant_padj_lt_0.05 | 875 | 408 | 467 | 53.4% |

- Fisher's exact test for placeholder-vs-named enrichment among significant genes (`output/de_qc_report.json`, `gene_id_enrichment_test`): **odds ratio = 0.6197, p = 3.25e-11** — named-symbol genes are significantly over-represented among the 875 hits relative to the 9,402-gene tested background.

**Gene-length bias diagnostic (source: `output/gene_length_bias_qc.csv`, `output/de_qc_report.json`):**
- 9,782 of 9,782 tested/filtered genes matched a length record (0 unmatched).
- Spearman correlation, length vs. |shrunken log2FC|: **rho = 4.41e-05, p = 0.9965**.
- Spearman correlation, length vs. −log10(padj): **rho = −0.00123, p = 0.9048**.
- Median gene length: **2,028 bp** (significant genes) vs. **1,986 bp** (non-significant genes); Mann-Whitney **p = 0.9808**.
- No detectable length bias in significance or effect size.

**Environment (source: `output/session_info.txt`, `output/de_treated_vs_control_summary.json`):** R 4.6.0 (aarch64-unknown-linux-gnu), DESeq2 1.52.0, apeglm 1.34.0, ashr 2.2.63 (available but not used).

## Method choices and rationale

- **Import state**: `integer_counts` — the count matrix was used as supplied, with no upstream pipeline confirmed (`import.mode = "gene_counts_without_length_offset"`, `output/de_treated_vs_control_summary.json`). No length offset applied, consistent with a raw gene-count matrix rather than transcript-quantification output.
- **Design & reference level**: `design = ~condition` (`output/de_treated_vs_control_summary.json`), with `condition` explicitly releveled so `control` is the reference — not left to alphabetical default, per the plan's explicit-reference-level requirement.
- **Pre-filter then independent filtering**: a minimal filter (≥10 counts in ≥6 samples, the smaller group size) was applied before the model, and DESeq2's built-in independent filtering (left on) then removed a further 380 low-mean genes at the `results()` step — a two-stage "minimal-then-independent-filtering" policy rather than a single aggressive filter.
- **Normalization**: DESeq2 median-of-ratios size factors computed internally by `DESeq()`; the raw counts were not pre-scaled or normalized before fitting.
- **Test and shrinkage**: Wald test on the `condition_treated_vs_control` coefficient, with `alpha = 0.05` passed into `results()` so independent filtering targets the same threshold used for reporting; apeglm shrinkage applied via `coef=` (not `contrast=`), the correct mode for a single two-group coefficient.
- **Count-outlier policy**: Cook's-distance outlier flagging left at DESeq2 defaults (`cooksCutoff = TRUE`); outlier NAs and independent-filtering NAs are recorded separately (`na_reason` column, `n_cooks_outlier_na` vs. `n_independent_filter_na` in the summary JSON) rather than merged.
- **Ranking**: the results CSV is sorted by shrunken `log2_fold_change` (descending) for reporting, distinct from a significance-based ranking.
- **Shallow sample (`sample_01`)**: kept, per the upstream T1S1 QC decision recorded in `output/de_treated_vs_control_summary.json` (`shallow_sample_disposition`) — it fell just short of the automated 4× low-depth cutoff, grouped correctly with its condition group on PC1, and its low depth is accounted for by its size factor (0.2835, the lowest of the 12) rather than by exclusion.

## Quality notes

- Balanced, unpaired two-group design: 6 control vs. 6 treated (`output/de_treated_vs_control_summary.json`, `group_sizes`).
- p-value histogram inspected before trusting BH-adjusted values: peak-near-zero-plus-uniform-tail shape, KS test on the p>0.5 tail not rejecting uniformity (p = 0.204) — supports trusting `padj`.
- Count-outlier and independent-filtering NAs were distinguished and reported separately, per the analysis plan's count-outlier policy.
- Size factors span roughly 6.5-fold (0.2835–1.8498), reflecting a real library-size disparity across samples that median-of-ratios normalization is designed to absorb.

## Limitations

- Count source/quantifier is undocumented — the analysis proceeded on the data profile's confirmation that values are non-negative integers, not on a confirmed upstream tool identity.
- Organism is unknown; gene symbols were used at face value with no annotation or identifier-validity check beyond flagging placeholder IDs.
- 63.8% of tested gene IDs are synthetic placeholders (`GENE#####`); named-symbol genes are significantly enriched among the 875 significant hits (Fisher's OR = 0.6197, p = 3.25e-11) relative to the tested background, a structural observation about the dataset rather than a biological claim.
- `sample_01`'s "keep" disposition (from the prior QC step) was applied as given; no with/without sensitivity re-run was performed in this step.
- Gene length shows no detectable relationship with effect size or significance (Spearman rho ≈ 0 for both comparisons, Mann-Whitney p = 0.9808), so length is not a confound here, but this diagnostic was run only because a length reference table happened to be available, not as a required part of the DESeq2 count model.