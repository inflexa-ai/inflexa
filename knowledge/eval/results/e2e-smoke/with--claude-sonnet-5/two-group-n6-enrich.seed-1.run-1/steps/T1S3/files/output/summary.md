# T1S3 — Integrated DE + Pathway Report: Summary

## What this step did

Consolidated T1S1 (QC / shallow-sample assessment), T1S2 (DESeq2 differential expression), and T2S1 (Hallmark + Reactome preranked GSEA) into one reproducible report. No upstream analysis was rerun. Four scripts were written and executed to re-rank, re-tabulate, cross-reference, and — in one case — compute a new statistic (Hallmark/Reactome leading-edge overlap) on top of the existing outputs.

## Key quantitative results

### Differential expression gene table (`output/de_gene_table_summary.json`, `output/de_gene_table_full.csv`, `output/de_gene_table_significant.csv`)

- **9,782 genes** in the filtered matrix carried forward from T1S2; **9,402** retained a non-NA `padj`.
- **875 DE genes at padj < 0.05**: **513 up**, **362 down**.
- Full table (`de_gene_table_full.csv`, 9,782 rows) and significant subset (`de_gene_table_significant.csv`, 875 rows) both ranked descending by shrunken (apeglm) `log2_fold_change_shrunken_apeglm`, with `log2_fold_change_unshrunken`, `lfc_se_shrunken`, `stat`, `pvalue`, and `padj_BH` retained alongside.
- Top 5 up by shrunken log2FC (from `de_gene_table_summary.json`): **IL15RA, GENE06568, GENE07358, GENE00040, GENE07059**.
- Top 5 down by shrunken log2FC: **UQCRC2, GENE05017, PRDX1, GENE00133, GENE05373**.
- Read directly from `de_gene_table_full.csv`: `IL15RA` — shrunken log2FC 6.450, unshrunken 6.504, lfcSE 0.4225, padj 3.93e-49 (rank 1). `GENE06568` — shrunken log2FC 3.735, unshrunken 4.042, lfcSE 0.8007, padj 6.89e-06 (rank 2).
- Read from the tail of `de_gene_table_significant.csv`: `UQCRC2` — shrunken log2FC −4.425, unshrunken −4.528, lfcSE 0.4836, padj 2.29e-18 (most negative shrunken LFC among the 875 significant genes).

### Pathway tables (`output/pathway_table_summary.json`, `pathway_table_hallmark.csv`, `pathway_table_reactome.csv`, `pathway_table_combined_significant.csv`)

- **Hallmark**: database "MSigDB Hallmark human, 2026.1"; ranking metric `stat`; gene universe 9,782; size window 15–500; 50 sets input, **50 tested**, **17 significant** at padj<0.05 (15 up, 2 down), collapsed to **11 representative** pathways.
- **Reactome**: database "Reactome pathways, release 'current' (host-provisioned snapshot)"; ranking metric `stat`; gene universe 9,782; size window 15–500; 2,868 sets input, **787 tested**, **106 significant** at padj<0.05 (99 up, 7 down), collapsed to **25 representative** pathways.
- `pathway_table_combined_significant.csv` stacks the padj<0.05 rows from both collections (17 + 106 = 123 rows before any collapsing).
- Top Hallmark hits by padj (`pathway_table_hallmark.csv`): `HALLMARK_TNFA_SIGNALING_VIA_NFKB` (NES 2.963, padj 3.32e-32), `HALLMARK_OXIDATIVE_PHOSPHORYLATION` (NES −3.079, padj 9.06e-29), `HALLMARK_INTERFERON_GAMMA_RESPONSE` (NES 2.787, padj 2.31e-25).
- Top Reactome hits by padj (`pathway_table_reactome.csv`): "Cytokine Signaling in Immune system" (NES 2.216, padj 3.99e-15), "Aerobic respiration and respiratory electron transport" (NES −2.588, padj 2.01e-12), "Signaling by Interleukins" (NES 2.253, padj 1.91e-11).

### Hallmark vs Reactome overlap (`output/hallmark_reactome_overlap_summary.json`, `output/hallmark_reactome_overlap_pairs.csv`)

