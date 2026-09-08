# fgsea Preranked Hallmark and Reactome Enrichment — Treated vs Control

## Key Quantitative Results

**Ranking input** (`output/ranked_gene_list_stat.csv`, `output/run_parameters_summary.csv`)
- Rank metric: DESeq2 Wald statistic (`stat` column), primary treated-vs-control contrast
- 10,071 tested genes ranked, no padj/log2FC pre-filtering; top-ranked gene `IL15RA` (stat = 14.84)

**Identifier mapping** (`output/id_mapping_report.csv`, `output/gene_id_mapping_table.csv`)
- `direct_symbol` (already an official `org.Hs.eg.db` HGNC symbol): 3,667 genes (36.41%)
- `alias_resolved` (unambiguous alias → official symbol): 2 genes (0.02%)
- `unmapped_no_alias` (synthetic `GENE#####` placeholders with no HGNC identity): 6,400 genes (63.55%)
- `unmapped_ambiguous_alias` (alias maps to >1 distinct official symbol, e.g. `NDUFA4`→`COXFA4`/`COXFA4P1`, `CIR1`→`UBE2V1`/`CIRSR`): 2 genes (0.02%)
- **Total unmapped share: 6,402 / 10,071 = 63.57%** (`run_parameters_summary.csv`: `unmapped_share = 0.6357`)
- Duplicate-symbol rows dropped after mapping: 0

**Hallmark collection** (`output/fgsea_hallmark_results.csv`, `output/run_parameters_summary.csv`)
- 50/50 Hallmark sets fell in the 15–500 size window and were tested
- **15 pathways significant at BH padj < 0.05**
- Top hits: `HALLMARK_TNFA_SIGNALING_VIA_NFKB` (NES +2.963, padj = 7.78e-32, size 173), `HALLMARK_OXIDATIVE_PHOSPHORYLATION` (NES −3.074, padj = 1.07e-29, size 155), `HALLMARK_INTERFERON_GAMMA_RESPONSE` (NES +2.814, padj = 1.79e-25, size 171), `HALLMARK_INTERFERON_ALPHA_RESPONSE` (NES +2.615, padj = 4.97e-13, size 79), `HALLMARK_INFLAMMATORY_RESPONSE` (NES +2.094, padj = 6.60e-08, size 174)
- `collapsePathways()` reduces the 15 significant sets to **6 representative sets** (`output/fgsea_hallmark_significant_collapsed_summary.csv`, `is_representative = TRUE` rows): `HALLMARK_TNFA_SIGNALING_VIA_NFKB`, `HALLMARK_OXIDATIVE_PHOSPHORYLATION`, `HALLMARK_INTERFERON_GAMMA_RESPONSE`, `HALLMARK_INFLAMMATORY_RESPONSE`, `HALLMARK_P53_PATHWAY`, `HALLMARK_IL2_STAT5_SIGNALING`

**Reactome collection** (`output/fgsea_reactome_results.csv`, `output/run_parameters_summary.csv`)
- Reactome GMT as shipped: 2,868 pathways, all matched to a *Homo sapiens* stable ID in `ReactomePathways.txt` (2,868/2,868 human)
- 804/2,868 pathways fell in the 15–500 size window and were tested
- **92 pathways significant at BH padj < 0.05**
- Top hits: `Cytokine Signaling in Immune system` (NES +2.166, padj = 2.63e-13, size 405), `Aerobic respiration and respiratory electron transport` (NES −2.600, padj = 1.05e-12, size 112), `Signaling by Interleukins` (NES +2.194, padj = 4.98e-11, size 248), `Respiratory electron transport` (NES −2.586, padj = 5.46e-10, size 63), `Mitochondrial protein degradation` (NES −2.592, padj = 2.30e-09, size 47)
- Per the run log (`logs/fgsea_run.log`), `collapsePathways()` reduces the 92 significant sets to **17 representative sets**

