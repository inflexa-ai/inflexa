Now I have everything grounded. Composing the final summary.

# T1S2 — DESeq2 Differential Expression: Treated vs Control

## Method

- **Template:** `tpl-deseq2-two-group@1.0.0` (method `M-0001`, snapshot `sha256:90c687582244894c67c212e63855415984027bcd54c896821c4e065cf8b5467a`, per `output/decision_record.json`), rendered and then extended with a dispersion plot, a raw p-value histogram, and an explicit NA-reason classification not present in the template's default outputs.
- **Design formula:** `~condition` (`output/deseq2_summary.json`, field `design_formula`).
- **Reference level:** `control`, set explicitly via `relevel()` before `DESeq()` (`output/deseq2_summary.json`, field `reference_level`).
- **Contrast:** named `condition: treated vs control`, extracted from coefficient `condition_treated_vs_control` (`output/deseq2_summary.json`, `contrast` object).
- **Pre-filter:** keep genes with ≥10 counts in ≥6 samples, where 6 = `min_samples` = the smaller of the two group sizes (`output/deseq2_summary.json`, fields `min_count`, `min_samples`).
- **Testing:** Wald test via `DESeq()`, `results()` with `alpha = 0.05`, `lfcThreshold = 0` (`output/deseq2_summary.json`, `alpha`, `lfc_threshold`).
- **Fold-change shrinkage:** apeglm on the `condition_treated_vs_control` coefficient (`output/deseq2_summary.json`, `lfc_shrink`).
- **Environment:** R 4.6.0, DESeq2 1.52.0, apeglm 1.34.0, ashr 2.2.63, ggplot2 4.0.3, pheatmap 1.0.13, jsonlite 2.0.0, all resolved as `"exact"` matches to environment pins (`output/decision_record.json`, `environment.pins`; confirmed in `output/session_info.txt`).

## Key quantitative results

**Cohort and filtering** (`output/deseq2_summary.json`):
- 12 samples total, 6 control / 6 treated (`n_samples`, `group_sizes`).
- 12,000 input genes → **9,782 genes kept** after the low-count pre-filter (`n_genes_input`, `n_genes_after_filter`).
- **9,402 genes retained a `padj` value** after independent filtering (`n_genes_tested`).
- **875 genes DE at padj < 0.05**: 513 up in treated, 362 down (`n_significant`, `n_up`, `n_down`).

**Size factors** (`output/deseq2_summary.json`, `size_factors`): range from 0.2835 (sample_01) to 1.8498 (sample_04); sample_01 (the shallow control sample flagged at T1S1) has the smallest size factor in the cohort, 0.2835.

**Top DE genes by raw p-value** (`output/deseq2_results.csv`, header row + top rows):
Columns: `gene, base_mean, log2_fold_change (apeglm-shrunken), log2_fold_change_unshrunken, lfc_se, stat, pvalue, adjusted_pvalue, na_reason`.

| gene | base_mean | log2FC (shrunken) | log2FC (unshrunken) | lfcSE | pvalue | padj |
|---|---:|---:|---:|---:|---:|---:|
| IL15RA | 546.15 | 6.450 | 6.504 | 0.4225 | 4.19e-53 | 3.93e-49 |
| GENE00040 | 864.24 | 3.630 | 3.669 | 0.2787 | 4.85e-40 | 2.28e-36 |
| CDKN2B | 569.98 | 2.913 | 2.961 | 0.2651 | 1.77e-29 | 5.55e-26 |
| GENE05300 | 2111.91 | 3.186 | 3.235 | 0.2928 | 9.02e-29 | 2.12e-25 |
| GENE05017 | 111.46 | -3.040 | -3.095 | 0.2933 | 1.92e-26 | 3.62e-23 |

