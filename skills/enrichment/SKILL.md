---
name: enrichment
description: Read before you do gene set enrichment, over-representation, per-sample pathway scores, or TF activity scores. It gives the method for a ranked list, an unranked list, or genes of CpG sites, which gene set collections are available, the background and identifier traps, and how to report redundant GO terms.
metadata:
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

6. **Input is CpG sites or methylated regions mapped to genes**
   - A gene with more tested CpGs gets more hits by chance, thus a plain ORA finds the long, CpG-rich genes.
   - Correct for the number of tested CpGs of each gene. For an array with its annotation, use `missMethyl::gometh()` or `gsameth()`.
   - For other data, use a weighted null: a logistic model of hit status with the CpG count as a covariate, or random gene sets drawn with a probability that follows the CpG count.
   - Count the CpGs over all the tested sites, not only the hits. The `dna-methylation` skill has the rest of the method.

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

After enrichment, collapse redundant terms with **rrvgo** (R via rpy2, GO semantic similarity), with `fgsea::collapsePathways()`, or by Jaccard similarity on the leading-edge genes.

## Reporting Constraints

- Filter the gene sets to a size of 15 to 500 genes before the test.
- Report the nominal p-value and the Benjamini-Hochberg FDR.
- For GSEA, report the NES, the FDR q-value, and the number of leading-edge genes.
- For ORA, report the fold enrichment, the p-value, the adjusted p-value, and the overlap genes.
- Write the results as TSV or CSV with the columns term, source, size, overlap/NES, p-value, FDR, and genes.

## Anti-Patterns

- **An Enrichr library name in place of a gene set file**: A name such as `"MSigDB_Hallmark_2020"` makes an HTTP request, and the sandbox has no network. Pass the gene sets of a file that you resolved from the reference data.
- **`organism=` in `gp.enrich()`**: Only the web-only `gp.enrichr()` takes that argument. `gp.enrich()` raises `TypeError`. Select the organism through the gene set file that you resolve.
- **KEGG entry points**: KEGG is not staged. `enrichKEGG()`, `gseKEGG()`, and KEGGREST use the network and fail. Use Reactome or WikiPathways.
- **Gene ID mismatch**: Make sure that the identifiers match the organism and the ID type of the gene sets. Map offline with the ID-mapping tables in the reference data (NCBI gene info, UniProt ID mapping), or with `org.Hs.eg.db` through rpy2. `biomaRt` cannot be used, because it queries Ensembl over the network.
- **No database release in the report**: Write the gene set database and the release that the reference inventory gives for the file that you resolved.
- **ORA without a background**: The default background is the whole genome, and it inflates the significance. Always set `background=` to all expressed or detected genes.
- **Ignoring direction**: Separate up- and down-regulated genes for ORA, or use a signed ranking for GSEA.
- **GSEA on an unranked list**: GSEA needs a continuous ranking. If you have only a gene list, use ORA.
- **ORA on the full DE list without a threshold**: ORA takes a discrete gene list. Apply a significance cutoff first.
- **Ignoring gene set size limits**: Sets with < 15 genes are noisy, and sets with > 500 genes give no information. Filter before the test.
- **Enrichment as validation**: Enrichment finds statistical associations, not causal mechanisms. Write "consistent with", not "proves".

## Additional Available Packages

- **singscore** (R via rpy2): Rank-based single-sample gene set scoring. Alternative to ssGSEA, stable for small gene sets.
- **babelgene** (R via rpy2): Ortholog mapping. MSigDB is catalogued as human and mouse gene sets, so this is how a collection reaches any other species.

## References

| File | Purpose |
|-|-|
| `references/gseapy-api.md` | gseapy API: prerank, enrich, ssgsea |
| `references/decoupler-enrichment-api.md` | decoupler `dc.mt.ulm`, `dc.mt.mlm` with PROGENy |
| `references/fgsea-rpy2-api.md` | fgsea via rpy2: GSEA and pathway collapse |
| `references/clusterprofiler-rpy2-api.md` | clusterProfiler via rpy2: enrichGO, gseGO (KEGG entry points fail — no network) |
| `references/gsva-rpy2-api.md` | GSVA via rpy2: per-sample gene set variation |
