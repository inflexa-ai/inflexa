# Consolidated DE and Pathway Enrichment Report — Treated vs Control

Consolidates T1S1 (sample-structure QC), T1S2 (DESeq2 differential expression), and T2S1 (fgsea Hallmark/Reactome enrichment) into one reproducible report. No DE or enrichment computation is repeated here — every number below is read from those steps' persisted outputs and re-verified by this step's own scripts (`scripts/build_consolidated_gene_table.py`, `scripts/build_enrichment_tables.py`, `scripts/build_pvalue_histogram_interpretation.py`, `scripts/capture_session_info.R`).

## Bottom line

Treated vs control (Wald test, apeglm-shrunken log2FC, BH padj < 0.05) identifies **826 significantly differentially expressed genes** out of **10071 genes tested** after filtering (486 up in treated, 340 down, 2 genes NA for padj as Cook's-distance count outliers). Preranked fgsea on the same contrast's Wald statistic finds **15/50 Hallmark pathways** and **92/804 Reactome pathways** significant at BH padj < 0.05, dominated by innate-immune/inflammatory activation (TNFA/NFKB, interferon alpha and gamma response, cytokine and interleukin signaling — all up in treated) alongside a coordinated **decrease** in oxidative phosphorylation and mitochondrial respiratory-chain pathways. The shallow sample **sample_01 was excluded from this primary contrast** on QC grounds (see below); a sensitivity run retaining it (n=6 vs 6) gave a highly concordant result (Pearson r = 0.9889 on shrunken log2FC across shared tested genes, 875 significant genes) and is reported as a robustness check, not an alternative primary answer.

## Method

**Differential expression (T1S2)**

- Software: DESeq2 1.52.0 (Love, Huber & Anders, *Genome Biology* 2014, doi:10.1186/s13059-014-0550-8), R 4.6.0
- Shrinkage: apeglm 1.34.0 (Zhu, Ibrahim & Love, *Bioinformatics* 2019, doi:10.1093/bioinformatics/bty895), applied to the `condition_treated_vs_control` coefficient
- Design formula: `~condition`, with `condition` releveled so `control` is the explicit reference level
- Named contrast: `contrast = c("condition", "treated", "control")` — positive log2FoldChange = higher in treated
- Test: Wald test, `fitType = "parametric"`, independent filtering on, BH (Benjamini-Hochberg) p-value adjustment, count outliers flagged (Cook's distance) rather than replaced (both group sizes are below DESeq2's default outlier-replacement sample-size threshold)
- alpha = 0.05
- Gene pre-filter: kept genes with ≥10 counts in ≥ the smallest modeled arm size (5, since the primary contrast is 5 control vs 6 treated after excluding sample_01)
- **Count source determination**: `counts.csv` was verified as raw, non-length-scaled integer read counts — integer-valued with 0 negative values, per-sample sums on the order of 0.4–2.7 million (library-scale, not TPM's fixed ~1e6), and an essentially null Spearman correlation between per-gene mean count and gene length (rho = -0.013, p = 0.15), which argues against the counts already being length-divided (a true FPKM/TPM-style division mechanically induces a negative length correlation). `gene_length_reference.csv` was therefore **not** applied to the counts before DESeq2 — DESeq2's own median-of-ratios size factors handle between-sample normalization internally, and gene length does not enter a two-group comparison of the same genes. Full detail: T1S2 `output/count_provenance.md`.
- **Low-depth sample decision and rationale**: `sample_01` (control) had a library size of 420,347 reads — 3.84× below the cohort median (1,614,280) and the shallowest of all 12 samples — with a correspondingly reduced detected-gene count (10,918 vs a cohort median of 11,600) and a low DESeq2 size factor (0.288 vs cohort median 1.076). On the top-500-variable-gene blind-VST PCA it fell correctly on PC1 (the condition axis) but was a **23.77-SD outlier on PC2 relative to its own condition group** — a structural deviation beyond what depth-proportional size-factor down-weighting can absorb. Evidence was assembled across four independent QC lenses (library size, detected genes, PCA, sample-distance matrix; T1S1 `output/qc_decision_memo.md`) before deciding to **exclude sample_01 from the primary DE contrast** (5 control vs 6 treated) **and report a parallel sensitivity run retaining it** (6 vs 6, T1S2 `output/de_results_treated_vs_control_sensitivity.csv`) rather than dropping it silently or keeping it by default.

**Enrichment (T2S1)**

- Software: fgsea 1.38.0 (Korotkevich et al., preranked GSEA; bioRxiv preprint, not PubMed-indexed), R 4.6.0
- Rank metric: DESeq2 Wald statistic (stat column), primary contrast treated vs control
- Method: `fgseaMultilevel`, `eps = 0`, `minSize = 15`, `maxSize = 500`, `nproc = 2`, random seed = 42
- Universe: all 10071 DESeq2-tested genes retained in the ranked vector (no padj/log2FC pre-filtering). Of these, 3669 (36.4%) carry a resolvable HGNC gene symbol (`org.Hs.eg.db` 3.23.1 (alias resolution, unambiguous aliases only)) and can intersect a Hallmark/Reactome gene set; the remaining 6402 (63.6%, mostly synthetic `GENE#####` placeholder symbols with no HGNC identity) are **retained in the ranked vector under their original name** so the background used by fgsea's running-sum null is not distorted, even though they can never contribute a leading-edge hit.
- Hallmark database: MSigDB Hallmark human, release 2026.1 (h.all.v2026.1.Hs.symbols.gmt) — 50 sets shipped, 50 in the 15–500 size window
- Reactome database: Reactome Pathways, 'current' release as staged in the reference store (quarterly rolling snapshot, no immutable version tag; restricted to Homo sapiens via ReactomePathways.txt) — 2868 sets shipped (all species), 2868 human, 804 in the 15–500 size window
- Significance threshold: BH padj < 0.05, applied within each collection separately (Hallmark and Reactome results are never merged into one ranked list or one adjustment)
- Redundancy reduction: `fgsea::collapsePathways()` applied per collection to identify non-redundant representative sets (full cluster membership retained in the supplement tables, not discarded)

## Gene table

Full per-gene results for all 10071 tested genes — unshrunken log2FoldChange, apeglm-shrunken log2FoldChange, both lfcSE estimates, Wald statistic, pvalue, and padj — are in `output/consolidated_gene_table_ranked_by_shrunken_lfc.csv`, **ranked by shrunken_log2FoldChange descending** (most up in treated → most down in treated), per the DESeq2 vignette's guidance to use the shrunken estimate for visualization and ranking (shrinkage removes the inflated, noise-driven log2FC estimates that occur for genes with high dispersion or low counts, so ranking on the raw MLE would surface artifacts rather than genuine top hits).

Top 5 rows (by shrunken log2FoldChange, descending) and bottom 5 (most negative):

| rank | gene | log2FoldChange | shrunken_log2FoldChange | lfcSE | shrunken_lfcSE | pvalue | padj | significant |
|---:|---|---:|---:|---:|---:|---:|---:|:---:|
| 1 | IL15RA | 6.401 | 6.344 | 0.431 | 0.433 | 7.65e-50 | 7.70e-46 | True |
| 2 | GENE07358 | 3.905 | 3.813 | 0.426 | 0.431 | 4.45e-20 | 3.45e-17 | True |
| 3 | GENE00040 | 3.669 | 3.622 | 0.297 | 0.299 | 3.77e-35 | 1.90e-31 | True |
| 4 | GENE06568 | 3.968 | 3.606 | 0.816 | 0.869 | 1.16e-06 | 4.71e-05 | True |
| 5 | NFE2L2 | 3.674 | 3.587 | 0.400 | 0.406 | 3.89e-20 | 3.26e-17 | True |
| 10067 | GENE05373 | -3.126 | -2.972 | 0.481 | 0.494 | 8.31e-11 | 1.07e-08 | True |
| 10068 | GENE05017 | -3.078 | -3.014 | 0.312 | 0.315 | 6.50e-23 | 1.09e-19 | True |
| 10069 | MRE11 | -3.920 | -3.761 | 0.556 | 0.560 | 1.80e-12 | 4.03e-10 | True |
| 10070 | UQCRC2 | -4.570 | -4.457 | 0.502 | 0.508 | 8.76e-20 | 5.88e-17 | True |
| 10071 | SLC25A5 | -4.803 | -4.710 | 0.472 | 0.472 | 2.30e-24 | 4.63e-21 | True |

**10071 genes tested after filtering; 826 significant at padj < 0.05** (486 up / 340 down in treated).

## Fit diagnostics

- **MA plot** (apeglm-shrunken log2FC vs baseMean, per the DESeq2 vignette's recommendation to plot the shrunken estimate to avoid the low-count fanning artifact): `figures/ma_plot_primary_shrunken.png` / `.pdf`
- **Dispersion plot** (gene-wise, fitted trend, and shrunken ("final") dispersion estimates): `figures/dispersion_plot_primary.png` / `.pdf`
- **Volcano plot** (shrunken log2FC vs -log10 padj, top hits labeled): `figures/volcano_plot_primary.png` / `.pdf`

## P-value histogram

`figures/pvalue_histogram_primary.png` / `.pdf`

Bin counts (`output/pvalue_histogram_bin_counts.csv`, 20 equal-width bins over [0,1], n = 10069 genes with a non-NA raw p-value): the first bin [0, 0.05) holds 1557 genes, 3.58× the mean bin count in the flat tail (p ≥ 0.4: mean 435.3 genes/bin, SD 11.7), and the last bin [0.95, 1.0] holds 447 genes — close to the tail mean, not elevated.

**Interpretation**: this is the expected, well-behaved shape for a dataset with real differential expression — a clear enrichment near p = 0 (true positives plus some power) sitting on top of an approximately uniform (flat) distribution across the rest of the range (the null genes, for which p-values are uniform by construction under a correctly calibrated test). There is no anomalous peak near p = 1 and no excess mass at the low end beyond the flat baseline that would signal a badly fitting null (e.g., overdispersion not captured by the model, or a mis-specified design). This supports treating the BH-adjusted padj values as a valid basis for calling significance at the stated threshold.

## Hallmark enrichment

`output/hallmark_enrichment_table.csv` — all 50 Hallmark sets in the 15–500 size window, sorted by padj. **15 significant at BH padj < 0.05**, collapsed by `collapsePathways()` to **6 non-redundant representative sets** (`output/hallmark_collapsed_representative_sets.csv`).

Database version: MSigDB Hallmark human release 2026.1. Rank metric: DESeq2 Wald statistic. Universe: 10,071 tested genes (3,669 with resolvable HGNC symbol). Size window: 15–500.

All significant Hallmark sets (leading-edge genes truncated to first 8; full lists in `output/hallmark_leading_edge_genes_significant.csv`):

| pathway | size | NES | pval | padj | leading-edge genes (preview) |
|---|---:|---:|---:|---:|---|
| HALLMARK_TNFA_SIGNALING_VIA_NFKB | 173 | 2.963 | 1.56e-33 | 7.78e-32 | IL15RA, NFE2L2, BTG2, PTGS2, ICAM1, TNFAIP6, NFAT5, DNAJB4, … (+88 more) |
| HALLMARK_OXIDATIVE_PHOSPHORYLATION | 155 | -3.074 | 4.28e-31 | 1.07e-29 | SLC25A5, UQCRC2, SDHD, PDK4, ATP6V1H, CPT1A, NDUFB3, ACO2, … (+77 more) |
| HALLMARK_INTERFERON_GAMMA_RESPONSE | 171 | 2.814 | 1.08e-26 | 1.79e-25 | IL15RA, NOD1, PTGS2, ICAM1, CMPK2, TNFAIP6, TXNIP, TAP1, … (+83 more) |
| HALLMARK_INTERFERON_ALPHA_RESPONSE | 79 | 2.615 | 3.97e-14 | 4.97e-13 | CMPK2, TXNIP, TAP1, PSME2, PSMB8, PNPT1, SAMD9L, PARP14, … (+34 more) |
| HALLMARK_INFLAMMATORY_RESPONSE | 174 | 2.094 | 6.60e-09 | 6.60e-08 | IL15RA, BTG2, ICAM1, TNFAIP6, TNFSF9, CDKN1A, FPR1, IFNGR2, … (+38 more) |
| HALLMARK_P53_PATHWAY | 171 | 1.759 | 5.32e-05 | 3.80e-04 | CDKN2B, BTG2, HMOX1, TXNIP, TAP1, TNFSF9, CDKN1A, SPHK1, … (+36 more) |
| HALLMARK_ADIPOGENESIS | 175 | -1.679 | 4.79e-05 | 3.80e-04 | PIM3, ACO2, DRAM2, NDUFAB1, CS, GPX4, PRDX3, ATP5PO, … (+44 more) |
| HALLMARK_ALLOGRAFT_REJECTION | 171 | 1.689 | 2.15e-04 | 1.34e-03 | ICAM1, TAP1, IFNGR2, RIPK2, BCL3, IRF7, CCL5, INHBA, … (+33 more) |
| HALLMARK_IL6_JAK_STAT3_SIGNALING | 78 | 1.809 | 4.21e-04 | 2.34e-03 | IL15RA, HMOX1, PIM1, IL17RA, IFNGR2, STAT3, IL6ST, IL6, … (+14 more) |
| HALLMARK_APOPTOSIS | 131 | 1.725 | 4.90e-04 | 2.45e-03 | BTG2, HMOX1, TXNIP, TAP1, SOD2, CDKN1A, GCH1, RELA, … (+25 more) |
| HALLMARK_COMPLEMENT | 173 | 1.571 | 1.14e-03 | 5.19e-03 | PIM1, GNAI2, PSMB9, KYNU, EHD1, CFH, IRF7, ME1, … (+33 more) |
| HALLMARK_HYPOXIA | 165 | 1.502 | 4.15e-03 | 1.73e-02 | HMOX1, PIM1, CDKN1A, PPP1R15A, VEGFA, IL6, PLAUR, ISG20, … (+34 more) |
| HALLMARK_KRAS_SIGNALING_UP | 170 | 1.475 | 6.31e-03 | 2.43e-02 | PTGS2, CFHR2, PSMB8, PPP1R15A, CFH, IL7R, SCG5, INHBA, … (+23 more) |
| HALLMARK_IL2_STAT5_SIGNALING | 166 | 1.462 | 9.06e-03 | 3.24e-02 | PIM1, AGER, SPRED2, PHLDA1, FGL2, CASP3, RRAGD, ETV4, … (+42 more) |
| HALLMARK_UV_RESPONSE_UP | 132 | 1.469 | 1.33e-02 | 4.44e-02 | CDKN2B, BTG2, ICAM1, HMOX1, TAP1, SOD2, CYB5R1, GCH1, … (+23 more) |

Figures: `figures/enrichment_dotplot_hallmark.png` / `.pdf`; barplot and ridgeplot versions in T2S1's figure set.

## Reactome enrichment

`output/reactome_enrichment_table.csv` — all 804 Reactome sets in the 15–500 size window, sorted by padj. **92 significant at BH padj < 0.05**, collapsed by `collapsePathways()` to **17 non-redundant representative sets** (`output/reactome_collapsed_representative_sets.csv`).

Database version: Reactome Pathways, 'current' release as staged in the reference store — a rolling quarterly snapshot with **no immutable version tag embedded in the download itself**; restricted to *Homo sapiens* via a join against `ReactomePathways.txt` (2,868/2,868 shipped sets matched human — the file happened to already be human-only). Rank metric: DESeq2 Wald statistic. Universe: 10,071 tested genes (3,669 with resolvable HGNC symbol). Size window: 15–500.

Top 15 of 92 significant Reactome sets by padj (full list in the CSV; leading-edge genes truncated to first 8, full lists in `output/reactome_leading_edge_genes_significant.csv`):

| pathway | size | NES | pval | padj | leading-edge genes (preview) |
|---|---:|---:|---:|---:|---|
| Cytokine Signaling in Immune system | 405 | 2.166 | 3.27e-16 | 2.63e-13 | IL15RA, NOD1, PTGS2, ICAM1, HMOX1, TNFSF9, PSME2, SOD2, … (+108 more) |
| Aerobic respiration and respiratory electron transport | 112 | -2.600 | 2.60e-15 | 1.05e-12 | UQCRC2, SDHD, PDK4, NDUFB3, ACO2, ATP5F1C, NDUFAB1, ATP5PB, … (+43 more) |
| Signaling by Interleukins | 248 | 2.194 | 1.86e-13 | 4.98e-11 | IL15RA, NOD1, PTGS2, ICAM1, HMOX1, PSME2, SOD2, PIM1, … (+60 more) |
| Respiratory electron transport | 63 | -2.586 | 2.72e-12 | 5.46e-10 | UQCRC2, SDHD, NDUFB3, NDUFAB1, NDUFS4, ETFDH, NDUFA6, NDUFV1, … (+26 more) |
| Mitochondrial protein degradation | 47 | -2.592 | 1.43e-11 | 2.30e-09 | SLC25A5, UQCRC2, ACO2, PRKACA, ATP5F1C, CS, PDHB, NDUFV1, … (+14 more) |
| Complex I biogenesis | 30 | -2.413 | 8.10e-09 | 1.08e-06 | NDUFB3, NDUFAB1, NDUFS4, NDUFA6, NDUFV1, NDUFS6, NDUFA8, NDUFC2, … (+12 more) |
| Interleukin-1 family signaling | 70 | 2.309 | 1.43e-08 | 1.65e-06 | NOD1, AGER, TBK1, IKBKG, RIPK2, IL18BP, PSMA2, STAT3, … (+16 more) |
| Toll Like Receptor 3 (TLR3) Cascade | 56 | 2.235 | 8.54e-08 | 8.58e-06 | NOD1, AGER, TBK1, IKBKG, RIPK2, IRF7, MEF2A, RELA, … (+18 more) |
| Interferon Signaling | 153 | 1.992 | 1.78e-07 | 1.59e-05 | ICAM1, PIM1, PSMB8, CIITA, IKBKG, IFNGR2, SPHK1, IFI35, … (+42 more) |
| MyD88-independent TLR4 cascade | 59 | 2.216 | 2.29e-07 | 1.67e-05 | NOD1, AGER, TBK1, IKBKG, RIPK2, IRF7, MEF2A, RELA, … (+18 more) |
| TRIF (TICAM1)-mediated TLR4 signaling | 59 | 2.216 | 2.29e-07 | 1.67e-05 | NOD1, AGER, TBK1, IKBKG, RIPK2, IRF7, MEF2A, RELA, … (+18 more) |
| Toll-like Receptor Cascades | 83 | 2.145 | 3.63e-07 | 2.44e-05 | NOD1, AGER, TBK1, IKBKG, RIPK2, IRF7, MEF2A, TLR8, … (+17 more) |
| Toll Like Receptor 4 (TLR4) Cascade | 71 | 2.159 | 7.90e-07 | 4.88e-05 | NOD1, AGER, TBK1, IKBKG, RIPK2, IRF7, MEF2A, RELA, … (+20 more) |
| TAK1-dependent IKK and NF-kappa-B activation | 23 | 2.180 | 1.03e-06 | 5.91e-05 | NOD1, AGER, IKBKG, RIPK2, RELA, USP18, UBC, NFKBIA, … (+2 more) |
| MyD88 dependent cascade initiated on endosome | 55 | 2.125 | 1.35e-06 | 7.25e-05 | NOD1, AGER, IKBKG, RIPK2, IRF7, MEF2A, RELA, TNIP2, … (+15 more) |

Figures: `figures/enrichment_dotplot_reactome.png` / `.pdf`.

## Hallmark vs Reactome comparison

Hallmark significant sets: 15; Reactome significant sets: 92. Leading-edge gene union: 447 (Hallmark), 471 (Reactome); 276 genes shared; Jaccard overlap = 0.430. Reactome's much larger significant-set count reflects its finer-grained, heavily nested pathway structure (e.g., a dozen near-identical Toll-like-receptor cascade entries) rather than stronger biological support — the collapsed representative counts (6 Hallmark vs 17 Reactome) are the fairer basis for cross-collection comparison. (`output/hallmark_vs_reactome_overlap_summary.csv`)

## Literature grounding

- The joint pattern of **up**: TNFA/NFKB signaling, interferon-alpha and -gamma response, inflammatory response, cytokine/interleukin signaling, and **down**: oxidative phosphorylation / mitochondrial respiratory-chain assembly is the transcriptional signature classically associated with innate-immune/inflammatory cell activation, which represses OXPHOS in favor of glycolysis (immunometabolic reprogramming). Confirmed by prior literature, e.g. Mills et al., *Cell* 2016 (PMID 27667687, doi:10.1016/j.cell.2016.08.064): LPS-activated macrophages shift from oxidative phosphorylation to glycolysis while inducing a pro-inflammatory gene expression program. Assessment: **confirmed** (directly supported, general pattern; this analysis does not establish the specific cell type or stimulus).
- Top DE hit `IL15RA` (IL-15 receptor alpha) searched specifically in PubMed for an inflammatory-response association: no directly matching hit was returned beyond its role in bone/osteoblast biology (PMID 28602725), which is not on-topic here. Assessment: **expected** from domain knowledge (IL-15/IL-15RA signaling is a well-established component of innate and adaptive immune activation, part of the IL2/STAT5 and inflammatory-response Hallmark leading edges reported above) rather than a novel or literature-confirmed finding from this specific search.
- Method citations: DESeq2 (Love, Huber & Anders 2014, PMID 25516281); apeglm (Zhu, Ibrahim & Love 2019, PMID 30395178, doi:10.1093/bioinformatics/bty895 — matches the citation given in this task's constraints); fgsea (Korotkevich et al., bioRxiv preprint — not indexed in PubMed, searched and confirmed absent).

## Design limitations (stated per task constraints)

- **No subject/donor identifier separate from `sample` exists in `metadata.csv`.** Biological independence of the 6 control / 6 treated replicates cannot be confirmed from the metadata alone; independence is assumed, not verified.
- **No batch, lane, run-date, or other technical-batch field is present anywhere in the inputs.** Batch effects cannot be assessed or corrected for; any residual unexplained structure (e.g., sample_01's PC2 deviation) cannot be attributed to batch vs. biology vs. sequencing depth with the metadata available.
- **63.6% of the 10,071 tested genes carry no resolvable HGNC identity** (synthetic `GENE#####` placeholders) and are therefore invisible to gene-set-based enrichment by construction; all Hallmark/Reactome signal reported here is necessarily driven by the mappable 36.4% subset.
- Preranked fgsea establishes statistical association between the ranking and curated gene sets — it is hypothesis-generating, not proof of mechanism or cell-type specificity.

## Reproducibility record

**Random seeds**: fgsea (T2S1) used `set.seed(42)` for `fgseaMultilevel`'s Monte Carlo sampling. DESeq2/apeglm (T1S2) use deterministic optimization (Wald test, apeglm's Cauchy-prior MAP estimate) — no seed is required or was set.

**Gene-set collection versions**: Hallmark = MSigDB Hallmark human, release 2026.1 (h.all.v2026.1.Hs.symbols.gmt). Reactome = Reactome Pathways, 'current' release as staged in the reference store (quarterly rolling snapshot, no immutable version tag; restricted to Homo sapiens via ReactomePathways.txt).

**Annotation release**: `org.Hs.eg.db` 3.23.1 (alias resolution, unambiguous aliases only), used only for symbol/alias resolution ahead of enrichment (not used in the DESeq2 model itself).

**R package versions** (this step's R environment, identical package set to T1S2/T2S1's shared sandbox image; `output/package_versions_R.csv`):

| package | version |
|---|---|
| DESeq2 | 1.52.0 |
| apeglm | 1.34.0 |
| fgsea | 1.38.0 |
| org.Hs.eg.db | 3.23.1 |
| AnnotationDbi | 1.74.0 |
| data.table | 1.18.4 |
| ggplot2 | 4.0.3 |
| ggrepel | 0.9.8 |
| pheatmap | 1.0.13 |
| ggridges | 0.5.7 |
| BiocParallel | 1.46.0 |

**Full R `sessionInfo()`** (`output/session_info_R.txt`):

```
R version 4.6.0 (2026-04-24)
Platform: aarch64-unknown-linux-gnu
Running under: Ubuntu 24.04.4 LTS

Matrix products: default
BLAS:   /usr/lib/aarch64-linux-gnu/openblas-pthread/libblas.so.3 
LAPACK: /usr/lib/aarch64-linux-gnu/openblas-pthread/libopenblasp-r0.3.26.so;  LAPACK version 3.12.0

locale:
 [1] LC_CTYPE=en_US.UTF-8       LC_NUMERIC=C              
 [3] LC_TIME=en_US.UTF-8        LC_COLLATE=en_US.UTF-8    
 [5] LC_MONETARY=en_US.UTF-8    LC_MESSAGES=en_US.UTF-8   
 [7] LC_PAPER=en_US.UTF-8       LC_NAME=C                 
 [9] LC_ADDRESS=C               LC_TELEPHONE=C            
[11] LC_MEASUREMENT=en_US.UTF-8 LC_IDENTIFICATION=C       

time zone: Etc/UTC
tzcode source: system (glibc)

attached base packages:
[1] stats4    stats     graphics  grDevices utils     datasets  methods  
[8] base     

other attached packages:
 [1] BiocParallel_1.46.0         ggridges_0.5.7             
 [3] pheatmap_1.0.13             ggrepel_0.9.8              
 [5] ggplot2_4.0.3               data.table_1.18.4          
 [7] org.Hs.eg.db_3.23.1         AnnotationDbi_1.74.0       
 [9] fgsea_1.38.0                apeglm_1.34.0              
[11] DESeq2_1.52.0               SummarizedExperiment_1.42.0
[13] Biobase_2.72.0              MatrixGenerics_1.24.0      
[15] matrixStats_1.5.0           GenomicRanges_1.64.0       
[17] Seqinfo_1.2.0               IRanges_2.46.0             
[19] S4Vectors_0.50.2            BiocGenerics_0.58.1        
[21] generics_0.1.4             

loaded via a namespace (and not attached):
 [1] KEGGREST_1.52.2     fastmatch_1.1-8     gtable_0.3.6       
 [4] lattice_0.22-9      numDeriv_2016.8-1.1 vctrs_0.7.3        
 [7] tools_4.6.0         parallel_4.6.0      tibble_3.3.1       
[10] RSQLite_3.53.2      blob_1.3.0          pkgconfig_2.0.3    
[13] Matrix_1.7-5        RColorBrewer_1.1-3  S7_0.2.2           
[16] lifecycle_1.0.5     compiler_4.6.0      farver_2.1.2       
[19] Biostrings_2.80.1   codetools_0.2-20    crayon_1.5.3       
[22] pillar_1.11.1       MASS_7.3-65         DelayedArray_0.38.2
[25] cachem_1.1.0        emdbook_1.3.14      abind_1.4-8        
[28] tidyselect_1.2.1    locfit_1.5-9.12     bdsmatrix_1.3-7    
[31] mvtnorm_1.4-1       dplyr_1.2.1         fastmap_1.2.0      
[34] cowplot_1.2.0       grid_4.6.0          cli_3.6.6          
[37] SparseArray_1.12.2  magrittr_2.0.5      S4Arrays_1.12.0    
[40] dichromat_2.0-0.1   withr_3.0.3         scales_1.4.0       
[43] bit64_4.8.2         httr_1.4.8          XVector_0.52.0     
[46] bit_4.6.0           otel_0.2.0          png_0.1-9          
[49] coda_0.19-4.1       memoise_2.0.1       bbmle_1.0.25.1     
[52] rlang_1.2.0         Rcpp_1.1.1-1.1      glue_1.8.1         
[55] DBI_1.3.0           R6_2.6.1            plyr_1.8.9
```

## Output files

- `output/consolidated_gene_table_ranked_by_shrunken_lfc.csv` — full per-gene DE table
- `output/gene_table_summary_stats.csv` — n tested / n significant / up / down / NA counts
- `output/pvalue_histogram_bin_counts.csv`, `output/pvalue_histogram_interpretation_stats.csv`
- `output/hallmark_enrichment_table.csv`, `output/reactome_enrichment_table.csv` — full per-pathway tables (all tested sets), separate by collection
- `output/hallmark_leading_edge_genes_significant.csv`, `output/reactome_leading_edge_genes_significant.csv` — long-format leading-edge genes for padj<0.05 sets
- `output/hallmark_collapsed_representative_sets.csv`, `output/reactome_collapsed_representative_sets.csv` — non-redundant representative pathways
- `output/hallmark_vs_reactome_overlap_summary.csv`
- `output/enrichment_run_metadata.csv` — rank metric, universe, size window, database versions in one table
- `output/session_info_R.txt`, `output/package_versions_R.csv` — reproducibility record
- `figures/ma_plot_primary_shrunken.{png,pdf}`, `figures/dispersion_plot_primary.{png,pdf}`, `figures/pvalue_histogram_primary.{png,pdf}`, `figures/volcano_plot_primary.{png,pdf}`, `figures/enrichment_dotplot_hallmark.{png,pdf}`, `figures/enrichment_dotplot_reactome.{png,pdf}`
