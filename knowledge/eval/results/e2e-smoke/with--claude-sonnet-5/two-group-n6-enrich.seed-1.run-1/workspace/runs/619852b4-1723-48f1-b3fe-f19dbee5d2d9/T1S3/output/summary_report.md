# Integrated DE + Pathway Enrichment Report — Treated vs Control

Consolidates T1S1 (QC/shallow-sample assessment), T1S2 (DESeq2 differential expression) and
T2S1 (Hallmark + Reactome preranked GSEA) into one reproducible summary. This step reruns
nothing; it re-sorts, re-tabulates, cross-references, and adds one new analysis (Hallmark
vs Reactome leading-edge overlap, `output/hallmark_reactome_overlap_*`) on top of upstream
outputs. All source files are cited by path.

## 1. Shallow-sample handling (from T1S1)

**Disposition: `sample_01` (control) was KEPT in the DESeq2 model.** This was a QC judgment
call, not a default — the reasoning, from `T1S1/output/qc_shallow_sample_verdict.md`:

- `sample_01`'s library size is 420,347 reads, 0.26x the cohort median (1,614,280) and the
  lowest of all 12 samples by a wide margin (next-lowest, `sample_02`, has 2.7x more reads).
  It still sits just above the template's formal low-depth flag threshold (< 0.25x median;
  `n_low_depth_samples = 0` in `T1S1/output/qc_summary.json`) — no sample was auto-flagged,
  but `sample_01` is unambiguously the cohort's depth outlier by rank and by gap size.
- Depth loss is moderate, not catastrophic: 10,918 of ~12,000 genes are still detected (91%),
  only ~6% below the ~11,610-gene median of the other 11 samples.
- On PCA (top-500-variable-gene, blind VST), PC1 (55.1% of variance) is the condition-separating
  axis with clean 6/6 separation and no overlap; `sample_01` scores PC1 = -18.37, squarely
  inside the control range. It is an outlier on PC2 (8.2% of variance, a minor axis: PC2 =
  +20.56 vs. -5.8 to -3.2 for the other 5 controls), interpreted as depth-driven technical
  noise, not a condition mislabel — consistent with its Euclidean VST distance being smaller
  to the other 5 controls (mean 95.4) than to the 6 treated samples (mean 104.0).
