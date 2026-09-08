# Hallmark + Reactome Preranked GSEA — Treated vs Control

## What was run

Two-collection, preranked `fgsea::fgseaMultilevel()` gene set enrichment on the full DESeq2 `condition_treated_vs_control` results table (`T1S2/output/deseq2_results.csv`), rendered from `tpl-fgsea-preranked@1.0.0` twice — once per gene-set collection — plus a preceding gene-ID mapping report and a following cross-collection combine/plot step.

- **Ranking metric:** DESeq2 Wald `stat`, explicitly (per `output/hallmark_summary.json` and `output/reactome_summary.json`, `"rank_metric": "stat"`).
- **Ranked list:** no p-value/padj/fold-change pre-threshold — both summary JSONs report `"n_genes_input": 9782`, `"n_genes_ranked": 9782"` — every gene with a finite Wald statistic went into the ranking, not just the subset with a non-NA adjusted p-value.
- **Algorithm parameters (both collections, from the same two JSONs):** `"min_size": 15`, `"max_size": 500`, `"eps": 0`, `"seed": 42`.
- **Environment:** R 4.6.0, fgsea 1.38.0, ggplot2 4.0.3 (`output/session_info.txt`).

## Gene identifier mapping (org.Hs.eg.db)

Per `output/gene_id_mapping_summary.json`:

- `"n_genes_tested": 9782"`, `"n_unique_symbols_tested": 9782"`
- `"n_mapped_unique_symbols": 3538"`, `"n_unmapped_unique_symbols": 6244"`
- `"fraction_mapped": 0.3617"` (36.2%), `"fraction_unmapped": 0.6383"` (63.8%)
- `"n_unmapped_placeholder_gene_ids": 6241"` of the 6,244 unmapped symbols match the dataset's non-HGNC `GENE#####` placeholder pattern; only 3 unmapped symbols are anything else
- Mapping source: `org.Hs.eg.db` version 3.23.1, `keytype = "SYMBOL"` → `target = "ENTREZID"`
- Per the file's own `note` field: this mapping is a reporting/QC step on identifier quality, not an input to the enrichment test itself — both GMT collections are symbol-keyed, so fgsea ranks and tests directly on gene symbols.

## Reactome human-species filter

Per `output/reactome_gmt_prep_summary.json`:

- Source GMT held `"n_pathways_raw_gmt": 2868"` pathway lines; the *Homo sapiens* index (`ReactomePathways.txt`) held `"n_pathways_human_index": 2883"` entries.
- After joining pathway stable IDs against the species index: `"n_pathways_kept": 2868"`, `"n_pathways_dropped": 0"` — the raw GMT distributed by the reference store was already 100% human (all `R-HSA-*` stable IDs); the explicit filter step changed nothing but was still run as specified, writing `output/reactome_pathways_human.gmt`.

## Hallmark GSEA results (MSigDB Hallmark human, 2026.1)

From `output/hallmark_summary.json`:

- `"n_sets_input": 50"`, `"n_sets_tested": 50"` (all 50 sets fell inside the 15–500 window)
- `"n_genes_in_sets": 3541"` of 9,782 ranked genes are members of at least one Hallmark set
- `"n_significant": 17"` sets at padj < 0.05 (`"n_up": 15"`, `"n_down": 2"`)
- Collapsed to `"n_main_pathways": 11"` non-redundant representative pathways

Representative pathways, from `output/hallmark_collapsed.csv` (NES, padj, leading-edge gene count = number of `;`-separated genes in the file):

| pathway | NES | padj | leading-edge genes | folded (redundant) sets |
|---|---:|---:|---:|---|
| HALLMARK_TNFA_SIGNALING_VIA_NFKB | 2.963 | 3.32e-32 | 95 | HALLMARK_APOPTOSIS; HALLMARK_UV_RESPONSE_UP; HALLMARK_HYPOXIA |
| HALLMARK_OXIDATIVE_PHOSPHORYLATION | −3.079 | 9.06e-29 | 85 | (none) |
| HALLMARK_INTERFERON_GAMMA_RESPONSE | 2.787 | 2.31e-25 | 96 | HALLMARK_INTERFERON_ALPHA_RESPONSE; HALLMARK_ALLOGRAFT_REJECTION; HALLMARK_IL6_JAK_STAT3_SIGNALING |
| HALLMARK_INFLAMMATORY_RESPONSE | 2.096 | 4.39e-08 | 46 | (none) |
| HALLMARK_P53_PATHWAY | 1.803 | 8.59e-05 | 44 | (none) |
| HALLMARK_ADIPOGENESIS | −1.722 | 4.07e-04 | 45 | (none) |
| HALLMARK_COMPLEMENT | 1.603 | 2.89e-03 | 46 | (none) |
| HALLMARK_KRAS_SIGNALING_UP | 1.509 | 0.0102 | 29 | (none) |
| HALLMARK_IL2_STAT5_SIGNALING | 1.432 | 0.0261 | 48 | (none) |
| HALLMARK_UNFOLDED_PROTEIN_RESPONSE | 1.467 | 0.0356 | 31 | (none) |
| HALLMARK_APICAL_SURFACE | 1.555 | 0.0388 | 15 | (none) |

The full 17-row table (including the 6 non-representative significant sets folded above) is in `output/hallmark_results.csv`; each carries its own NES/padj/leading-edge.

## Reactome GSEA results (release "current", human-filtered)

From `output/reactome_summary.json`:

- `"n_sets_input": 2868"`, `"n_sets_tested": 787"` (787 sets fell inside the 15–500 window)
- `"n_genes_in_sets": 2966"` of 9,782 ranked genes are members of at least one tested Reactome pathway
- `"n_significant": 106"` sets at padj < 0.05 (`"n_up": 99"`, `"n_down": 7"`)
- Collapsed to `"n_main_pathways": 25"` representative pathways

