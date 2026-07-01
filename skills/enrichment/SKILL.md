---
name: enrichment
description: Functional enrichment and pathway analysis including GSEA, ORA, ssGSEA, GSVA, and decoupler-based activity inference
version: 1.0.0
tags: [enrichment, gsea, ora, pathway, go, functional-annotation, gseapy, decoupler]
---

# Enrichment & Functional Annotation

This skill guides method selection and execution for gene set enrichment, over-representation analysis, per-sample pathway scoring, and transcription factor activity inference.

## Method Selection Decision Tree

Choose the method based on your input data and analytical goal:

1. **Input is a ranked gene list (with scores, fold-changes, or test statistics)**
   - Use **GSEA** via `gseapy.prerank()` (Python) or `fgsea::fgsea()` (R via rpy2).
   - Rank by signed statistic (e.g., `sign(log2FC) * -log10(pvalue)`), not by p-value alone.

2. **Input is an unranked gene list (e.g., DE genes at FDR < 0.05)**
   - Use **ORA** via `gseapy.enrich()` (Python) or `clusterProfiler::enrichGO()` / `enrichKEGG()` (R via rpy2).
   - ALWAYS supply the background gene set (all expressed/detected genes).

3. **Need per-sample pathway activity scores**
   - Use **ssGSEA** via `gseapy.ssgsea()` for MSigDB-style gene sets.
   - Use **GSVA** via `gsva()` (R via rpy2) when downstream analysis expects continuous scores per pathway per sample.

4. **Pathway activity on AnnData (single-cell or bulk)**
   - Use **decoupler** `run_ulm()` or `run_mlm()` with **PROGENy** model.
   - Results integrate directly into `adata.obsm` for downstream plotting and clustering.

5. **Transcription factor activity inference**
   - Use **decoupler** with **CollecTRI** regulon resource (NOT enrichment databases).
   - This is TF activity, not pathway enrichment -- use the correct framing.

## Gene Set Database Selection

| Database | When to Use |
|-|-|
| MSigDB Hallmark (H) | First pass, curated, low redundancy (50 gene sets) |
| MSigDB C2:CP | Canonical pathways (KEGG, Reactome, BioCarta, PID) |
| MSigDB C5:GO | Gene Ontology (BP, CC, MF) -- high redundancy, use with collapse |
| KEGG (via gseapy or clusterProfiler) | Metabolic and signaling pathways with topology |
| Reactome | Detailed pathway hierarchy, good for mechanistic interpretation |

## Redundancy Reduction

After enrichment, collapse redundant terms to improve interpretability:

- **rrvgo** (R via rpy2): Semantic similarity-based GO term reduction. Produces treemaps.
- **fgsea::collapsePathways()**: Greedy filtering of overlapping gene sets based on enrichment significance.
- **Manual**: cluster by Jaccard similarity on leading-edge genes, pick representative per cluster.

## Multiple Testing and Thresholds

- Apply **Benjamini-Hochberg FDR correction** to all enrichment p-values.
- Standard threshold: FDR < 0.05. Report both nominal p-value and adjusted p-value.
- For GSEA: report NES (normalized enrichment score), FDR q-value, and leading-edge gene count.
- For ORA: report fold enrichment, p-value, adjusted p-value, and overlap gene list.
- Gene set size filters: **minimum 15**, **maximum 500** genes. Enforce before running.

## Output Conventions

- Save enrichment results as TSV/CSV with columns: term, source, size, overlap/NES, p-value, FDR, genes.
- Generate a dotplot (top 20 terms, x = gene ratio or NES, size = gene count, color = FDR).
- Generate a barplot of top terms ordered by significance.
- For GSEA: include enrichment score plots for top pathways.
- Write a summary narrative describing top findings, grouped by biological theme.

## Anti-Patterns

- **ORA without proper background**: Defaults to whole genome, inflating significance. ALWAYS set `background=` to all expressed/detected genes.
- **GSEA on an unranked list**: GSEA requires a continuous ranking. If you only have a gene list, use ORA.
- **Ignoring gene set size limits**: Very small sets (<15) are noisy; very large sets (>500) are uninformative. Filter before running.
- **Gene ID mismatch**: Verify gene identifiers match the database organism and ID type (symbol vs. Ensembl vs. Entrez). Convert with `gseapy.parser` or `pymart` before enrichment.
- **Not reporting database version**: Always log which MSigDB version, GO release, or KEGG snapshot was used.
- **Treating enrichment as validation**: Enrichment finds statistical associations, not causal mechanisms. Frame results as "consistent with" not "proves".
- **Running ORA on the full DE list without a threshold**: ORA requires a discrete gene list. Apply a significance cutoff first.
- **Ignoring direction**: Separate up- and down-regulated genes for ORA, or use a signed ranking for GSEA.

## Additional Available Packages

- **singscore** (R via rpy2): Rank-based single-sample gene set scoring. Alternative to ssGSEA, stable for small gene sets.
- **msigdbr** (R via rpy2): Retrieve MSigDB gene sets with species conversion. Requires network access — in sandbox, use **pre-staged MSigDB GMT/Parquet files** from `list-available-refs` instead (hallmark, canonical_pathways, GO, oncogenic, immunologic, cell type collections are pre-staged for human and mouse).
- **upsetplot** (Python) / **UpSetR** (R): UpSet plots for visualizing overlap between enriched term sets across comparisons.

## References

| File | Purpose |
|-|-|
| `references/gseapy-api.md` | gseapy API: prerank, enrich, ssgsea |
| `references/decoupler-enrichment-api.md` | decoupler run_ulm, run_mlm with PROGENy |
| `references/fgsea-rpy2-api.md` | fgsea via rpy2: GSEA and pathway collapse |
| `references/clusterprofiler-rpy2-api.md` | clusterProfiler via rpy2: enrichGO, enrichKEGG |
| `references/gsva-rpy2-api.md` | GSVA via rpy2: per-sample gene set variation |