- DESeq2's own size-factor normalization already down-weights it: `sample_01`'s size factor is
  0.2835 (T1S2) / 0.2877 (T1S1's separate `~1`-design estimate) — the smallest in the cohort by
  a wide margin — which is exactly the mechanism raw-count negative-binomial modeling is built
  to handle for moderate depth heterogeneity.
- Power cost of exclusion is high for this design: n=6/arm is the entire replication budget;
  dropping to n=5 controls removes ~17% of the control arm to exclude a sample that clusters
  correctly by condition and does not cross the study's own low-depth threshold.

T1S1 explicitly proposed a leave-one-out sensitivity re-run (excluding `sample_01`) as an
**optional**, not required, due-diligence check; T1S2 did not perform it (noted in its own
Limitations). **This report does not run that sensitivity check either** — it is out of scope
for an assembly step — and states this as an open item rather than an implied validation.

## 2. Differential expression (from T1S2)

- **Method:** DESeq2 Wald test (`DESeq()` / `results()`), template `tpl-deseq2-two-group@1.0.0`
  (method `M-0001`), rendered from snapshot `sha256:90c687582244894c67c212e63855415984027bcd54c896821c4e065cf8b5467a`.
- **Design formula:** `~condition`, reference level `control` (set via `relevel()`).
- **Contrast:** `condition_treated_vs_control` ("condition: treated vs control").
- **Pre-filter:** genes with >=10 counts in >=6 samples (6 = smaller group size).
- **Thresholds:** `alpha = 0.05` (BH-adjusted padj), `lfcThreshold = 0`.
- **Shrinkage:** apeglm on the `condition_treated_vs_control` coefficient (ashr available, not
  used — no fallback occurred).
- **Package versions:** R 4.6.0, DESeq2 1.52.0, apeglm 1.34.0, ashr 2.2.63, ggplot2 4.0.3,
  pheatmap 1.0.13, jsonlite 2.0.0 — all `"exact"` matches to environment pins
  (`T1S2/output/decision_record.json`, confirmed in `T1S2/output/session_info.txt`).
- **Genes tested:** 12,000 input -> 9,782 genes passed the low-count filter -> 9,402 genes
  retained a non-NA `padj` after independent filtering (380 dropped by independent filtering,
  0 dropped as count outliers — automatic Cook's-distance replacement was off because the
  smallest group size, 6, is below `min_replicates_for_replace = 7`).
- **DE genes at padj < 0.05: 875** (513 up in treated, 362 down).
- P-value histogram is anti-conservative (spike near 0 on an otherwise flat, near-uniform
  background; bin [0,0.05] = 1,533 genes vs. 489.1 expected under a uniform null) — the shape
  that supports trusting the BH adjustment.

### 2.1 Gene table (ranked by shrunken log2FoldChange)

Full outputs of this step:

- `output/de_gene_table_full.csv` — **all 9,782 tested genes**, ranked descending by
  `log2_fold_change_shrunken_apeglm` (rank 1 = most up in treated, rank 9782 = most down),
  columns: `rank_by_shrunken_lfc, gene, base_mean, log2_fold_change_shrunken_apeglm,
  log2_fold_change_unshrunken, lfc_se_shrunken, stat, pvalue, padj_BH, na_reason`.
- `output/de_gene_table_significant.csv` — the 875-row padj<0.05 subset, same ranking and
  columns, re-ranked 1..875.
- `output/de_gene_table_summary.json` — counts and top-5 up/down gene lists.

Top 5 up and top 5 down by **shrunken** log2FoldChange among the 875 significant genes
(`output/de_gene_table_significant.csv`):

**Top 5 up** (most positive shrunken log2FC):

| gene | log2FC (shrunken, apeglm) | log2FC (unshrunken) | lfcSE | padj |
|---|---:|---:|---:|---:|
| IL15RA | 6.450 | 6.504 | 0.4225 | 3.93e-49 |
| GENE06568 | 3.735 | 4.042 | 0.8007 | 6.89e-06 |
| GENE07358 | 3.648 | 3.741 | 0.4227 | 1.01e-16 |
| GENE00040 | 3.630 | 3.669 | 0.2787 | 2.28e-36 |
| GENE07059 | 3.465 | 3.540 | 0.3572 | 1.95e-20 |

**Top 5 down** (most negative shrunken log2FC):

| gene | log2FC (shrunken, apeglm) | log2FC (unshrunken) | lfcSE | padj |
|---|---:|---:|---:|---:|
| UQCRC2 | -4.425 | -4.528 | 0.4836 | 2.29e-18 |
| GENE05017 | -3.040 | -3.095 | 0.2933 | 3.62e-23 |
| PRDX1 | -2.908 | -2.989 | 0.3530 | 3.90e-15 |
| GENE00133 | -2.892 | -3.037 | 0.4731 | 7.55e-09 |
| GENE05373 | -2.809 | -2.972 | 0.4990 | 7.02e-08 |

(Full ranked table, all 875 significant genes: `output/de_gene_table_significant.csv`; all
9,782 tested genes: `output/de_gene_table_full.csv`.)

**Identifier-quality caveat carried forward from T1S2/T2S1:** a large fraction of the 12,000
input identifiers are non-HGNC placeholder IDs (`GENE#####`), and several rank among the top
DE hits by both p-value and shrunken LFC (e.g. `GENE00040`, `GENE07358`, `GENE06568`)
alongside real symbols (`IL15RA`, `CDKN2B`). Statistics are computed correctly and
reproducibly on the data as given; no biological identity should be inferred for the
placeholder-ID genes.

## 3. Pathway enrichment — Hallmark and Reactome (from T2S1)

- **Method:** `fgsea::fgseaMultilevel()`, preranked, template `tpl-fgsea-preranked@1.0.0`
  (method `M-0010`), run separately per collection on the same ranked list.
- **Ranking metric:** DESeq2 Wald **`stat`** (not log2FC, not p-value) — the signed statistic
  combining effect size and its precision; template default.
- **Ranked gene universe:** all 9,782 genes that passed the T1S2 low-count filter and have a
  finite Wald `stat` — **not** restricted to the padj-non-NA or significant subset. This is the
  same universe for both collections.
- **Set-size window:** `min_size = 15`, `max_size = 500` (sets outside this window are excluded
  from testing).
- **Seed:** 42 (both collections). **`eps = 0`** (template default, not adaptable).
- **Package versions:** R 4.6.0, fgsea 1.38.0, ggplot2 4.0.3, jsonlite 2.0.0 (all `"exact"`
  matches; `T2S1/output/session_info.txt`, `decision_record.json`).
- **Redundancy reduction:** `collapsePathways()` applied per collection to fold near-redundant
  significant sets into non-redundant "representative" sets; full uncollapsed significant
  tables are retained as supplement.

Outputs of this step (metadata columns — `database`, `ranking_metric`, `gene_universe_size`,
`min_set_size`, `max_set_size`, `n_sets_input`, `n_sets_tested` — attached to every row):

- `output/pathway_table_hallmark.csv` — all 50 tested Hallmark sets, padj-sorted, with
  `is_representative` flag and leading-edge gene list per set.
- `output/pathway_table_reactome.csv` — all 787 tested Reactome sets (of 2,868 input; the
  rest fell outside the 15–500 size window), padj-sorted, same treatment.
- `output/pathway_table_combined_significant.csv` — padj<0.05 rows from both collections,
  stacked (not merged/rescaled — see caveat below).
- `output/pathway_table_summary.json` — the counts below, machine-readable.

### 3.1 Hallmark (MSigDB Hallmark human, **release 2026.1**, `h.all.v2026.1.Hs.symbols.gmt`)

50 sets input, 50 tested (all inside the 15–500 window), 3,541 of 9,782 ranked genes are
members of >=1 tested set. **17 significant at padj<0.05** (15 up, 2 down), collapsed to
**11 representative** pathways.

| pathway (representative) | NES | padj | leading-edge genes |
|---|---:|---:|---:|
| HALLMARK_TNFA_SIGNALING_VIA_NFKB | 2.963 | 3.32e-32 | 95 |
| HALLMARK_OXIDATIVE_PHOSPHORYLATION | -3.079 | 9.06e-29 | 85 |
| HALLMARK_INTERFERON_GAMMA_RESPONSE | 2.787 | 2.31e-25 | 96 |
| HALLMARK_INFLAMMATORY_RESPONSE | 2.096 | 4.39e-08 | 46 |
| HALLMARK_P53_PATHWAY | 1.803 | 8.59e-05 | 44 |
| HALLMARK_ADIPOGENESIS | -1.722 | 4.07e-04 | 45 |
| HALLMARK_COMPLEMENT | 1.603 | 2.89e-03 | 46 |
| HALLMARK_KRAS_SIGNALING_UP | 1.509 | 0.0102 | 29 |
| HALLMARK_UNFOLDED_PROTEIN_RESPONSE | 1.467 | 0.0356 | 31 |
| HALLMARK_IL2_STAT5_SIGNALING | 1.432 | 0.0261 | 48 |
| HALLMARK_APICAL_SURFACE | 1.555 | 0.0388 | 15 |

Full 17-row (uncollapsed) significant table: `output/pathway_table_hallmark.csv` filtered to
`padj<0.05`, or `T2S1/output/hallmark_results.csv`.

### 3.2 Reactome (release **"current"**, host-provisioned snapshot, human-filtered)

Source GMT held 2,868 pathway lines, all already `R-HSA-*` (human) stable IDs — the explicit
species filter (`T2S1/output/reactome_gmt_prep_summary.json`) dropped 0 pathways. 787 of 2,868
sets fell inside the 15–500 size window and were tested; 2,966 of 9,782 ranked genes are
members of >=1 tested set. **106 significant at padj<0.05** (99 up, 7 down), collapsed to
**25 representative** pathways.

| pathway (representative, top 12 by padj) | NES | padj | leading-edge genes |
|---|---:|---:|---:|
| Cytokine Signaling in Immune system | 2.216 | 3.99e-15 | 112 |
| Aerobic respiration and respiratory electron transport | -2.588 | 2.01e-12 | 48 |
| Signaling by Interleukins | 2.253 | 1.91e-11 | 78 |
| Mitochondrial protein degradation | -2.416 | 3.18e-07 | 21 |
| Interleukin-1 family signaling | 2.325 | 3.20e-07 | 23 |
| Toll Like Receptor 3 (TLR3) Cascade | 2.270 | 4.04e-06 | 23 |
| Mitochondrial protein import | -2.347 | 6.75e-06 | 12 |
| Innate Immune System | 1.723 | 1.96e-05 | 92 |
| Cytosolic sensors of pathogen-associated DNA | 2.235 | 2.30e-05 | 12 |
| NLR signaling pathways | 2.152 | 5.62e-05 | 12 |
| Senescence-Associated Secretory Phenotype (SASP) | 2.119 | 1.70e-04 | 12 |
| Cell recruitment (pro-inflammatory response) | 2.085 | 2.07e-04 | 8 |

Full 25-row representative table and 106-row uncollapsed significant table:
`output/pathway_table_reactome.csv` (filter `is_representative` / `padj<0.05`), or
`T2S1/output/reactome_collapsed.csv` / `reactome_results.csv`.

### 3.3 KEGG

Not run. Its license forbids redistribution and it is not staged in this environment;
Reactome served as the second collection (T2S1 decision).

## 4. Hallmark vs Reactome: quantified overlap (new analysis, this step)

T2S1's summary asserted the two collections "agree statistically" by direction; this step
tests that claim directly rather than restating it. `scripts/03_hallmark_reactome_overlap.py`
computed, for every pair of representative significant pathways (11 Hallmark x 25 Reactome =
275 pairs), the Jaccard index of their leading-edge gene sets and whether their NES signs
agree. Outputs: `output/hallmark_reactome_overlap_pairs.csv` (all 275 pairs),
`output/hallmark_reactome_overlap_summary.json`, `figures/hallmark_reactome_overlap_heatmap.{png,pdf}`.

**Result:**

- 147 of 275 pairs (53%) share at least one leading-edge gene.
- **Of those 147 overlapping pairs, 100% have concordant NES sign** — no pair where one
  collection calls a pathway up and the matched pathway in the other collection calls it down.
- Strongest pairs by Jaccard index:
  - `HALLMARK_OXIDATIVE_PHOSPHORYLATION` <-> Reactome `Aerobic respiration and respiratory
    electron transport`: Jaccard 0.563, 49 shared leading-edge genes, both down (NES -3.08 /
    -2.59).
  - `HALLMARK_INTERFERON_GAMMA_RESPONSE` <-> Reactome `Cytokine Signaling in Immune system`:
    Jaccard 0.305, 51 shared genes, both up (NES 2.79 / 2.22).
  - `HALLMARK_OXIDATIVE_PHOSPHORYLATION` <-> Reactome `Mitochondrial protein degradation`:
    Jaccard 0.213, 19 shared genes, both down.
  - `HALLMARK_TNFA_SIGNALING_VIA_NFKB` <-> Reactome `Signaling by Interleukins`: Jaccard 0.199,
    29 shared genes, both up.
- At the whole-collection level: the union of all Hallmark representative leading-edge genes
  (437 genes) and the union of all Reactome representative leading-edge genes (433 genes)
  overlap by 251 genes (union-level Jaccard 0.406).

**Interpretation:** the two independently-run collections converge on the same two themes —
inflammatory/cytokine/interferon/NF-kB signaling up in treated, oxidative-phosphorylation and
mitochondrial-protein-handling pathways down — with full directional concordance wherever
their gene memberships overlap. This is a statistical concordance between two annotation
databases fed the same ranked list, not independent biological replication (both draw from
the same DESeq2 `stat` ranking and the same 12-sample experiment).

**Domain context (literature grounding, not dataset-specific validation):** a shift where
pro-inflammatory / NF-kB / interferon signaling rises together with a suppression of oxidative
phosphorylation and mitochondrial gene programs is a well-described immunometabolic pattern in
activated immune cells (e.g., Mouton et al., *Circ Res* 2020, PMID 32163341, review of
macrophage immunometabolism). This is reported as **expected**, domain-consistent shape of the
signature — not as confirmation of this specific treatment, cell type, or organism, which
remain unconfirmed by any input metadata (see Sec. 5 caveats). A PubMed search for the
combination "TNF/NF-kB + interferon-gamma up, oxidative phosphorylation down" as a named
transcriptomic signature returned no directly matching study (searched, not found — reported
as a plausible but unconfirmed match to a general pattern, not a specific citation).

## 5. Caveats

- **Enrichment-method dependence.** All pathway results here come from one method (preranked
  `fgseaMultilevel`) on one ranking metric (DESeq2 Wald `stat`) with one set-size window
  (15–500). Ranking by log2FoldChange, by signed -log10(p), or running an
  over-representation test (ORA) on the padj<0.05 gene list instead of preranked GSEA on the
  full list would very likely shift which sets clear padj<0.05 and how they collapse into
  representative sets — GSEA significance is sensitive to the ranking statistic and to
  `min_size`/`max_size`, and no alternative ranking or method was run to check this. Treat the
  specific set list, not just the two broad themes, as method-conditional.
- **Gene identifier quality.** 63.8% of the 9,782 tested gene symbols do not resolve to an
  `org.Hs.eg.db` (v3.23.1) Entrez ID; 6,241 of the 6,244 unmapped symbols match the dataset's
  non-HGNC `GENE#####` placeholder pattern. This tracks almost exactly with genes absent from
  any Hallmark set (9,782-3,541=6,241) or Reactome set (9,782-2,966=6,816): placeholder IDs
  simply do not appear in curated pathway databases, so enrichment ran on genes with real
  symbols. Downstream: no biological identity for the placeholder-ID DE genes (several of them
  top hits by LFC), and no organism confirmation exists in the input data beyond the all-caps
  HGNC-style symbols that are present — human identity is assumed, not verified.
  Fold-change shrinkage was successfully computed as apeglm did not fail; ashr was available
  but unused (no fallback triggered).
- **No independent biological replication of the pathway signal.** Hallmark and Reactome are
  two annotation databases queried against the same ranked gene list from the same 12-sample
  experiment; their agreement (Sec. 4) is expected redundancy between curated pathway
  resources with overlapping gene membership, not two independent experiments.
- **Sensitivity to `sample_01` not directly tested at this step or at T1S2.** The QC
  recommendation to keep it (Sec. 1) rests on PCA/clustering/size-factor reasoning, not on a
  leave-one-out DE re-run; that re-run remains an open, optional item.
- **No batch, timepoint, or pairing structure** exists in the metadata (T1S1/T1S2), so
  `~condition` is the only supportable design; no adjustment for unmodeled structure was
  possible at any step in this pipeline.

## 6. Reproducibility record

Full package pins, environment-match status (`"exact"` for every pinned package across all
three upstream steps), per-step decision-record slots, random seeds, database versions, and
the raw R `sessionInfo()` text for T1S1/T1S2/T2S1 are in:

- `output/reproducibility_record.md` (human-readable)
- `output/reproducibility_record.json` (machine-readable)

Summary of the pins that matter for these results:

| step | key packages | versions | env match |
|---|---|---|---|
| T1S1 QC/EDA | DESeq2, ggplot2, pheatmap, jsonlite | 1.52.0, 4.0.3, 1.0.13, 2.0.0 | exact |
| T1S2 DESeq2 DE | DESeq2, apeglm, ashr, ggplot2, pheatmap, jsonlite | 1.52.0, 1.34.0, 2.2-63, 4.0.3, 1.0.13, 2.0.0 | exact |
| T2S1 fgsea (both collections) | fgsea, ggplot2, jsonlite | 1.38.0, 4.0.3, 2.0.0 | exact |
| T2S1 gene-ID mapping | org.Hs.eg.db | 3.23.1 | (reporting/QC only, not an enrichment input) |

R 4.6.0 (aarch64-unknown-linux-gnu, Ubuntu 24.04.4 LTS) throughout. GSEA random seed = 42
(both Hallmark and Reactome runs). DESeq2's Wald test and apeglm shrinkage are deterministic
given the fixed count matrix and design — no seed applies there.

Gene-set database versions: **MSigDB Hallmark human 2026.1** (`h.all.v2026.1.Hs.symbols.gmt`);
**Reactome, release "current"** (host-provisioned snapshot — Reactome overwrites this quarterly,
so this label is not a fixed version number; the snapshot's `ReactomePathways.gmt` /
`ReactomePathways.txt` pair was used as-is with 2,868 pathways, 0 dropped by the human-species
filter).

## 7. File index (this step's outputs)

| file | contents |
|---|---|
| `output/de_gene_table_full.csv` | all 9,782 tested genes, ranked by shrunken log2FC |
| `output/de_gene_table_significant.csv` | 875 padj<0.05 genes, same ranking |
| `output/de_gene_table_summary.json` | DE counts/thresholds |
| `output/pathway_table_hallmark.csv` | 50 tested Hallmark sets + metadata columns |
| `output/pathway_table_reactome.csv` | 787 tested Reactome sets + metadata columns |
| `output/pathway_table_combined_significant.csv` | padj<0.05 rows, both collections stacked |
| `output/pathway_table_summary.json` | pathway counts/thresholds/database versions |
| `output/hallmark_reactome_overlap_pairs.csv` | 275 pathway-pair Jaccard/NES-concordance table |
| `output/hallmark_reactome_overlap_summary.json` | overlap aggregate stats |
| `figures/hallmark_reactome_overlap_heatmap.{png,pdf}` | Jaccard heatmap, Hallmark x Reactome |
| `output/reproducibility_record.{md,json}` | full package/version/seed/session-info record |

Upstream figures referenced but not reproduced here: DESeq2 PCA, MA, dispersion, volcano,
p-value histogram, sample-distance heatmap (`T1S2/figures/`, `T1S1/figures/`); Hallmark/Reactome
dot/bar/network/upset plots (`T2S1/figures/`).
