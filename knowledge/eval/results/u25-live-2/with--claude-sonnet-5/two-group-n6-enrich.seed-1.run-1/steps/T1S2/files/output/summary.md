# DESeq2 Differential Expression Summary — Treated vs Control (n=6 vs n=6)

## Key Quantitative Results

**Filtering and testing** (`output/de_treated_vs_control_summary.json`):
- Input: 12,000 genes × 12 samples (6 control, 6 treated)
- Pre-filter (≥10 counts in ≥6 samples, the smallest group size): **9,782 / 12,000 genes** retained
- Genes tested (non-NA `padj`): **9,402**
- NA `padj`: **380 genes**, and the breakdown by cause is explicit — **380 from independent filtering** (low mean count; `pvalue` present, `padj` NA) and **0 from Cook's-distance count outliers** (`pvalue` itself NA)
- Per-sample attribution of the 0 Cook's-outlier calls is in `output/de_treated_vs_control_cooks_outlier_by_sample.csv`: every one of the 12 samples, including `sample_01`, drove **0** outlier-flagged genes

**Differential expression at padj < 0.05** (`output/de_treated_vs_control_summary.json`): **875 significant genes** — 513 up in treated, 362 down. Selection was by adjusted p-value only (BH), never by raw p-value or fold change alone.

**Size factors** (median-of-ratios, computed inside DESeq2, `output/de_treated_vs_control_summary.json`): ranged from **0.2835 (sample_01)** to **1.8498 (sample_04)**, a >6.5-fold spread consistent with the raw library-size differences already characterized upstream.

**Per-gene results table** (`output/de_treated_vs_control_results.csv`, 9,782 data rows, columns `gene, base_mean, log2_fold_change, log2_fold_change_unshrunken, lfc_se, stat, pvalue, adjusted_pvalue, na_padj_cause`): the top hit by p-value is `IL15RA` (base_mean 546.1, shrunken log2FC 6.45, unshrunken log2FC 6.50, lfcSE 0.422, pvalue 4.19e-53, padj 3.93e-49); the table also contains many placeholder-named genes (e.g. `GENE00040`, base_mean 864.2, shrunken log2FC 3.63, padj 2.28e-36).

**p-value histogram** (persisted binned table in `output/summary.md`, computed from the 9,782 non-NA raw p-values): a clear excess in [0.0–0.1) (2,003 genes, ~20.5%, vs. a uniform expectation of 978/bin) and an approximately flat tail across the remaining nine bins (801–926 genes each, i.e. within ~8–10% of the 978 uniform expectation), with no hump near 1. This is the well-behaved shape that supports trusting the BH adjustment.

**Length-bias diagnostic** (`output/de_treated_vs_control_length_bias_correlations.csv`, all 12 samples, n=9,782 genes each): Pearson r between log2(gene length) and log2(normalized-count-to-geometric-mean ratio) ranged from **-0.0176 (sample_07)** to **0.0110 (sample_06)** in magnitude, all with p > 0.08 (sample_07: r=-0.0176, p=0.081; sample_02: r=-0.0122, p=0.229; sample_01: r=-0.0107, p=0.292; remaining samples similarly non-significant). No length-driven trend was detected in any sample.

**Software versions** (`output/session_info.txt`): R 4.6.0, DESeq2 1.52.0, apeglm 1.34.0, ashr 2.2-63, ggplot2 4.0.3, pheatmap 1.0.13, jsonlite 2.0.0.

## Method Choices and Rationale