**NA policy** (`output/deseq2_summary.json`, `na_policy`):
- Smallest condition-group size = 6, below DESeq2's default `min_replicates_for_replace = 7` → automatic Cook's-distance outlier count *replacement* inside `DESeq()` was off (`automatic_cooks_outlier_replacement_in_DESeq: false`).
- **0 genes** were NA due to count outliers (Cook's distance above the theoretical 0.99-quantile cutoff of F(2,10) ≈ 7.559) (`n_count_outlier_na`, `cooks_distance_cutoff_theoretical_qf99`).
- **380 genes** were NA due to independent filtering only (baseMean below the optimized threshold of 11.346) (`n_independent_filtering_na`, `independent_filtering_threshold_baseMean`).

**P-value histogram** (`output/deseq2_summary.json` `pvalue_histogram`; full bin table in `output/deseq2_pvalue_histogram_bins.csv`):
- 9,782 genes with a non-NA raw p-value tested; 15.67% had p < 0.05 (`n_tested`, `fraction_below_0.05`).
- Bin [0, 0.05]: 1,533 genes vs. a uniform-null expectation of 489.1 genes/bin (~3.1×) (`low_bin_0_to_0.05_count`, `uniform_expected_count_per_bin`).
- Bin [0.95, 1.0]: 456 genes — near the 489.1 uniform expectation, no elevation (`high_bin_0.95_to_1_count`).
- All 18 intermediate 0.05-wide bins in `output/deseq2_pvalue_histogram_bins.csv` range from 387 to 470 genes, consistently near/below the 489.1 uniform expectation, e.g. [0.05,0.1]=470, [0.65,0.7]=387, [0.9,0.95]=396.
- Shape classified as **anti-conservative**: a spike near 0 sitting on an otherwise flat, approximately uniform distribution with no hump near 1 — the well-behaved pattern that supports trusting the BH adjustment (`shape` field).

**Run log confirmation** (`logs/deseq2_run.log`): script exit code 0, ~12.6 s runtime, console messages matching the JSON values above line-for-line (filter kept 9,782/12,000 genes; 9,402 tested with 875 significant, 513 up/362 down; NA policy and p-value histogram messages identical to the JSON fields).

## Diagnostics produced

- MA plot: `figures/deseq2_ma.png` / `.pdf`
- Dispersion plot (`plotDispEsts`): `figures/deseq2_dispersion.png` / `.pdf`
- P-value histogram: `figures/deseq2_pvalue_histogram.png` / `.pdf`
- PCA (design-informed VST, this step): `figures/deseq2_pca.png` / `.pdf`
- Euclidean sample-distance heatmap: `figures/deseq2_sample_distances.png` / `.pdf`
- Volcano plot: `figures/deseq2_volcano.png` / `.pdf`

## Quality notes and assumptions

- Sample size is fixed at n=6/arm; the pre-filter threshold (≥6 samples) and `min_replicates_for_replace` behavior were derived directly from this group size rather than hardcoded.
- The shallow control sample flagged during upstream QC (sample_01) was kept in the model per that step's recommendation; its DESeq2 size factor here (0.2835) is the smallest in the cohort, consistent with the QC step's expectation that DESeq2's own normalization would down-weight it.
- No batch, pairing, or covariate structure exists in the metadata, so `~condition` is the only supportable design; no adjustment for unmodeled structure was possible.
- apeglm was successfully used for shrinkage (v1.34.0 loaded); ashr (v2.2.63) was also available but not invoked — no fallback occurred.
- Independent filtering (`independentFiltering = TRUE` default) and Cook's-distance NA policy were left at DESeq2 defaults, not manually tuned.

## Limitations

- Of the 12,000 gene identifiers in the input, a large fraction are non-standard placeholder IDs of the form `GENE#####` rather than HGNC symbols — several placeholder-ID genes (e.g. `GENE00040`, `GENE05300`) rank among the top DE hits by p-value, alongside real symbols (`IL15RA`, `CDKN2B`). This raises doubt about the biological authenticity of the dataset; the DE statistics are computed correctly and reproducibly from the data as given, but no biological interpretation of individual genes or pathways should be drawn from this step.
- This step performs differential expression testing only — no GO/pathway enrichment or functional annotation of the 875 DE genes was performed.
- A PubMed search for the top hit `IL15RA` in a treatment-response context returned no matching literature; this is reported as a plain statistical result, not a biologically validated finding.
- No leave-one-sample-out sensitivity re-run (excluding the shallow sample_01) was performed at this step; it was noted as optional, not required, by the upstream QC step.