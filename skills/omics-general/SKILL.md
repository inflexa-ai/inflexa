---
name: omics-general
description: Read before your first step on omics data. It gives the rules for all omics steps (language and container defaults, how to find and read reference data, what to do when a dataset is absent, gene identifier conversion without network access, output standards).
metadata:
  version: 2.0.0
  tags: [omics, bioinformatics, general-principles, anndata, mudata, python-first]
---

# Omics General Principles

Cross-cutting guidance loaded by ALL sandbox agents.

## Language Policy

**Python is the default language.** Use R when:
- No Python equivalent exists (e.g., minfi, ANCOM-BC2, ChAMP)
- The R implementation is significantly more mature (e.g., DESeq2 for complex contrasts)

**Choose native R or rpy2 based on scope:**
- **Isolated R calls** in a Python pipeline → use rpy2 bridge
- **R-dominant pipeline** (most steps are R packages) → write native R scripts

## AnnData/MuData: Universal Data Containers

**AnnData (.h5ad)** is the universal container for ALL sample-by-feature data — not just single-cell:

| Modality | .obs (samples) | .var (features) | .X (values) |
|----------|---------------|-----------------|-------------|
| Bulk RNA-seq | samples, condition, batch | genes, ensembl_id, biotype | raw counts |
| Proteomics | samples, condition, batch | proteins, uniprot_id | intensities |
| Metabolomics | samples, condition, batch | metabolite features, mz, rt | abundances |
| Microarray | samples, condition, batch | probes/genes | normalized expression |
| Single-cell | cells, cell_type, condition | genes | counts or normalized |
| Methylation (results) | samples, condition, age | CpG sites, chr, pos | beta or M-values |

**MuData (.h5mu)** for multi-modal data: CITE-seq (RNA+protein), Multiome (RNA+ATAC), multi-omics integration.

### AnnData Conventions
- Sample metadata → `.obs` columns (never separate CSV files)
- Feature annotations → `.var` columns
- Dimensionality reductions → `.obsm` (e.g., `X_pca`, `X_umap`)
- Processed layers → `.layers` (e.g., `raw`, `normalized`, `log1p`)
- Unstructured results → `.uns` (DE results, method parameters)
- Save as `.h5ad` / `.h5mu` — never `.rds` or `.pkl`

### Converting from R Objects
When R produces objects (DESeqDataSet, phyloseq, SummarizedExperiment), extract the data matrix, the sample metadata, and the feature metadata through rpy2. Then make the AnnData in Python, and save it as `.h5ad` for the steps that come after.

## Output Format Standards

- **Intermediate data**: `.h5ad` or `.h5mu` (universal, travels with metadata)
- **Tabular results**: CSV with descriptive column names (`log2_fold_change`, `adjusted_pvalue`)
- **Figures**: PNG (300 DPI) + PDF (vector) with same base filename
- **Dual-format output**: Save both native format AND generic CSV for cross-cutting agents

## Regulons

The TF activity methods use a TF-target regulon network from the reference store. No tool here discovers a regulon from the data alone. If the step asks for one, say so.

See `references/general-principles.md` for complete details.

## Reference Data

Gene sets, regulons, pathway weights, and annotation resources are provisioned
as an optional reference store. **Never assume a particular dataset is present
and never hardcode a path to one.** Query the available references for what you
need, described by what the data *is* (e.g. "TF-target regulon network",
"hallmark gene sets"), and read the returned entry's stated format and column
layout before choosing a reader. Rules that hold regardless of which datasets
are installed:

- The store is **read-only**, and the sandbox has **no network access** — a
  missing dataset cannot be downloaded or installed at runtime.
- If what you need is not there, report the gap and proceed with what is
  available. Do not invent a path, and do not silently fall back to a
  different organism's data.
- Match the reader to the declared format, not to the file extension:
  - `.gmt` gene sets are **ragged** (variable-length rows) — parse them
    line-by-line, splitting on tabs. `pandas.read_csv` cannot read a GMT.
  - `.rda` / `.rds` are R serialized objects — load them through rpy2 (or in
    native R), never with a pandas reader.
  - `.csv` / `.tsv` tables load with pandas; check whether the file has a
    header, and whether it is gzipped or zipped, before reading.
  - Multi-species files must be filtered to the organism under analysis
    before use — a human network silently runs over mouse counts.

## Gene Annotation (R via rpy2)

When you need gene ID conversion, annotation, or organism databases:
- **AnnotationDbi** + **org.Hs.eg.db** / **org.Mm.eg.db** / **org.Rn.eg.db** / **org.Dr.eg.db** / **org.Cf.eg.db** / **org.Bt.eg.db**: Map between gene symbols, Entrez IDs, Ensembl IDs, UniProt IDs. Use `mapIds()` or `select()`.
- **ensembldb** + **EnsDb.Hsapiens.v86** / **EnsDb.Mmusculus.v79**: Gene models with coordinates, transcripts, exons. Use `genes()`, `transcripts()`.
- **babelgene**: Cross-species gene name conversion (human ↔ mouse ↔ rat). Use `orthologs()`.
- **biomaRt** cannot be used — every function queries Ensembl over the network. It is present only because other packages depend on it.

## R ↔ Python Format Conversion

- **zellkonverter** (R via rpy2): Convert between AnnData (.h5ad) and SingleCellExperiment (.rds). Use `readH5AD()` / `writeH5AD()` in R when an R package requires SCE input.
- **SeuratDisk** (R via rpy2): The Seurat-native route for the same crossing — `Convert()` between `.h5ad` and `.h5seurat`, then `LoadH5Seurat()`. Reach for it when the R side needs a Seurat object specifically (Azimuth, ProjecTILs, scGate) rather than an SCE.

## Visualization Packages

The package store holds these plotting packages:

- **Python**: matplotlib, seaborn, plotly (static export through `kaleido` and `write_image`), matplotlib-venn, adjustText, and rnanorm (count normalization).
- **R (via rpy2)**: ggplot2, ggrepel, pheatmap, ComplexHeatmap, EnhancedVolcano, corrplot, patchwork, cowplot, plotly, and ComplexUpset.