**Hallmark vs Reactome comparison** (`output/hallmark_vs_reactome_overlap_summary.csv`)
- Hallmark significant pathways: 15; Reactome significant pathways: 92
- Union of leading-edge genes: 447 (Hallmark), 471 (Reactome)
- Shared leading-edge genes: 276
- Jaccard overlap of leading-edge gene sets: 0.430

## Method Choices and Rationale

- **Rank metric = Wald statistic**, not log2FC or a p-value-derived score: preserves both magnitude and significance information from the DESeq2 model and avoids the log2FC-only pitfalls documented for preranked GSEA.
- **All tested genes retained**, including 2 Cook's-outlier genes whose `padj` is NA but whose `stat` is not — dropping them would have silently shrunk the background used by fgsea's running-sum null.
- **Unmapped genes kept in the ranked vector under their original name** rather than dropped: fgsea's enrichment score depends on the full rank order of the background list, so removing unmappable genes would distort the null distribution even though those genes can never intersect a real gene set.
- **Alias resolution restricted to unambiguous cases** (`org.Hs.eg.db`, `ALIAS` keytype filtered to exactly one non-NA official `SYMBOL`): prevents silently picking an arbitrary target when an alias is genuinely multi-mapped (2 genes affected, both retained as unmapped rather than guessed).
- **Reactome GMT explicitly filtered to human** via a join against `ReactomePathways.txt`'s species column, per the task's explicit instruction, even though the shipped `ReactomePathways.gmt` (itself a zip archive despite the `.gmt` extension) turned out to already be human-only (2,868/2,868 matched).
- **fgseaMultilevel with `eps = 0`** for maximum p-value precision, `minSize = 15` / `maxSize = 500` applied to genes that actually intersect the ranked list, a fixed seed (42) for reproducibility, and `nproc = 2` to match the 2-core execution budget.
- **`collapsePathways()`** used to reduce each collection's significant hits to non-redundant representative sets, with the full representative↔member table kept as a separate supplement so no information is discarded.
- **Hallmark and Reactome results kept in fully separate CSVs**, never merged into a single ranked list, per the task's explicit constraint.

## Quality Notes

- Ranking is inherited from the upstream DESeq2 primary contrast: n = 5 control vs 6 treated (one QC-flagged sample excluded upstream), Wald test.
- 10,071 genes entered the ranking; only 3,669 (36.4%: 3,667 direct + 2 alias-resolved) carry a real, unambiguous HGNC identity that can be tested against Hallmark/Reactome gene sets.
- 0 duplicate gene-symbol collisions arose after mapping, so no genes were dropped for deduplication.
- Reactome release is recorded as `"current"` in `output/fgsea_reactome_results.csv`'s `release` column — the reference store's Reactome download is a rolling quarterly snapshot with no immutable version tag embedded in the file itself.

## Limitations

- **63.6% of tested genes are unmappable** (`output/id_mapping_report.csv`): the count matrix's gene column mixes real HGNC symbols with synthetic `GENE#####` placeholders that carry no biological identity. All enrichment signal reported here is necessarily driven by the mappable 36.4% subset; any real signal encoded in the unmapped majority is invisible to gene-set-based enrichment by construction.
- This is **hypothesis-generating preranked GSEA, not proof of mechanism** — it establishes statistical association between the ranking and curated gene sets, not causality or cell-type specificity.
- **Redundancy collapsing is heuristic**: the representative pathway chosen per cluster is the most significant member, not a claim of greater biological importance; full membership is preserved in the supplement tables specifically to avoid information loss.
- Sample-size and design caveats from the upstream DE step carry forward unchanged (n = 5 vs 6 after QC exclusion, no batch covariate, no independent donor identifier).
- Reactome's far larger significant-pathway count (92 vs Hallmark's 15) reflects its much finer-grained, heavily nested pathway structure rather than stronger biological support — the collapsed representative counts (6 vs 17) are the fairer basis for cross-collection comparison.