- Compared **11 representative Hallmark sets × 25 representative Reactome sets = 275 pathway pairs**.
- **147 of 275 pairs (53%)** share at least one leading-edge gene.
- Of those 147 overlapping pairs, **100% (`fraction_overlapping_pairs_with_concordant_nes_sign`: 1.0)** have concordant NES sign.
- Strongest pair by Jaccard index: `HALLMARK_OXIDATIVE_PHOSPHORYLATION` ↔ Reactome "Aerobic respiration and respiratory electron transport" — Jaccard **0.5632**, **49 shared leading-edge genes**, both down (NES −3.079 / −2.588).
- Second strongest: `HALLMARK_INTERFERON_GAMMA_RESPONSE` ↔ "Cytokine Signaling in Immune system" — Jaccard **0.3054**, **51 shared genes**, both up (NES 2.787 / 2.216).
- Union-level: Hallmark representative leading-edge genes total **437**, Reactome total **433**, shared across collections **251** genes, union-level Jaccard **0.4055**.
- `n_strong_pairs_ge_threshold` (Jaccard ≥ 0.15): **11 pairs**.
- Figure: `figures/hallmark_reactome_overlap_heatmap.png` / `.pdf` — Jaccard heatmap, Hallmark (rows) × Reactome (columns), NES-sorted.

### Reproducibility record (`output/reproducibility_record.md`, `.json`)

- R **4.6.0** (aarch64-unknown-linux-gnu, Ubuntu 24.04.4 LTS) across all three upstream steps.
- T1S1 (QC): DESeq2 1.52.0, ggplot2 4.0.3, pheatmap 1.0.13, jsonlite 2.0.0 — environment match `exact`.
- T1S2 (DESeq2 DE): DESeq2 1.52.0, apeglm 1.34.0, ashr 2.2-63, ggplot2 4.0.3, pheatmap 1.0.13, jsonlite 2.0.0 — `exact`. Design formula `~condition`, reference level `control`, contrast `condition_treated_vs_control`, alpha 0.05.
- T2S1 (fgsea, both collections): fgsea 1.38.0, ggplot2 4.0.3, jsonlite 2.0.0 — `exact`. Random seed **42**.
- Gene-ID mapping QC: `org.Hs.eg.db` version **3.23.1**.

## Method choices and rationale

- Gene table ranked by **shrunken** (apeglm) log2FoldChange rather than raw effect size or p-value, per the report's requirement to present the shrinkage-adjusted estimate as the primary sort key while keeping the unshrunken value, lfcSE, and padj visible for comparison.
- Pathway tables carry per-row metadata (database version, ranking metric, gene universe size, min/max set size, sets input/tested) rather than relying on a separate methods paragraph, so each row is self-describing.
- The Hallmark/Reactome overlap analysis uses **Jaccard index on leading-edge gene sets** (not full gene-set membership) because leading-edge genes are the ones actually driving each pathway's enrichment signal — a more relevant concordance measure than raw set-membership overlap.
- Overlap was restricted to **representative (collapsed)** significant pathways in both collections to avoid inflating pair counts with near-duplicate, redundant set variants.

## Quality notes

- Design is a simple two-group comparison (`~condition`), n=6 control / 6 treated, no batch/pairing/timepoint covariates available in the metadata — carried forward unchanged from T1S1/T1S2.
- The shallow control sample (`sample_01`, flagged at T1S1 for library size 0.26× the cohort median) was kept in the DESeq2 model per T1S1's QC recommendation; this report step did not rerun or re-verify that decision, only restated and cited it.
- Both GSEA runs used the same ranked gene list (9,782 genes, DESeq2 Wald `stat`) and the same seed (42), which is why cross-collection agreement partly reflects shared inputs rather than independent replication.

## Limitations

- **Enrichment-method dependence**: results reflect one ranking metric (`stat`) and one method (`fgseaMultilevel`) with one size window (15–500); no alternative ranking (e.g., log2FC-based) or ORA-style test was run to check robustness of the specific significant-set list.
- **No new statistical testing of DE genes**: this step re-ranked and re-formatted the existing 875-gene significant table; it did not recompute or validate DESeq2's calls.
- **Gene identifier quality caveat carried forward**: per T2S1's gene-ID mapping output, a large fraction of tested symbols do not resolve via `org.Hs.eg.db`, and several placeholder-style gene IDs (e.g., `GENE06568`, `GENE07358`, `GENE00040`) appear among the top DE and leading-edge genes reported here — no biological identity is claimed for these.
- **Overlap ≠ independent validation**: the 100% NES-sign concordance among overlapping Hallmark/Reactome pairs reflects two curated databases queried against the same ranked list from the same experiment, not two independent biological replicates.
- The literature context cited in `summary_report.md` (immunometabolic inflammation/OXPHOS shift, PMID 32163341) is general domain background, not a dataset-specific validation — a targeted PubMed search for this exact combined signature returned no directly matching study.