Top representative hits, from `output/reactome_collapsed.csv`:

| pathway | NES | padj | leading-edge genes |
|---|---:|---:|---:|
| Cytokine Signaling in Immune system | 2.216 | 3.99e-15 | 112 |
| Aerobic respiration and respiratory electron transport | −2.588 | 2.01e-12 | 48 |
| Signaling by Interleukins | 2.253 | 1.91e-11 | 78 |
| Mitochondrial protein degradation | −2.416 | 3.18e-07 | 21 |
| Interleukin-1 family signaling | 2.325 | 3.20e-07 | 23 |
| Toll Like Receptor 3 (TLR3) Cascade | 2.270 | 4.04e-06 | 23 |
| Mitochondrial protein import | −2.347 | 6.75e-06 | 12 |
| Innate Immune System | 1.723 | 1.96e-05 | 92 |
| Cytosolic sensors of pathogen-associated DNA | 2.235 | 2.30e-05 | 12 |
| NLR signaling pathways | 2.152 | 5.62e-05 | 12 |
| Senescence-Associated Secretory Phenotype (SASP) | 2.119 | 1.70e-04 | 12 |
| Cell recruitment (pro-inflammatory response) | 2.085 | 2.07e-04 | 8 |

The remaining 13 representative pathways are in the same file; the full 106-row significant table is in `output/reactome_results.csv`.

## Combined / cross-collection artifacts

- `output/enrichment_results.csv` stacks both collections' full tested-set tables (columns: `collection, release, pathway, pvalue, padj, ES, NES, size, leading_edge, is_representative`) without merging their statistics.
- `output/significant_leading_edge.csv` holds every padj < 0.05 row from both collections with its leading-edge gene list and `is_representative` flag; confirmed by reading the file's tail, its last rows include Reactome "G1 Phase" (padj 0.0488, NES 1.700) and "SARS-CoV-2 activates/modulates innate and adaptive immune responses" (padj 0.0496, NES 1.633) — both non-representative (folded) entries near the significance boundary.
- Figures: `figures/hallmark_dot_plot.{png,pdf}`, `figures/hallmark_nes_bar_plot.{png,pdf}`, `figures/reactome_dot_plot.{png,pdf}`, `figures/reactome_nes_bar_plot.{png,pdf}` (per-collection, template default); `figures/enrichment_dotplot.{png,pdf}` (top 20 across both collections by padj), `figures/enrichment_barplot.{png,pdf}` (all representative significant sets, faceted by collection), `figures/enrichment_network.{png,pdf}` (top 6 representative significant pathways per collection linked to leading-edge genes), `figures/enrichment_upset.{png,pdf}` (leading-edge gene overlap across those same top pathways).
- `output/decision_record.json` and `output/decision_record_reactome.json` (identical copies) hold the last (Reactome) template render's slot values, environment pins (all `"status": "exact"`), and citations; the Hallmark render used the same template/version/pins, differing only in `gmt_path` and `output_prefix`, as recorded in `scripts/fgsea_hallmark.R`.

## Method rationale

- Wald `stat` was used as the ranking metric rather than log2FC or p-value because it combines effect size and its estimated precision into a single signed statistic, and is the grounded default for this template.
- The full unthresholded gene list (9,782 genes, not the smaller padj-non-NA subset) was ranked because GSEA's power comes from using the whole distribution, not a pre-filtered tail.
- `collapsePathways()` was applied per collection to fold near-redundant significant sets into representative ones, keeping the full uncollapsed table as supplement, per standard fgsea redundancy-reduction practice for gene set collections with correlated membership (Hallmark's TNFA/inflammatory/hypoxia sets and Reactome's immune-signaling hierarchy both show this).
- Reactome was run as a second, separately-reported collection (not merged with Hallmark) because the two use different set granularities and set counts, so their p-value/NES scales are not directly comparable.

## Quality notes and caveats

- 63.8% of the 9,782 tested gene symbols are not resolvable HGNC symbols via org.Hs.eg.db (`output/gene_id_mapping_summary.json`), and 6,241 of those 6,244 unmapped symbols match a `GENE#####` placeholder pattern rather than being real gene names. This tracks closely with the fraction of ranked genes absent from any Hallmark set (9,782 − 3,541 = 6,241 genes in no Hallmark set) and any Reactome set (9,782 − 2,966 = 6,816 in no Reactome set): placeholder identifiers simply do not appear in curated pathway databases.
- The raw Reactome `.gmt` file supplied by the reference store is a zip archive despite its `.gmt` extension; it was unzipped before use (documented in `output/reactome_gmt_prep_summary.json`'s source path and the accompanying script).
- KEGG was not run — its license forbids redistribution and it is not staged in this environment; Reactome served as the second collection instead.

## Limitations

- Given the gene-ID mapping result, roughly two-thirds of the tested gene universe cannot be confirmed as real HGNC gene symbols, which limits confidence in the biological (as opposed to statistical) interpretation of any individual leading-edge gene not independently recognized.
- The concordant direction of Hallmark and Reactome results (inflammatory/interferon/NF-κB-related sets up, oxidative-phosphorylation/mitochondrial sets down) shows the two collections agree statistically, but this is not validation of a specific biological mechanism, treatment identity, tissue, or organism — none of that context exists in the persisted output files for this step.
- `output/decision_record.json` reflects only the second (Reactome) template render's parameters; the Hallmark render's exact parameters must be read from `scripts/fgsea_hallmark.R` rather than from the decision record.