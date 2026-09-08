```markdown
# Consolidated DE and Pathway Enrichment Report — Summary of Work Completed

## What this step did

This was a **report/aggregation step**, not a new analysis. It combined outputs from three prior steps — T1S1 (sample QC), T1S2 (DESeq2 differential expression), and T2S1 (fgsea Hallmark/WikiPathways enrichment) — into a single reproducibility-grade consolidated report. A script (`scripts/build_consolidated_report.py`) re-ranked the DE table by shrunken log2FoldChange, independently re-derived a p-value histogram bin table directly from the raw p-values as a verification step, filtered enrichment results to significant sets, copied the relevant figures, and wrote a machine-readable reproducibility record. No new statistical inference (no re-fitting of DESeq2, no re-running of fgsea) was performed.

## Key quantitative results

### Differential expression (`output/de_results_ranked_by_shrunken_lfc.csv`, `output/reproducibility_record.json`)
- Universe: 12,000 input genes → **9,782** after the expression filter → **9,402** genes tested (non-NA `padj`).
- Full ranked table has **9,782 rows**, sorted descending by `log2FoldChange_shrunken_apeglm`.
- Top gene by shrunken LFC: **IL15RA** — base_mean 546.1, shrunken log2FC 6.450, unshrunken log2FC 6.504, lfcSE 0.422, stat 15.339, pvalue 4.19e-53, padj 3.93e-49 (`output/de_top20_up_by_shrunken_lfc.csv`, row 1).
- Bottom gene by shrunken LFC: **UQCRC2** — shrunken log2FC -4.425, unshrunken log2FC -4.528, lfcSE 0.484, padj 2.29e-18 (last row of `output/de_results_ranked_by_shrunken_lfc.csv`).
- Second-lowest: **GENE05017**, shrunken log2FC -3.040, padj 3.62e-23.

### p-value histogram (`output/pvalue_histogram_bins.csv`, independently re-derived, 9,782 raw p-values, 10 bins of width 0.1)
| bin | n_genes | fraction | expected under uniform |
|---|---:|---:|---:|
| [0.0, 0.1) | 2003 | 20.5% | 978.2 |
| [0.1, 0.2) | 848 | 8.7% | 978.2 |
| [0.2, 0.3) | 888 | 9.1% | 978.2 |
| [0.3, 0.4) | 879 | 9.0% | 978.2 |
| [0.4, 0.5) | 848 | 8.7% | 978.2 |
| [0.5, 0.6) | 926 | 9.5% | 978.2 |
| [0.6, 0.7) | 801 | 8.2% | 978.2 |
| [0.7, 0.8) | 832 | 8.5% | 978.2 |
| [0.8, 0.9) | 905 | 9.3% | 978.2 |
| [0.9, 1.0] | 852 | 8.7% | 978.2 |

Clear excess near 0 (2,003 vs. 978.2 expected), roughly flat elsewhere — the well-behaved shape expected under a mix of true nulls and true positives, supporting the validity of the BH-adjusted `padj` values.

### Enrichment (`output/reproducibility_record.json`, `output/hallmark_significant_with_leading_edge.csv`, `output/hallmark_collapsed_main_pathways.csv`, `output/wikipathways_significant_with_leading_edge.csv`, `output/wikipathways_collapsed_main_pathways.csv`)
- Rank metric: DESeq2 Wald `stat`; universe = 9,782 ranked genes; size window minSize=15/maxSize=500; eps=0; padj cutoff 0.05; fgsea seed **20260904** (identical for both collections).
- **Hallmark** (MSigDB Hallmark **2026.1**, `h.all.v2026.1.Hs.symbols.gmt`): 50/50 sets tested; **8 collapsed main pathways** persisted in `hallmark_collapsed_main_pathways.csv`. Top two by |NES|:
  - `HALLMARK_TNFA_SIGNALING_VIA_NFKB`: NES 2.943, padj 4.30e-33, size 169, leading edge includes IL15RA, BTG2, ICAM1, NFE2L2, PTGS2, … (98 genes total per `hallmark_significant_with_leading_edge.csv`); 5 sets folded in (APOPTOSIS, KRAS_SIGNALING_UP, UV_RESPONSE_UP, HYPOXIA, IL2_STAT5_SIGNALING).
  - `HALLMARK_OXIDATIVE_PHOSPHORYLATION`: NES -3.072, padj 2.88e-29, size 151, 87 leading-edge genes (UQCRC2, SDHD, ATP6V1H, PDK4, CPT1A, …); no sets folded in.
  - Also collapsed: HALLMARK_INTERFERON_GAMMA_RESPONSE (NES 2.770, padj 1.04e-25), HALLMARK_INFLAMMATORY_RESPONSE (NES 2.085, padj 9.95e-9), HALLMARK_P53_PATHWAY (NES 1.792, padj 9.49e-5), HALLMARK_ADIPOGENESIS (NES -1.722, padj 1.81e-4), HALLMARK_COMPLEMENT (NES 1.596, padj 3.68e-3), HALLMARK_UNFOLDED_PROTEIN_RESPONSE (NES 1.441, padj 4.69e-2).
- **WikiPathways** (**2026.07.10**, `wikipathways_human_2026.07.10_hgnc_symbols.gmt`): 402 sets tested inside the size window; **101 significant sets** persisted with leading edge (`wikipathways_significant_with_leading_edge.csv`); collapsing to **32 main pathways**. Top hits (`wikipathways_collapsed_main_pathways.csv`):
  - `Electron_transport_chain_OXPHOS_system_in_mitochondria_(WP111)`: NES -2.774, padj 5.71e-14, size 59, 37 leading-edge genes.
  - `Oxidative_phosphorylation_(WP623)`: NES -2.570, padj 5.95e-9, size 38, 25 leading-edge genes.

### Shallow sample (`output/reproducibility_record.json`)
- **sample_01** (control): library size **420,347** counts, **0.26×** the cohort median (1,614,280), 10,918 detected genes, DESeq2 size factor **0.2835** (lowest in the cohort).
- QC flag: did not trip the automated 1/4-of-median low-depth rule (ratio 0.260 vs. cutoff 0.250) but is the cohort's unambiguous depth outlier.
- PCA: PC1 = within the control cluster (55.1% variance, correct condition placement); PC2 outlier (+20.56 vs. -5.82 to +2.68 for all other samples).
- Cook's-distance check at the DE step: **0** outlier-flagged genes attributed to sample_01, identical to every other sample.
- **Decision: KEPT** in the final DESeq2 model (design `~condition`, all 12 samples) — depth alone was not treated as a removal criterion, and the leverage check found no evidence to justify exclusion.

### GC/length bias diagnostic (`output/reproducibility_record.json`)
- No length-driven trend detected in any of the 12 samples; max |Pearson r| = **0.0176** (sample_07), p > 0.08 for all samples.
- GC content itself could not be assessed — only gene length was available.

### Reproducibility record (`output/reproducibility_record.json`)
- Design formula `~condition`; contrast condition treated vs. control (control = reference); alpha = 0.05; BH multiple-testing correction with independent filtering; gene filter ≥10 counts in ≥6 samples.
- Package versions: R 4.6.0, DESeq2 1.52.0, apeglm 1.34.0, ashr 2.2.63, fgsea 1.38.0, ggplot2 4.0.3; environment match recorded as "exact" against pinned versions.
- fgsea seed 20260904 used identically for both Hallmark and WikiPathways runs (Monte Carlo tie-breaking and `collapsePathways()`); DESeq2/apeglm steps are deterministic and unseeded.

## Method choices and rationale

- **Ranked-by-shrunken-LFC display table** retains both `log2FoldChange_shrunken_apeglm` and `log2FoldChange_unshrunken_MLE` side by side so shrinkage effects on individual genes remain auditable rather than hidden.
- **p-value histogram re-derivation**: rather than trusting only prose from the upstream summary, the bin counts were recomputed directly from the persisted raw p-value column as an independent verification step.
- **Significant-only enrichment exports with leading-edge gene counts**: filtering to padj<0.05 and adding an explicit `n_leading_edge_genes` column makes the size of each leading-edge set auditable without needing to parse the semicolon-delimited string manually.
- **Figures copied, not regenerated**: MA plot, dispersion plot, p-value histogram, length-bias scatter, PCA, and both enrichment dot/NES-bar plots were copied verbatim from T1S2/T2S1 into this step's `figures/` directory rather than re-plotted, to avoid introducing any discrepancy with the actual upstream-executed analysis.

## Quality notes

- Design is balanced: 6 control vs. 6 treated (from upstream metadata), reflected in the `~condition` design formula and contrast in `output/reproducibility_record.json`.
- GSEA universe (9,782 genes with a Wald statistic) is explicitly documented as distinct from the 875-gene padj<0.05 DE list — the standard preranked-GSEA universe, not a hypergeometric overlap test.
- WikiPathways collection is far more redundant than Hallmark: 101 significant sets collapse to only 32 main pathways, versus Hallmark's 16 collapsing to 8.

## Limitations

- This step performed no new statistical modeling; all quantitative results trace back to T1S2 (DESeq2) and T2S1 (fgsea) artifacts and are only reformatted, re-ranked, or (for the p-value histogram) re-derived by direct recomputation from persisted raw p-values.
- Enrichment results are ranking-metric-dependent (DESeq2 Wald `stat` was used); a different ranking choice could change which sets cross significance or alter leading-edge composition — the report states this as a caveat and frames Hallmark/WikiPathways hits as candidate pathways, not established mechanism.
- GC-content bias could not be evaluated (only gene length was available), so a GC-driven artifact cannot be ruled out.
- The shallow sample (sample_01) was retained based on the available diagnostics (Cook's distance, PCA/clustering behavior); no alternative model excluding it was fit in this step or any upstream step referenced here, so the quantitative sensitivity of the 875-gene DE list to its inclusion is not directly measured.
```