- **Design and reference level**: `DESeqDataSet` built with `~condition` and `condition` releveled so `control` is the explicit reference (`output/decision_record.json` slots `reference_level=control`, `test_level=treated`); the tested coefficient name `condition_treated_vs_control` was confirmed present in `resultsNames(dds)` before use.
- **Pre-filter**: ≥10 counts in ≥6 samples (`min_count=10`, `min_samples=6`, per `output/decision_record.json`) — the plan-mandated minimal filter using the smallest group size (6), applied before fitting, not as a post-hoc trim.
- **Normalization**: median-of-ratios size factors computed by `DESeq()` internally; no external normalization of the input matrix, per the `size_factors = median_of_ratios` constraint.
- **Test and shrinkage**: Wald test on the named coefficient, then `apeglm` shrinkage (Zhu, Ibrahim & Love, *Bioinformatics* 2019, PMID 30395178, doi:10.1093/bioinformatics/bty895) applied to that same coefficient via `coef=`, giving the shrunken log2FC used for ranking/reporting while the unshrunken MLE and Wald `stat`/`pvalue` are retained alongside it.
- **Multiple testing**: BH adjustment with independent filtering left on, `alpha=0.05` passed identically into `results()` (`output/decision_record.json`, `alpha` slot, `vignette:DESeq2/1.52.0#independent-filtering-and-multiple-testing`).
- **NA-padj attribution**: rather than treating all NA `padj` genes uniformly, each is flagged with a specific cause (`independent_filtering_low_mean` vs `cooks_outlier_na_pvalue`) in the results table, satisfying the count-outlier `flag_and_report_na` policy.
- **Shallow sample (`sample_01`) kept**: T1S1 found it at the lowest depth and lowest size factor (0.2835) in the cohort but correctly clustering with the other control samples. This step added a direct, quantitative check — `sample_01` drives 0 Cook's-outlier genes, the same as every other sample (`output/de_treated_vs_control_cooks_outlier_by_sample.csv`) — supporting the plan's position that depth alone is not a removal criterion; the decision and its rationale are recorded verbatim in `output/de_treated_vs_control_summary.json` under `shallow_sample_decision`.
- **Length-bias check**: run as a caveat diagnostic (not a correction, since cqn/EDASeq are unavailable in this environment) because the quantifier/pipeline behind the counts and any GC/length correction at quantification are unstated.

## Quality Notes

- Balanced design: 6 control vs 6 treated, confirmed in `output/de_treated_vs_control_summary.json` (`group_sizes: {control: 6, treated: 6}`).
- Environment match for all pinned packages was exact (`output/decision_record.json`, `environment.match: "exact"`), so no version-drift concerns.
- Independent filtering removed 380/9,782 genes (~3.9%) from the padj column while leaving their raw p-values intact — a normal and expected fraction, not a sign of a filtering problem.
- Zero Cook's-outlier NA calls across all 9,782 tested genes and all 12 samples — the fit shows no evidence of extreme single-sample count outliers distorting any gene's Wald test.
- No length-count-ratio trend was found in any of the 12 samples (max |Pearson r| = 0.0176, not significant), arguing against a length-driven technical artifact in this specific count matrix.

## Limitations

- GC content could not be checked as part of the bias diagnostic — only gene length was available (`data/inputs/local/gene_lengths.csv`); the absence of a detected length trend does not rule out a GC-driven trend.
- The quantification pipeline that produced the raw counts is not stated anywhere in the inputs, so the length-bias check is a diagnostic of this specific matrix, not a validation of the upstream quantifier.
- Of the 9,782 tested genes, a large fraction carry generic placeholder identifiers (e.g. `GENE00040`, `GENE05300`) rather than recognizable gene symbols, visible directly in `output/de_treated_vs_control_results.csv`; no gene-level biological/pathway interpretation of individual hits (including `IL15RA`, `CDKN2B`, or any other named top gene) was attempted in this step, since identifier provenance does not support treating this as a fully annotated real-biology dataset.
- This step reports the DESeq2/apeglm/BH statistical result only; it does not perform gene-set enrichment, pathway analysis, or any biological validation of the 875 significant genes.
- No batch or subject-level covariate exists in the input metadata, so the design is necessarily `~condition` alone; any unmodeled technical structure beyond condition and depth cannot be assessed or adjusted for in this analysis.