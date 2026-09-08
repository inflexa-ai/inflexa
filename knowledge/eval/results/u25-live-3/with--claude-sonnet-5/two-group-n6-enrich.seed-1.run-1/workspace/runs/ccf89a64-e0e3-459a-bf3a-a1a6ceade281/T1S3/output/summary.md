# Combined DE + Pathway Enrichment Report — Execution Summary

## What this step did

This step performed **no new statistical analysis**. It read the persisted outputs of four already-completed upstream steps — T1S1 (sample QC), T1S2 (DESeq2 differential expression), T1S6 (gene-ID annotation), and T2S1 (fgsea pathway enrichment) — and synthesized them into one decision-ready report, script, and set of consolidated tables. All numbers below are read from the persisted artifacts produced in `output/` (built by `scripts/build_combined_report.py`, which joins the upstream JSON/CSV files).

## Key quantitative results

**Differential expression** (from `output/reproducibility_record.json` / `output/combined_report.md`, sourced from T1S2):
- Method: DESeq2 Wald test with apeglm shrinkage; design `~condition`; contrast treated vs control, reference level = control.
- 12,000 input genes → 9,782 after minimal pre-filter (≥10 counts in ≥6 samples) → **9,402 genes tested** after DESeq2's automatic independent filtering (380 genes dropped, mean-count threshold 11.35).
- **875 genes significant at padj < 0.05**: 513 up in treated, 362 down.
- 0 genes flagged as Cook's-distance count outliers.
- `output/gene_table_full.csv` contains all 9,782 genes (confirmed by direct read: header includes `rank_by_shrunken_log2fc, gene, base_mean, log2_fold_change_shrunken_apeglm, log2_fold_change_unshrunken_mle, lfcSE_shrunken, stat, pvalue, adjusted_pvalue, na_reason, mapped, entrez_id, ensembl_id, is_synthetic_placeholder_id, significant_padj_lt_0.05`), ranked descending by shrunken log2FC; top row is `IL15RA` (log2FC shrunken = 6.450, unshrunken = 6.504, lfcSE = 0.422, padj = 3.93e-49). `output/gene_table_significant.csv` holds the 875-row padj<0.05 subset.
- p-value histogram (`output/reproducibility_record.json` → `pvalue_histogram_ks_test_tail_uniform`): 9,782 p-values, lowest bin [0,0.05) = 1,533 genes, remaining 19 bins flat (387–470 genes/bin), KS test of the p>0.5 tail vs Uniform(0.5,1): D = 0.0162, p = 0.204 (does not reject uniformity).

**Annotation mapping** (from `output/reproducibility_record.json`, sourced from T1S6):
- org.Hs.eg.db 3.23.1 (Entrez source 2026-Mar18, Ensembl source 2025-Sep03), organism assumption = "human" (unverified).
- 4,384 of 12,000 gene IDs mapped (36.53%); 7,616 unmapped (63.47%).

**Enrichment** (from `output/reproducibility_record.json` and `output/enrichment_significant_sets.csv`, sourced from T2S1):
- Ranking metric: signed DESeq2 Wald `stat`; universe = 9,402 tested genes; size window 15–500; seed 20260904.
- Hallmark 2026.1: 50/50 sets in window, 15 significant (13 up / 2 down), 8 main pathways after collapse.
- Reactome (current release): 766/2,868 sets in window, 97 significant (90 up / 7 down), 22 main pathways.
- WikiPathways 2026.07.10: 390/987 sets in window, 99 significant (92 up / 7 down), 34 main pathways.
- `output/enrichment_significant_sets.csv` contains **211 rows** (15+97+99), each with `collection, pathway, pvalue, padj, ES, NES, size, leading_edge, leading_edge_symbol, nominal_size, tested_overlap_size, coverage_fraction` — confirmed by direct read; top row is Hallmark `HALLMARK_TNFA_SIGNALING_VIA_NFKB` (padj = 2.56e-32, NES = 2.99, size 165/nominal 200, coverage_fraction 0.825).
- `output/report_derived_stats.json` (read directly): `n_genes_full_table=9782, n_genes_significant=875, n_significant_up=513, n_significant_down=362, n_significant_mapped=408, n_significant_placeholder=467, n_enrichment_significant_sets_all_collections=211` — all cross-checked against and matching the upstream step summaries.

## Method choices and rationale

- **No re-computation**: chose to build this as a pure aggregation/join step over persisted upstream artifacts (`scripts/build_combined_report.py`) rather than re-running DESeq2 or fgsea, since those steps were already completed, versioned, and had their own decision records — re-running would risk divergent numbers and violate "build on, don't redo" guidance.
- **Ranking column**: gene table sorted by `log2_fold_change_shrunken_apeglm` per the plan's explicit `rank_genes_by = shrunken_log2FoldChange` requirement, while retaining the unshrunken MLE value and lfcSE as separate columns for transparency.
- **Full-table vs tested-set distinction preserved**: `gene_table_full.csv` intentionally includes all 9,782 pre-filter survivors (including the 380 with `padj = NA` from independent filtering) rather than only the 9,402 "tested" genes, so the ranking is not silently truncated; the 9,402 figure is reported separately as the official DESeq2-tested count.
- **Leading edge at the per-set level**: built `enrichment_significant_sets.csv` from each collection's full `*_results.csv` (which carries leading-edge genes for every tested pathway) rather than only the collapsed "main pathway" tables, satisfying a `leading_edge = per_significant_set` requirement at the individual-set level (211 sets) rather than only the 64 collapsed representatives.
- **Figures copied, not regenerated**: 23 PNG/PDF figures were copied verbatim from T1S1/T1S2/T1S6/T2S1 into this step's `figures/` directory to make the report self-contained without re-plotting (avoiding any risk of a re-derived figure disagreeing with its own step's numbers).

## Quality notes

- Sample size: 12 samples (6 control, 6 treated), balanced, unpaired design — confirmed in `output/reproducibility_record.json`.
- Shallow sample `sample_01` was kept (not excluded) per the upstream T1S1 QC verdict; this report restates but does not re-verify that decision, and no with/without sensitivity re-run exists in any persisted artifact.
- Gene-ID composition of the 875 significant genes: 408 mapped to real identifiers, 467 synthetic placeholders (`output/report_derived_stats.json`), consistent with the T1S2 Fisher's-exact enrichment of named genes among hits.
- Package/environment consistency: R 4.6.0 (aarch64-unknown-linux-gnu, Ubuntu 24.04.4 LTS) identical across all four upstream steps, confirmed in `output/reproducibility_record.json`.

## Limitations

- Organism was never stated in any raw input; human references (`org.Hs.eg.db`, human-only Hallmark/Reactome/WikiPathways) were used provisionally throughout, per `output/reproducibility_record.json` and `output/combined_report.md`.
- 63.8% of tested gene IDs are synthetic placeholders with no real annotation, structurally capping enrichment coverage — only 36.19% of the 9,402 tested genes could enter any gene-set analysis (`gene_universe_join_qc` in `output/reproducibility_record.json`).
- Reactome's "current" release has no fixed version string upstream; the exact gene-set content used is only durably recorded in the frozen GMT file referenced from T2S1, not reproduced in this step's own outputs.
- Only one ranking metric (Wald `stat`) was used for GSEA; no alternate-metric rerun exists in any persisted artifact.
- No new statistical validation was performed at this step — all limitations documented in the upstream T1S1/T1S2/T1S6/T2S1 artifacts (count-source/quantifier undocumented, no length offset applied, one-to-many gene-ID collapsing to "first" target) are carried forward unchanged and are not independently re-checked here.