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
   - Use **ORA** via `gseapy.enrich()` (Python) or `clusterProfiler::enrichGO()` (R via rpy2). Do NOT use `enrichKEGG()` — KEGG is not staged and the call needs network access it will not get.
   - Pass gene sets as a file resolved from the reference data available to you, never as an Enrichr library name string — those trigger HTTP requests and fail.
   - ALWAYS supply the background gene set (all expressed/detected genes).

3. **Need per-sample pathway activity scores**
   - Use **ssGSEA** via `gseapy.ssgsea()` for MSigDB-style gene sets.
   - Use **GSVA** via `gsva()` (R via rpy2) when downstream analysis expects continuous scores per pathway per sample.

4. **Pathway activity on AnnData (single-cell or bulk)**
   - Use **decoupler** `dc.mt.ulm()` or `dc.mt.mlm()` with the **PROGENy** model.
   - Results integrate directly into `adata.obsm` (`score_ulm` / `padj_ulm`) for downstream plotting and clustering.

5. **Transcription factor activity inference**
   - Use **decoupler** with **CollecTRI** regulon resource (NOT enrichment databases).
   - This is TF activity, not pathway enrichment -- use the correct framing.

## Gene Set Database Selection

Ask for a database by name and resolve it from the reference data available to
you — never assume a path, a filename, or a format. What is provisioned varies
per environment, so confirm what you have before committing to a method.

| Database | When to Use | Availability |
|-|-|-|
| MSigDB Hallmark (H) | First pass, curated, low redundancy (50 gene sets) | The reliable default — human and mouse |
| Reactome | Detailed pathway hierarchy, good for mechanistic interpretation | Normally available |
| WikiPathways | Community-curated pathways, per species | Normally available |
| MSigDB C5:GO | Gene Ontology — the mechanism-level step down from hallmark, when "which process" needs a real answer | In the inventory, human and mouse, split into BP / CC / MF |
| MSigDB C6 oncogenic | Which oncogene or tumour-suppressor perturbation a tumour profile resembles | In the inventory, human only — upstream publishes no mouse counterpart |
| MSigDB C7 immunologic | Immune cell state, stimulation and activation contrasts | In the inventory, human and mouse |
| KEGG | Metabolic and signaling pathways with topology | **Not available.** License forbids redistribution, so KEGG is not staged; `enrichKEGG()`, `gseKEGG()`, KEGGREST, and Enrichr's KEGG libraries all need network access and will fail. Use Reactome or WikiPathways instead. |

Start with hallmark unless the question demands finer granularity. Everything
above other than KEGG is resolvable from the reference inventory, but like every
reference dataset it is provisioned per environment — resolve what you need
before committing to a method, and if it is absent say so rather than silently
substituting a different database.

GO sets are nested, so a parent and its children share most of their members and
surface together as a block of correlated hits. Collapse them before reporting a
count, and pick one branch deliberately: testing BP, CC and MF together triples
the multiple-testing burden when the question usually names one of them.

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
- **Gene ID mismatch**: Verify gene identifiers match the database organism and ID type (symbol vs. Ensembl vs. Entrez). Map offline before enrichment: use the ID-mapping tables in the reference data available to you (NCBI gene info, UniProt ID mapping), or `org.Hs.eg.db` via rpy2 for human. `biomaRt` cannot be used — it queries Ensembl over the network.
- **Not reporting database version**: Always log which gene set database and release you used, as reported by the reference inventory for the file you resolved.
- **Treating enrichment as validation**: Enrichment finds statistical associations, not causal mechanisms. Frame results as "consistent with" not "proves".
- **Running ORA on the full DE list without a threshold**: ORA requires a discrete gene list. Apply a significance cutoff first.
- **Ignoring direction**: Separate up- and down-regulated genes for ORA, or use a signed ranking for GSEA.

## Additional Available Packages

- **singscore** (R via rpy2): Rank-based single-sample gene set scoring. Alternative to ssGSEA, stable for small gene sets.
- **msigdbr** (R via rpy2): Retrieve MSigDB gene sets with species conversion. Queries an online database, so it fails without network access — resolve an MSigDB gene set file from the reference data available to you instead, and read it with the reader its reported format calls for.
- **upsetplot** (Python) / **UpSetR** (R): UpSet plots for visualizing overlap between enriched term sets across comparisons.

## References

| File | Purpose |
|-|-|
| `references/gseapy-api.md` | gseapy API: prerank, enrich, ssgsea |
| `references/decoupler-enrichment-api.md` | decoupler `dc.mt.ulm`, `dc.mt.mlm` with PROGENy |
| `references/fgsea-rpy2-api.md` | fgsea via rpy2: GSEA and pathway collapse |
| `references/clusterprofiler-rpy2-api.md` | clusterProfiler via rpy2: enrichGO, gseGO (KEGG entry points fail — no network) |
| `references/gsva-rpy2-api.md` | GSVA via rpy2: per-sample gene set variation |
