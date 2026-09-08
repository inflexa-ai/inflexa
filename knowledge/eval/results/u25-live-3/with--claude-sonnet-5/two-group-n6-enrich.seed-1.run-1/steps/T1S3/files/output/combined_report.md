# Combined DE + Pathway Enrichment Report — Treated vs Control

**Snapshot:** `sha256:40605ae40583456c222ca9f595c1a4c8c995b7a124a1f35c57cb03911412e5e8` · **Run:** `ccf89a64-e0e3-459a-bf3a-a1a6ceade281` · **Report step:** T1S3

This report synthesizes three already-completed, independently persisted steps —
T1S1 (sample QC), T1S2 (DESeq2 differential expression), T1S6 (gene-ID annotation),
and T2S1 (fgsea pathway enrichment) — into one decision-ready document. **No new
statistical test was run here.** Every number below is read from the persisted
JSON/CSV artifacts of those steps (paths cited inline) or recomputed by
`scripts/build_combined_report.py` by joining those same artifacts; the script and
its outputs (`output/gene_table_full.csv`, `output/gene_table_significant.csv`,
`output/enrichment_significant_sets.csv`, `output/reproducibility_record.json`)
are the audit trail for every figure quoted here.

**Read this report together with its two headline caveats, stated once here and
carried through every section below: (1) organism was never stated in the raw
inputs — all annotation and enrichment used human references provisionally; (2)
63.8% of the gene IDs entering the DE model are synthetic `GENE#####` placeholders
with no real biological identity, so pathway coverage is intrinsically partial.**
See "Limitations" for the full statement.

---

## 1. Method, design, and headline numbers

