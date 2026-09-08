# Consolidated DE and Pathway Enrichment Report — Treated vs Control

## What this step did

Consolidated three upstream steps — T1S1 (sample-structure QC), T1S2 (DESeq2 differential expression), and T2S1 (fgsea Hallmark/Reactome enrichment) — into a single reproducible report. No DE or enrichment computation was re-run; every number below was pulled from those steps' persisted CSVs by dedicated scripts (`scripts/build_consolidated_gene_table.py`, `scripts/build_enrichment_tables.py`, `scripts/build_pvalue_histogram_interpretation.py`, `scripts/capture_session_info.R`, `scripts/build_final_report.py`) and re-verified against this step's own output files.

## Key Quantitative Results

**Differential expression** (`output/gene_table_summary_stats.csv`, `output/consolidated_gene_table_ranked_by_shrunken_lfc.csv`)
- 10,071 genes tested after filtering; **826 significant at BH padj < 0.05** (486 up in treated, 340 down); 2 genes NA for padj (Cook's-distance count outliers)
- Gene table (10,071 rows) carries `log2FoldChange` (unshrunken), `shrunken_log2FoldChange` (apeglm), `lfcSE`, `shrunken_lfcSE`, `wald_stat`, `pvalue`, `padj`, ranked by shrunken log2FoldChange descending
- Top-ranked gene: `IL15RA` (base_mean 671.24, log2FoldChange +6.401, shrunken +6.344, lfcSE 0.431, padj 7.70e-46)
- Bottom-ranked gene: `SLC25A5` (log2FoldChange −4.803, shrunken −4.710, lfcSE 0.472, padj 4.63e-21)

**P-value histogram** (`output/pvalue_histogram_bin_counts.csv`, `output/pvalue_histogram_interpretation_stats.csv`)
- n = 10,069 genes with a non-NA p-value; 20 equal-width bins over [0,1]
- First bin [0, 0.05): 1,557 genes — 3.58× the flat-tail mean
- Tail (p ≥ 0.4): mean 435.3 genes/bin, SD 11.7
- Last bin [0.95, 1.0]: 447 genes — close to the tail mean, not elevated
- **Interpretation**: enrichment near p=0 sitting on an approximately uniform tail, no anomalous peak near p=1 — the expected shape for a well-calibrated test with real signal, supporting the validity of the BH-adjusted padj values

**Enrichment universe and databases** (`output/enrichment_run_metadata.csv`)
- Rank metric: DESeq2 Wald statistic, primary contrast
- Universe: 10,071 ranked genes total; 3,669 with a resolvable HGNC symbol; 6,402 unmapped and retained in the ranked vector under their original name (unmapped share 0.6357)
- Size window: 15–500 genes
- Hallmark database: MSigDB Hallmark human release 2026.1 (50 sets shipped, 50 in size window)
- Reactome database: "current" rolling quarterly snapshot, no immutable version tag, restricted to *Homo sapiens* via `ReactomePathways.txt` (2,868 shipped, all 2,868 human, 804 in size window)
- Annotation release: `org.Hs.eg.db` 3.23.1 (alias resolution, unambiguous aliases only)

**Hallmark enrichment** (`output/hallmark_enrichment_table.csv`, `output/hallmark_collapsed_representative_sets.csv`)
- 15/50 sets significant at padj < 0.05, collapsed to **6 non-redundant representative sets**: `HALLMARK_TNFA_SIGNALING_VIA_NFKB` (NES +2.963, padj 7.78e-32), `HALLMARK_OXIDATIVE_PHOSPHORYLATION` (NES −3.074, padj 1.07e-29), `HALLMARK_INTERFERON_GAMMA_RESPONSE` (NES +2.814, padj 1.79e-25), `HALLMARK_INFLAMMATORY_RESPONSE` (NES +2.094, padj 6.60e-08), `HALLMARK_P53_PATHWAY` (NES +1.759, padj 3.80e-04), `HALLMARK_IL2_STAT5_SIGNALING` (NES +1.462, padj 3.24e-02)

**Reactome enrichment** (`output/reactome_enrichment_table.csv`, `output/reactome_collapsed_representative_sets.csv`)
- 92/804 sets significant at padj < 0.05, top hits: `Cytokine Signaling in Immune system` (NES +2.166, padj 2.63e-13), `Aerobic respiration and respiratory electron transport` (NES −2.600, padj 1.05e-12), `Signaling by Interleukins` (NES +2.194, padj 4.98e-11)
- Collapsed representative set example present in the supplement (`Activation of STAT3 by cadherin engagement`, padj 3.54e-03, is_representative = True)

**Hallmark vs Reactome comparison** (`output/hallmark_vs_reactome_overlap_summary.csv`)
- Leading-edge gene union: 447 (Hallmark), 471 (Reactome); 276 genes shared; Jaccard overlap = 0.4299

**Reproducibility record** (`output/session_info_R.txt`, `output/package_versions_R.csv`)
- R version 4.6.0 (aarch64-unknown-linux-gnu, Ubuntu 24.04.4 LTS)
- Package versions: DESeq2 1.52.0, apeglm 1.34.0, fgsea 1.38.0, org.Hs.eg.db 3.23.1, AnnotationDbi 1.74.0, data.table 1.18.4, ggplot2 4.0.3, ggrepel 0.9.8, pheatmap 1.0.13, ggridges 0.5.7, BiocParallel 1.46.0
- fgsea random seed = 42 (per `enrichment_run_metadata.csv`'s `fgsea_method` field); DESeq2/apeglm use deterministic optimization, no seed required

## Method Choices and Rationale

- **Ranking for display**: genes ordered by `shrunken_log2FoldChange` rather than the unshrunken MLE, per DESeq2's own guidance that apeglm shrinkage removes noise-inflated fold-change estimates for low-count/high-dispersion genes before ranking or plotting.
- **Fit diagnostics carried forward unchanged**: MA plot (`figures/ma_plot_primary_shrunken.png/.pdf`) and dispersion plot (`figures/dispersion_plot_primary.png/.pdf`) were copied from T1S2 rather than regenerated, since no DE computation was repeated at this step.
- **Hallmark and Reactome kept as separate tables** with a single shared metadata sidecar (`enrichment_run_metadata.csv`) rather than merging into one ranked list, preserving each collection's independent BH adjustment.
- **Unmapped genes retained in the enrichment ranking**: dropping the 6,402 unmapped genes would have altered fgsea's background rank-order null distribution even though they can never intersect a named gene set.
- **Redundancy collapsing** (`collapsePathways()`) used to report non-redundant representative pathways (6 Hallmark, and a reduced set for Reactome) alongside the full significant-set tables, so no membership information is discarded.

## Quality Notes

- Primary DE contrast is 5 control vs 6 treated (n=11 total) after excluding the QC-flagged shallow sample; this is a small, unpaired two-group design.
- The p-value histogram shape (peak near 0, flat tail, no anomaly near 1) is consistent with a correctly specified null and supports the padj-based significance calls used throughout.
- 36.4% of the ranked gene universe (3,669/10,071) carries a resolvable HGNC symbol; all pathway-level signal is necessarily derived from this mappable subset.

## Limitations

- No subject/donor identifier separate from `sample` exists in the metadata — biological independence of replicates cannot be confirmed from this analysis alone.
- No batch/lane/run-date field is present anywhere in the inputs — batch effects cannot be assessed or corrected for.
- 63.6% of tested genes (6,402/10,071, `enrichment_run_metadata.csv`) are synthetic placeholder identifiers with no resolvable HGNC symbol and are therefore invisible to Hallmark/Reactome enrichment by construction.
- The Reactome database version is recorded only as a "current" rolling quarterly snapshot with no immutable version tag embedded in the downloaded file.
- Preranked fgsea establishes statistical association between the ranking and curated gene sets; it is hypothesis-generating and does not establish mechanism or cell-type specificity.