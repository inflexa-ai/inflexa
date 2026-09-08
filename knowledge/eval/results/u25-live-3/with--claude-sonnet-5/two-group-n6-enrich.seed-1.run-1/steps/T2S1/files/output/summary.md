All numbers confirmed against persisted artifacts. Here is the final summary.

# fgsea Preranked GSEA — Treated vs Control (Hallmark, Reactome, WikiPathways)

## Key Quantitative Results

**Ranking input** (`output/ranked_genes_symbol.csv`, `output/ranked_genes_entrez.csv`, `output/gene_mapping_join_qc.json`):
- 9,402 genes ranked (the full set DESeq2 tested in T1S2, i.e. those with a non-NA `adjusted_pvalue`), ranked by the signed DESeq2 Wald `stat`.
- 3,403 of these 9,402 (36.19%) map to a real HGNC symbol / Entrez ID; 5,999 (63.80%) are synthetic `GENE#####` placeholder IDs with no real gene-set membership possible.
- 0 duplicate identifiers in either the symbol-keyed or Entrez-keyed ranked list.

**MSigDB Hallmark human, 2026.1** (`output/hallmark_summary.json`, `output/hallmark_results.csv`, `output/hallmark_collapsed.csv`):
- 50/50 gene sets entered the fgsea size window (15–500 members among ranked genes); 3,400 distinct ranked genes fell in at least one Hallmark set.
- 15 significant at BH-adjusted p < 0.05 (13 positive NES, 2 negative), collapsing to 8 non-redundant main pathways.
- Top hits: `HALLMARK_TNFA_SIGNALING_VIA_NFKB` (NES = 2.989, padj = 2.558e-32, size = 165/200 members, 82.5% coverage), `HALLMARK_OXIDATIVE_PHOSPHORYLATION` (NES = −3.049, padj = 2.602e-28, size = 145/200, 72.5% coverage), `HALLMARK_INTERFERON_GAMMA_RESPONSE` (NES = 2.797, padj = 4.477e-25, size = 167/200, 83.5% coverage), `HALLMARK_INFLAMMATORY_RESPONSE` (NES = 2.116, padj = 2.711e-08, 84.0% coverage).

**Reactome pathways, "current" release** (`output/reactome_summary.json`, `output/reactome_results.csv`, `output/reactome_collapsed.csv`):
- 2,868 human gene sets staged; 766 entered the size window; 2,852 distinct ranked genes fell in at least one set.
- 97 significant (90 positive, 7 negative NES), collapsing to 22 main pathways.
- Top hits (`output/significant_pathways_all_collections.csv`): `Cytokine Signaling in Immune system` (NES = 2.215, padj = 1.276e-14, 379/852 members, 44.5% coverage), `Aerobic respiration and respiratory electron transport` (NES = −2.587, padj = 1.345e-11), `Interleukin-1 family signaling` (NES = 2.328, padj = 3.220e-07), `Mitochondrial protein degradation` (NES = −2.390, padj = 5.173e-07).

**WikiPathways human, 2026.07.10** (`output/wikipathways_summary.json`, `output/wikipathways_results.csv`, `output/wikipathways_collapsed.csv`):
- 987 gene sets staged; 390 entered the size window; 2,567 distinct ranked genes fell in at least one set.
- 99 significant (92 positive, 7 negative NES), collapsing to 34 main pathways.
- Top hits: `Electron transport chain OXPHOS system in mitochondria` (WP111, NES = −2.819, padj = 3.355e-13), `Cancer pathways` (WP5434, NES = 1.943, padj = 3.978e-07), `Cytosolic DNA sensing pathway` (WP4655, NES = 2.318, padj = 2.915e-06).

**Coverage fractions** (`output/pathway_coverage_{hallmark,reactome,wikipathways}.csv`) — per-set `tested_overlap_size / nominal_size`, e.g. Hallmark `REACTIVE_OXYGEN_SPECIES_PATHWAY` 46/49 members (93.9%), `NOTCH_SIGNALING` 29/32 (90.6%), `IL6_JAK_STAT3_SIGNALING` 75/87 (86.2%), `INFLAMMATORY_RESPONSE` 168/200 (84.0%); Reactome `Cytokine Signaling in Immune system` 379/852 (44.5%).