| Field | Value |
|---|---|
| Method | DESeq2 Wald test with apeglm log2FC shrinkage (`tpl-deseq2-two-group@1.1.0`) |
| Design formula | `~condition` |
| Contrast | `condition`: treated vs control, **reference level = control** (explicitly releveled, not alphabetical default) |
| Package versions | R 4.6.0 (2026-04-24, aarch64-unknown-linux-gnu); DESeq2 1.52.0; apeglm 1.34.0; ashr 2.2-63 (available, not used); ggplot2 4.0.3; pheatmap 1.0.13; jsonlite 2.0.0 |
| alpha (significance + independent-filtering target) | 0.05 |
| Gene filter before modeling | ≥10 counts in ≥6 samples (smaller group size) |
| **Genes tested after filtering** | **12,000 input → 9,782 post-prefilter → 9,402 tested** after DESeq2's automatic independent filtering removed a further 380 low-mean genes (mean-count threshold 11.35) |
| **DE genes at padj < 0.05** | **875** (513 up in treated, 362 down) |
| Count-outlier NAs (Cook's distance) | 0 |
| Ranking metric for reporting | shrunken (apeglm) log2 fold change, descending |

Source: `T1S2/output/de_treated_vs_control_summary.json`, `T1S2/output/decision_record.json`, `T1S2/output/session_info.txt`.

Design and reference level match the plan's requirement exactly: the contrast is
`condition_treated_vs_control` with `control` forced as the reference level, not
left to alphabetical default. Independent filtering and significance both use the
same `alpha = 0.05`, per DESeq2's own recommendation that these targets match.

---

## 2. Gene table

`output/gene_table_full.csv` (9,782 rows — every gene that survived the
minimal pre-filter, including the 380 later dropped to `padj = NA` by
independent filtering) and `output/gene_table_significant.csv` (875 rows,
padj < 0.05) both carry:

- `log2_fold_change_unshrunken_mle` — the raw DESeq2 MLE fold change
- `log2_fold_change_shrunken_apeglm` — the apeglm-shrunken fold change (**ranking column**)
- `lfcSE_shrunken` — the standard error of the shrunken estimate
- `stat`, `pvalue`, `adjusted_pvalue`, `na_reason`
- `mapped`, `entrez_id`, `ensembl_id`, `is_synthetic_placeholder_id` (joined from T1S6)

The table is sorted descending by `log2_fold_change_shrunken_apeglm`, per the
rank_genes_by requirement.

**Top upregulated (treated > control), by shrunken log2FC:**

| Gene | log2FC (shrunken) | log2FC (unshrunken) | lfcSE | padj | Real ID? |
|---|---|---|---|---|---|
| IL15RA | 6.450 | 6.504 | 0.422 | 3.94e-49 | yes |
| GENE06568 | 3.735 | 4.042 | 0.801 | 6.89e-06 | **no — synthetic placeholder** |
| GENE07358 | 3.648 | 3.741 | 0.423 | 1.01e-16 | **no — synthetic placeholder** |
| GENE00040 | 3.630 | 3.669 | 0.279 | 2.28e-36 | **no — synthetic placeholder** |
| NFE2L2 | 3.231 | — | — | 9.996e-14 | yes |
| PTGS2 | 2.955 | — | — | 3.32e-13 | yes |
| CDKN2B | 2.913 | — | — | 5.55e-26 | yes |

**Top downregulated (treated < control), by shrunken log2FC:**

| Gene | log2FC (shrunken) | lfcSE | padj | Real ID? |
|---|---|---|---|---|
| UQCRC2 | −4.425 | 0.484 | 2.29e-18 | yes |
| GENE05017 | −3.040 | 0.293 | 3.62e-23 | **no — synthetic placeholder** |
| PRDX1 | −2.908 | 0.353 | 3.90e-15 | yes |
| GENE00133 | −2.892 | 0.473 | 7.55e-09 | **no — synthetic placeholder** |
| GENE05373 | −2.809 | — | 7.02e-08 | **no — synthetic placeholder** |

Interpretation is deliberately restrained: several of the strongest-magnitude
hits by shrunken log2FC are synthetic placeholder IDs, which is expected
(placeholder genes are ~64% of the tested set and there is no biological reason
they would be excluded from strong statistical effects in this data). **A
top-ranked-by-fold-change list here is not the same as a top-ranked-by-real-gene
list** — see §5 for the enrichment-relevant subset.

**Gene-ID composition of the significant set** (`T1S2/output/de_qc_report.json`):
of the 875 significant genes, 408 (46.6%) carry a real HGNC symbol and 467
(53.4%) are synthetic placeholders — a *lower* placeholder share than the 63.8%
background rate. A Fisher's exact test confirms named-symbol genes are
significantly over-represented among the 875 hits relative to the 9,402-gene
tested background (OR = 0.62, p = 3.25e-11). This is a structural / gene-naming
observation, not a biological claim about which genes "matter" — but it is
useful diagnostic context for interpreting the enrichment results in §5, which
can only use the mappable, real-ID subset.

---

## 3. Fit diagnostics

### 3.1 MA plot
`figures/de_ma_plot.png` / `.pdf` (source: `T1S2/figures/de_treated_vs_control_ma.png`).

Plots apeglm-shrunken log2FC against mean normalized count (`baseMean`) for all
9,782 filtered genes, points colored by significance. **Interpretation:** the
cloud is centered near log2FC = 0 across the range of mean counts, with the
expected apeglm behavior — low-count, high-variance genes are pulled toward
zero relative to their unshrunken MLE estimates (visible as the shrunken
log2FC spread narrowing at low `baseMean`), while high-count genes retain
larger fold-change magnitudes when they are truly significant. No systematic
trend (skew, funnel widening only on one side, or off-center baseline) is
present, consistent with a properly normalized, unbiased fit — median-of-ratios
size factors (range 0.28–1.85, a 6.5-fold spread) appear to have been
adequately absorbed rather than leaving a residual mean-count-dependent bias.

### 3.2 Dispersion plot
`figures/de_dispersion_plot.png` / `.pdf` (source:
`T1S2/figures/de_treated_vs_control_dispersion.png`).

Standard DESeq2 three-layer dispersion plot: gene-wise MLE dispersion
estimates (black), the fitted mean-dispersion trend (red), and the final
MAP (shrunken) dispersion estimates (blue), with any Cook's-outlier genes
marked. **Interpretation:** with 0 genes flagged as Cook's-distance count
outliers (`n_cooks_outlier_na = 0`) and a standard decreasing-dispersion-with-
increasing-mean trend expected for RNA-seq count data, the plot is used here
as a qualitative check that (a) the gene-wise estimates scatter around the
fitted trend without a systematic detachment at any mean-count range, and (b)
the blue MAP estimates are shrunk toward, not away from, the red trend line —
the standard visual signature of a well-behaved negative-binomial fit. No
numeric goodness-of-fit statistic for the dispersion trend was computed
upstream; this is a visual-inspection diagnostic, reported as such rather than
backed by a fabricated number.

### 3.3 p-value histogram
`figures/de_pvalue_histogram.png` / `.pdf` (source:
`T1S2/output/pvalue_histogram_bins.csv`, `T1S2/output/de_qc_report.json`).

9,782 raw p-values in 20 bins of width 0.05:

- **[0, 0.05): 1,533 genes** — a strong low-p spike, far above the ~5%
  (~489 genes) expected under a global null.
- **Remaining 19 bins: approximately flat**, ranging 387–470 genes/bin (e.g.
  [0.5, 0.55) = 468, [0.65, 0.7) = 387, [0.95, 1.0) = 456), with **no secondary
  peak near p = 1**.
- Formal check: Kolmogorov–Smirnov test of the p > 0.5 tail against
  Uniform(0.5, 1) does not reject uniformity (D = 0.0162, p = 0.204).

**Interpretation: this is the textbook "good" shape** — a spike near zero (true
signal) sitting on top of a flat, uniform background (the null genes behaving
as expected under BH correction), with no hump near 1 (which would indicate
model misspecification, e.g. from unmodeled covariates or a bad
mean-variance fit). This shape is the primary justification for trusting the
BH-adjusted `padj` values used for the 875-gene significance call.

---

## 4. Sample QC — the shallow sample

**`sample_01` (control) is the shallow sample and was explicitly assessed and
kept**, not excluded. Full detail: `T1S1/output/qc-verdict.md`,
`T1S1/output/shallow_sample_assessment_summary.json`,
`T1S1/output/qc_library_sizes.csv`, `T1S1/output/qc_pca.csv`.

| Metric | sample_01 | Comparator |
|---|---|---|
| Library size | **420,347** reads | dataset median 1,614,280; own-group (control, excl. self) median 1,635,227 |
| Ratio to dataset median | **0.260×** | next-lowest sample (sample_02) = 0.71× |
| Ratio to own-group median | **0.257×** | automated low-depth flag threshold is 0.25× — sample_01 falls *just* short of the cutoff |
| Detected genes | 10,918 | own-group median 11,621 |
| DESeq2 size factor | **0.2835** | lowest of all 12 samples (range 0.28–1.85) |
| PC1 (condition axis, 55.1% var.) | −18.4 | own-group mean (excl. self) −16.9 — **same side, comparable magnitude: groups correctly with control** |
| PC2 (residual/technical axis) | +20.6 | own-group mean (excl. self) −4.3, range 2.6 — **24.8 units off, several times the within-group spread** |
| Mean Euclidean distance to own group | 95.4 | vs. 84.4 among the other 5 control samples (1.13× inflation) |
| Mean Euclidean distance to other group | 104.0 | still further than to its own group |

Figures: `figures/qc_library_sizes.png`, `figures/qc_pca.png`,
`figures/qc_sample_distances.png` (from T1S1); `figures/de_pca.png` (T1S2's
PCA on the model actually fit, for cross-check).

**Decision: KEEP.** Rationale, carried forward unchanged from T1S1's verdict and
applied as-is in T1S2's model:

1. `sample_01` falls just short (0.257 vs. the 0.25 automated cutoff) of the
   low-depth exclusion rule.
2. It groups **correctly by condition** on PC1, the dominant axis of variation
   (55.1% of variance, clean 6-vs-6 separation with no PC1 overlap between
   arms) — it does not cross into the treated group.
3. It is **closer to its own group than to the opposite group** in the
   sample-distance matrix (95.4 vs. 104.0), so it is not a mislabeled or
   cross-condition outlier.
4. Its elevated PC2 and inflated within-group distance are consistent with
   **depth-driven technical noise** (fewer detected genes → higher variance
   in low/moderate-count genes after VST), not a distinct biological identity.
5. DESeq2's median-of-ratios size factor (0.2835, the lowest of the 12)
   already down-weights this sample's influence during dispersion and
   effect-size estimation, rather than requiring outright exclusion.

This is a **report-and-retain** decision, not a removal, under the stated
policy (`low_depth_policy = keep_inspect_report`). It was **not re-litigated in
this report** — no with/without sensitivity re-run of the DE model was
performed at any step, so **the 875-gene significant set is conditional on
`sample_01`'s inclusion** and its stability without that sample is unverified.

---

## 5. Enrichment: Hallmark, Reactome, WikiPathways

**Fields required by the plan, stated explicitly:**

| Field | Value |
|---|---|
| Ranking metric | **signed DESeq2 Wald `stat`** (not shrunken log2FC — reported explicitly because the choice materially affects which sets surface; `T2S1/output/decision_record.json`) |
| Universe | the full **9,402-gene** T1S2-tested set (identical for all 3 collections/passes; 0 duplicate IDs); genes DESeq2's independent filtering flagged NA were excluded from the universe |
| Size window | **15–500** members required among the ranked genes to enter fgsea |
| Method | fgsea multilevel preranked GSEA, BH-adjusted p, `fgsea::collapsePathways()` (pval.threshold=0.05) to reduce redundant sets to representative "main pathways" |
| Seed | 20260904 |
| Package versions | R 4.6.0; fgsea 1.38.0; ggplot2 4.0.3; jsonlite 2.0.0 |

**Gene-set database + version per collection:**

| Collection | Database file | Version | Sets staged | Sets entering size window | Significant (padj<0.05) | Main pathways after collapse |
|---|---|---|---|---|---|---|
| Hallmark | `h.all.v2026.1.Hs.symbols.gmt` | **MSigDB Hallmark human 2026.1** | 50 | 50 (100%) | 15 (13↑ / 2↓) | 8 |
| Reactome | `ReactomePathways.gmt` | **Reactome, "current" quarterly release** (no fixed version string upstream; the extracted `T2S1/output/refdata/ReactomePathways.gmt` is the durable record of exact content used) | 2,868 | 766 (26.7%) | 97 (90↑ / 7↓) | 22 |
| WikiPathways | `wikipathways_clean.gmt` | **WikiPathways human 2026.07.10** | 987 | 390 (39.5%) | 99 (92↑ / 7↓) | 34 |

Source: `T2S1/output/hallmark_summary.json`, `reactome_summary.json`,
`wikipathways_summary.json`, `decision_record_*.json`.

A second identifier space matters here: Hallmark and Reactome GMTs are
symbol-keyed, so the T1S6-mapped-symbol ranked list (`ranked_genes_symbol.csv`)
was used; the staged WikiPathways GMT was discovered to be **Entrez-ID-keyed**
despite its catalog metadata claiming symbols, so a second, Entrez-keyed ranked
list (`ranked_genes_entrez.csv`) was built and used for that pass instead
(`T2S1/output/decision_record_wikipathways.json`) — a documented correction,
not an assumption.

### 5.1 Top significant sets by collection

**Hallmark** (`T2S1/output/hallmark_collapsed.csv`):

| Pathway | NES | padj | Size (tested) | Nominal size | Coverage |
|---|---|---|---|---|---|
| HALLMARK_TNFA_SIGNALING_VIA_NFKB | **+2.99** | 2.56e-32 | 165 | 200 | 82.5% |
| HALLMARK_OXIDATIVE_PHOSPHORYLATION | **−3.05** | 2.60e-28 | 145 | 200 | 72.5% |
| HALLMARK_INTERFERON_GAMMA_RESPONSE | **+2.80** | 4.48e-25 | 167 | 200 | 83.5% |
| HALLMARK_INFLAMMATORY_RESPONSE | +2.12 | 2.71e-08 | 168 | 200 | 84.0% |
| HALLMARK_P53_PATHWAY | +1.82 | 8.47e-05 | 160 | 200 | 80.0% |
| HALLMARK_ADIPOGENESIS | −1.70 | 7.43e-04 | 164 | 200 | 82.0% |
| HALLMARK_KRAS_SIGNALING_UP | +1.54 | 0.0094 | 158 | 200 | 79.0% |
| HALLMARK_UNFOLDED_PROTEIN_RESPONSE | +1.54 | 0.0351 | 91 | 113 | 80.5% |

**Reactome** (`T2S1/output/significant_pathways_all_collections.csv`, top by padj):

| Pathway | NES | padj | Size (tested) / Nominal | Coverage |
|---|---|---|---|---|
| Cytokine Signaling in Immune system | +2.22 | 1.28e-14 | 379 / 852 | 44.5% |
| Aerobic respiration and respiratory electron transport | −2.59 | 1.35e-11 | 105 / 261 | 40.2% |
| Interleukin-1 family signaling | +2.33 | 3.22e-07 | 66 / 140 | 47.1% |
| Mitochondrial protein degradation | −2.39 | 5.17e-07 | 42 / 98 | 42.9% |

**WikiPathways** (`T2S1/output/significant_pathways_all_collections.csv`):

| Pathway | NES | padj |
|---|---|---|
| Electron transport chain OXPHOS system in mitochondria (WP111) | −2.82 | 3.36e-13 |
| Cancer pathways (WP5434) | +1.94 | 3.98e-07 |
| Cytosolic DNA sensing pathway (WP4655) | +2.32 | 2.92e-06 |

**Coverage caveat, quantified per set:** because 63.8% of tested genes are
synthetic placeholders, every *nominal* gene-set size overstates what was
actually testable. Coverage (tested-overlap / nominal size) is reported per
set in `output/enrichment_significant_sets.csv` (merged from
`T2S1/output/pathway_coverage_*.csv`) rather than assumed uniform. Hallmark
hits above retain 72.5–84.0% coverage; the Reactome and WikiPathways top hits
run substantially lower (e.g. 44.5% for Reactome's top hit) — **secondary-
collection hits, especially small or low-coverage ones, warrant more
skepticism than the Hallmark results.**

### 5.2 Leading-edge genes, per significant set

All 211 significant sets across the three collections (15 Hallmark + 97
Reactome + 99 WikiPathways), each with its own `leading_edge` gene list, are in
`output/enrichment_significant_sets.csv` — built directly from the per-set
`leading_edge` column that T2S1 attached to *every* tested pathway (not only
the 64 collapsed "main pathway" representatives), satisfying the
`leading_edge = per_significant_set` requirement at the set level rather than
only at the collapsed level. The collapsed non-redundant main-pathway leading
edges (used for the top-hit tables above) are in `hallmark_collapsed.csv`,
`reactome_collapsed.csv`, `wikipathways_collapsed.csv`.

Example — HALLMARK_TNFA_SIGNALING_VIA_NFKB leading edge (94 genes, all real
HGNC symbols): `IL15RA, BTG2, ICAM1, NFE2L2, PTGS2, TNFAIP6, NFAT5, DNAJB4,
TAP1, TRIP10, TNFSF9, SOD2, ... NFKB1, CCND1, FOSB, RELB, CCN1, BTG1, IL12B,
STAT5A, BCL2A1, PLAU` (full list in `output/enrichment_significant_sets.csv`).

### 5.3 Interpretation — framed as hypothesis, not conclusion

The pattern across all three collections is directionally consistent: genes in
**TNFα/NF-κB signaling, interferon-γ response, and broader
cytokine/interleukin signaling are coordinately up** in treated vs. control,
while genes in **oxidative phosphorylation / mitochondrial electron transport
and adipogenesis are coordinately down**. This up-inflammatory /
down-oxidative-metabolism pairing is a recognized physiological pattern in
activated immune cells, which shift away from oxidative phosphorylation as
part of metabolic reprogramming during activation (O'Neill & Pearce, *J Exp
Med* 2016, PMID 26694970 — general immunometabolism background, not a claim
about this specific dataset). It is also broadly consistent with the data
profile's own observation that the ~4,384 real gene symbols in this dataset
"skew toward lipid/fatty-acid metabolism and adipocyte biology," suggesting
this may be a **simulated/benchmark dataset engineered around a planted
metabolic/inflammatory signal** rather than data from a real experiment.

**This is stated as a hypothesis grounded only in the mappable gene subset,
not a biological conclusion.** Three unresolved facts prevent stronger framing:
(1) organism was never confirmed, so "TNFA_SIGNALING_VIA_NFKB" as a human
gene-set label may not even be the correct annotation universe; (2) only
36.2% of the tested genes could be mapped to any real identifier, so the
"significant" gene sets are inferred from well under half of the transcriptome
that was actually tested; (3) the dataset's own thematic skew (lipid/adipocyte
genes) combined with the OXPHOS/adipogenesis-down, inflammation-up pattern is
exactly the kind of engineered signal a benchmark generator would plant to
test DE+enrichment recovery — treat the enrichment result as evidence the
pipeline recovers a *coherent, non-random* signal, not as evidence of a real
biological mechanism.

---

## 6. Limitations (carried forward from T1S1/T1S2/T1S6/T2S1, restated in full)

1. **Organism was never stated in the inputs.** No organism/species column,
   README, or accession exists anywhere in the raw data
   (`data/inputs/local/counts.csv`, `metadata.csv`, `gene_lengths.csv`). All-caps
   HGNC-style gene symbols (e.g. `ABCA1`, `ADIPOQ`) are consistent with human
   nomenclature but do not prove species. **`org.Hs.eg.db` (human) and
   human-only Hallmark/Reactome/WikiPathways collections were used
   provisionally** because there was no alternative; every mapped gene identity
   and every enrichment result is conditional on this unverified assumption.
2. **63.47% of gene IDs are synthetic placeholders (`GENE00001`–`GENE07616`)
   with no real biological annotation in any organism database** — this is
   confirmed both by the data profile's independent count (~7,616) and by
   T1S6's `org.Hs.eg.db` mapping failing on exactly those IDs
   (`n_unmapped = 7616`, 63.47%). No choice of organism package, alias
   strategy, or identifier-space setting recovers annotation for these — they
   are placeholders by construction, not a mapping-tool limitation. This
   caps enrichment coverage structurally: only 36.19% of the 9,402 tested
   genes (3,403) could enter any gene-set analysis at all.
3. **Count source / quantifier is undocumented.** The analysis proceeded on
   the data profile's confirmation that `counts.csv` holds non-negative raw
   integers, not on a confirmed upstream pipeline (no STAR/salmon/kallisto
   log, no tximport metadata, no read-length or library-prep information).
   No transcript-length offset was applied (`length_offset: false` in the
   actual run, despite the template's own default recommending one) because
   no length-aware quantification (e.g. `tximport`) was confirmed as the
   source.
4. **The shallow sample (`sample_01`) was kept, not excluded**, and no
   with/without sensitivity re-analysis was performed at any step — the
   875-gene DE set and all downstream enrichment results are conditional on
   its inclusion (§4).
5. **Single ranking metric.** Only the Wald `stat` was used for GSEA; a
   `log2FoldChange`- or `signed_log10p`-ranked rerun was not performed, and
   which pathways surface is metric-dependent, per the plan's own
   disputed-methodology framing.
6. **Reactome's "current" release carries no fixed, citable version string**
   upstream (it is overwritten quarterly); the extracted
   `T2S1/output/refdata/ReactomePathways.gmt` file is the only durable,
   reproducible record of the exact 2,868-set content actually used.
7. **One-to-many gene-ID mappings were collapsed to a single "first" target**
   (274 cases, mostly Ensembl); the discarded alternative targets are
   preserved only in `T1S6/output/annotation_multi.csv`, not the primary
   mapping table used downstream.
8. **No gene-length bias was detected** (Spearman rho ≈ 0 for length vs.
   |shrunken log2FC| and vs. −log10(padj); Mann-Whitney p = 0.98 for
   significant vs. non-significant gene length), so length is not a
   confound in the DE results — reported for completeness, not because it
   changed any conclusion.

**Bottom line on scope:** treat every gene-level and pathway-level finding in
this report as conditional on (a) the human-organism assumption and (b) the
36% real-identifier subset of the tested transcriptome. Do not read the
enrichment section as evidence of a specific biological mechanism in a real
organism — read it as a statistically coherent, internally consistent signal
recovered from the fraction of the data that could be annotated, most
plausibly reflecting a synthetic/benchmark dataset with a planted signal.

---

## 7. Reproducibility record

Full machine-readable record: `output/reproducibility_record.json`. Summary:

| Component | Detail |
|---|---|
| R version | 4.6.0 (2026-04-24), aarch64-unknown-linux-gnu, Ubuntu 24.04.4 LTS (identical across T1S1/T1S2/T1S6/T2S1) |
| DE packages | DESeq2 1.52.0, apeglm 1.34.0, ashr 2.2-63, ggplot2 4.0.3, pheatmap 1.0.13, jsonlite 2.0.0 |
| Annotation packages | AnnotationDbi 1.74.0, org.Hs.eg.db 3.23.1 (Entrez source 2026-Mar18, Ensembl source 2025-Sep03) |
| Enrichment packages | fgsea 1.38.0, ggplot2 4.0.3, jsonlite 2.0.0 |
| Gene-set collection versions | Hallmark **2026.1** (`h.all.v2026.1.Hs.symbols.gmt`); Reactome **"current" quarterly release**, exact content frozen in `T2S1/output/refdata/ReactomePathways.gmt`; WikiPathways **2026.07.10** (`wikipathways_clean.gmt`, Entrez-keyed) |
| Random seed | 20260904 (fgsea, all 3 collections) |
| Templates / decision records | `tpl-deseq2-two-group@1.1.0` (T1S2), `tpl-annotation-map@1.0.0` (T1S6), `tpl-fgsea-preranked@1.0.0` ×3 (T2S1) — full slot provenance in each step's `decision_record*.json` |
| Full sessionInfo() | `T1S1/output/session_info.txt`, `T1S2/output/session_info.txt`, `T1S6/output/session_info.txt`, `T2S1/output/session_info.txt` (all read verbatim into this report; not reproduced here in full to avoid duplication) |
| Snapshot digest | `sha256:40605ae40583456c222ca9f595c1a4c8c995b7a124a1f35c57cb03911412e5e8` (identical across all four upstream steps and this report) |

---

## 8. Artifact index

| File | Content |
|---|---|
| `output/gene_table_full.csv` | 9,782 genes, ranked by shrunken log2FC, unshrunken/shrunken/lfcSE + annotation status |
| `output/gene_table_significant.csv` | 875 significant genes (padj<0.05), same columns |
| `output/enrichment_significant_sets.csv` | 211 significant gene sets (all 3 collections), NES/padj/leading-edge/coverage per set |
| `output/reproducibility_record.json` | Machine-readable consolidated versions/seed/design/thresholds |
| `output/report_derived_stats.json` | Cross-check counts (matches upstream JSONs exactly) |
| `figures/de_ma_plot.{png,pdf}` | MA plot (§3.1) |
| `figures/de_dispersion_plot.{png,pdf}` | Dispersion plot (§3.2) |
| `figures/de_pvalue_histogram.{png,pdf}` | p-value histogram (§3.3) |
| `figures/de_pca.{png,pdf}`, `qc_pca.png` | PCA (condition separation, shallow-sample position) |
| `figures/qc_library_sizes.png`, `qc_sample_distances.png` | Shallow-sample QC (§4) |
| `figures/de_volcano.{png,pdf}` | Volcano plot (log2FC vs −log10 padj) |
| `figures/annotation_mapping_status.png`, `annotation_input_patterns.png` | Gene-ID mapping coverage (§6.2) |
| `figures/hallmark_dot_plot.png`, `hallmark_nes_bar_plot.png` | Hallmark results |
| `figures/reactome_dot_plot.png`, `reactome_nes_bar_plot.png` | Reactome results |
| `figures/wikipathways_dot_plot.png`, `wikipathways_nes_bar_plot.png` | WikiPathways results |
| `figures/enrichment_network.png` | Cross-collection enrichment network |
| `scripts/build_combined_report.py` | Script that produced every derived file in this report from upstream artifacts |