## Method Choices and Rationale

- **Ranking metric = DESeq2 Wald `stat`** (signed, magnitude-weighted), explicitly logged in every `*_summary.json` (`rank_metric: "stat"`), per the plan's pre-specified, disputed-methodology binding — reported explicitly because the choice materially affects which sets surface.
- **Full ranked list, not thresholded**: the 9,402-gene T1S2-tested set was used (excludes the further ~380 genes T1S2's independent filter dropped to NA `padj`), matching T1S2's own `n_genes_tested` figure.
- **Identifier space per T1S6's mapped gene table**: symbols substituted for genes T1S6 mapped via `org.Hs.eg.db`; placeholder IDs left untouched (cannot coincide with any real gene-set member). A second, Entrez-keyed ranked list (`output/ranked_genes_entrez.csv`) was built after inspection showed the staged WikiPathways GMT is Entrez-ID-keyed, not symbol-keyed as its catalog metadata claims (`output/decision_record_wikipathways.json`).
- **fgseaMultilevel**, `minSize=15`, `maxSize=500`, `eps=0`, seed 20260904, BH-adjusted p-values, `fgsea::collapsePathways()` (pval.threshold = 0.05) to reduce redundant significant sets to representative main pathways — full uncollapsed tables retained as supplement (`*_results.csv`).
- Versions (`output/session_info.txt`): R 4.6.0, fgsea 1.38.0, ggplot2 4.0.3, jsonlite 2.0.0.

## Quality Notes

- All three passes ranked the identical 9,402-gene, zero-duplicate list; only the identifier space and the GMT differed between passes.
- Size-window entry rates differ sharply by collection: 100% of Hallmark's 50 sets, but only 26.7% of Reactome's 2,868 sets and 39.5% of WikiPathways' 987 sets reached `minSize=15`, reflecting the dataset's placeholder-heavy identifier space.
- Leading-edge genes are reported for every tested pathway (not only the collapsed ones) in each `*_results.csv`'s `leading_edge` column; WikiPathways additionally carries a `leading_edge_symbol` column translating its Entrez IDs back to HGNC symbols.
- `output/enrichment_results.csv` concatenates all three collections' full fgsea tables (1,207 lines including header) with coverage attached; `output/significant_pathways_all_collections.csv` unions the three collections' collapsed main pathways (65 lines including header) with coverage attached.

## Limitations

- **Coverage caveat**: 63.80% of tested genes are synthetic placeholders, so every nominal gene-set size is an overstatement of what was actually tested; per-set coverage fractions are reported in `output/pathway_coverage_*.csv` rather than assumed uniform — Hallmark hits generally retain higher coverage (~72–94% per the examples read above) than Reactome/WikiPathways hits (as low as ~35–45% for some top hits shown above), so small low-coverage hits in the secondary collections warrant more skepticism.
- **Genes-tested definition is a judgment call**: excluding the ~380 independent-filtering-flagged genes (which do carry a valid `stat`) is a defensible but not unique choice.
- **Single ranking metric**: only `stat` was run; `signed_log10p` or `log2_fold_change` reruns were not performed, and results should be read as conditional on this metric choice per the disputed-methodology requirement.
- **Reactome "current" release has no fixed version string** (overwritten quarterly upstream); the extracted `output/refdata/ReactomePathways.gmt` is the only durable record of exact gene-set content used.
- **WikiPathways identifier-space mismatch** (Entrez, not symbol) required a manual, documented correction rather than trusting the reference-store catalog description at face value.
- **No organism confirmation** exists anywhere in the raw inputs; human annotation (`org.Hs.eg.db`) and human-only gene-set collections were used on the assumption carried from T1S6.
- Enrichment findings describe statistical association with the ranking, not proven pathway mechanism.